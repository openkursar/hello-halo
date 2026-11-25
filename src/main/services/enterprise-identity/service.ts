/**
 * Enterprise identity session: the sign-in flow, the session's lifetime and
 * the short-lived tool credentials derived from it. See DESIGN.md.
 */

import { promises as fsp, rmSync } from 'fs'
import { join } from 'path'
import type {
  EnterpriseIdentityProvider,
  EnterpriseLoginStart,
  EnterpriseSession,
} from '../../../shared/interfaces/enterprise-identity-provider'
import type {
  EnterpriseIdentityAccount,
  EnterpriseIdentityMethod,
  EnterpriseIdentityState,
  EnterpriseLoginOutcome,
  EnterpriseLoginPollResult,
} from '../../../shared/types/enterprise-identity'

/** A tool the build binds to this identity (from product.json). */
export interface EnterpriseToolBindingConfig {
  toolId: string
  capability: string
  audience: string
  env: string
  staticEnv?: Record<string, string>
}

/** What the CLI tool store needs to hand a bound tool its credential. */
export interface ToolCredentialBinding {
  toolId: string
  env: string
  file: string
  staticEnv?: Record<string, string>
}

export interface EnterpriseIdentityServiceOptions {
  bindings: EnterpriseToolBindingConfig[]
  /** Directory this service owns; holds one file per audience while signed in. */
  credentialDir: string
  /** Loads the build's provider; null when it cannot be loaded. */
  loadProvider: () => Promise<EnterpriseIdentityProvider | null>
  /** Finishes before the first credential is written (removal of leftovers). */
  ready?: Promise<void>
  /**
   * Remembers, without any credential, the method and account of a sign-in
   * the user has not ended, so the next launch can resume it.
   */
  sessionMarkerFile?: string
  /** Wait before another restore after the service could not be reached. */
  restoreRetryMs?: number
  /** Longest a state read waits for a restore under way. */
  restoreWaitMs?: number
  now?: () => number
  /** Pause between two provider checks of a pending sign-in. */
  pollIntervalMs?: number
  /** Longest a single poll request waits before answering "still pending". */
  pollWaitMs?: number
  /** A credential is renewed this long before it ends. */
  refreshMarginMs?: number
  log?: Pick<Console, 'log' | 'error'>
}

const AUDIENCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
/** setTimeout fires at once beyond this; longer waits are re-armed in steps. */
const MAX_TIMER_MS = 2 ** 31 - 1

/** Bindings with a usable audience; others are dropped (the caller logs). */
export function usableBindings(bindings: EnterpriseToolBindingConfig[] | undefined): EnterpriseToolBindingConfig[] {
  return (bindings ?? []).filter(b =>
    b && typeof b.toolId === 'string' && b.toolId !== '' &&
    typeof b.capability === 'string' && b.capability !== '' &&
    typeof b.audience === 'string' && AUDIENCE.test(b.audience) &&
    typeof b.env === 'string' && b.env !== '')
}

export function credentialFileOf(credentialDir: string, audience: string): string {
  return join(credentialDir, `${audience}.json`)
}

/** Bindings as the CLI tool store takes them; independent of sign-in state. */
export function toolCredentialBindings(
  bindings: EnterpriseToolBindingConfig[] | undefined,
  credentialDir: string,
): ToolCredentialBinding[] {
  return usableBindings(bindings).map(b => ({
    toolId: b.toolId,
    env: b.env,
    file: credentialFileOf(credentialDir, b.audience),
    ...(b.staticEnv ? { staticEnv: b.staticEnv } : {}),
  }))
}

interface ActiveSession extends EnterpriseSession {
  methodId: string
}

interface SessionMarker {
  methodId: string
  account: EnterpriseIdentityAccount
}

interface ActiveFlow extends EnterpriseLoginStart {
  methodId: string
  phase: 'waiting' | 'scanned'
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

function isMethodKind(value: unknown): value is EnterpriseIdentityMethod['kind'] {
  return value === 'qr' || value === 'browser'
}

function isWebUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** What a started attempt shows the user, or null when the provider's answer is unusable for the method. */
function loginPrompt(kind: EnterpriseIdentityMethod['kind'], start: EnterpriseLoginStart): { qrContent: string } | { url?: string } | null {
  if (kind === 'qr') return isString(start.qrContent) ? { qrContent: start.qrContent } : null
  if (start.url === undefined) return {}
  return isString(start.url) && isWebUrl(start.url) ? { url: start.url } : null
}

export class EnterpriseIdentityService {
  private readonly bindings: EnterpriseToolBindingConfig[]
  private readonly credentialDir: string
  private readonly loadProvider: () => Promise<EnterpriseIdentityProvider | null>
  private readonly ready: Promise<void>
  private readonly sessionMarkerFile: string | null
  private readonly restoreRetryMs: number
  private readonly restoreWaitMs: number
  private readonly now: () => number
  private readonly pollIntervalMs: number
  private readonly pollWaitMs: number
  private readonly refreshMarginMs: number
  private readonly log: Pick<Console, 'log' | 'error'>

  private providerLoad: Promise<EnterpriseIdentityProvider | null> | null = null
  private provider: EnterpriseIdentityProvider | null = null
  private session: ActiveSession | null = null
  /** Account of a session that ran out, shown until the next sign-in or sign-out. */
  private endedAccount: { account: EnterpriseIdentityAccount; methodId: string } | null = null
  private flow: ActiveFlow | null = null
  private confirmedFlowId: string | null = null
  private lastError: EnterpriseIdentityState['lastError']
  /** Audiences with a credential file now. */
  private readonly active = new Set<string>()
  private sessionTimer: ReturnType<typeof setTimeout> | null = null
  private readonly refreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Bumped whenever the session changes, so a late credential is never written for an old one. */
  private generation = 0
  private restoring: Promise<void> | null = null
  /** Epoch ms after which a state read retries a restore that could not reach the service; 0 = none due. */
  private restoreRetryAt = 0

  constructor(options: EnterpriseIdentityServiceOptions) {
    this.bindings = usableBindings(options.bindings)
    this.credentialDir = options.credentialDir
    this.loadProvider = options.loadProvider
    this.ready = options.ready ?? Promise.resolve()
    this.sessionMarkerFile = options.sessionMarkerFile ?? null
    this.restoreRetryMs = options.restoreRetryMs ?? 5 * 60_000
    this.restoreWaitMs = options.restoreWaitMs ?? 3000
    this.now = options.now ?? Date.now
    this.pollIntervalMs = options.pollIntervalMs ?? 1500
    this.pollWaitMs = options.pollWaitMs ?? 25_000
    this.refreshMarginMs = options.refreshMarginMs ?? 60_000
    this.log = options.log ?? console
  }

  private async getProvider(): Promise<EnterpriseIdentityProvider | null> {
    this.providerLoad ??= this.loadProvider().catch(err => {
      this.log.error('[EnterpriseIdentity] Provider could not be loaded', { message: err instanceof Error ? err.message : String(err) })
      return null
    })
    this.provider = await this.providerLoad
    return this.provider
  }

  private methods(): EnterpriseIdentityMethod[] {
    try {
      return (this.provider?.methods() ?? []).filter(m => isString(m?.id) && isString(m?.label) && isMethodKind(m.kind))
        .map(m => ({ id: m.id, label: m.label, kind: m.kind, capabilities: (m.capabilities ?? []).filter(isString) }))
    } catch {
      return []
    }
  }

  private snapshot(): EnterpriseIdentityState {
    if (this.session && this.now() >= this.session.expiresAt) this.endSession()
    const base = { methods: this.methods(), lastError: this.lastError }
    const capabilities = this.session?.capabilities ?? []
    const boundTools = this.bindings.map(b => ({
      toolId: b.toolId,
      capability: b.capability,
      active: this.session !== null && capabilities.includes(b.capability) && this.active.has(b.audience),
    }))
    const flow = this.flow
      ? {
          flowId: this.flow.flowId,
          methodId: this.flow.methodId,
          ...(this.flow.qrContent ? { qrContent: this.flow.qrContent } : {}),
          ...(this.flow.url ? { url: this.flow.url } : {}),
          phase: this.flow.phase,
          expiresAt: this.flow.expiresAt,
          ...(this.flow.hint ? { hint: this.flow.hint } : {}),
        }
      : undefined
    if (!this.provider) return { status: 'unavailable', methods: [], capabilities: [], boundTools: [] }
    if (this.session) {
      return {
        ...base,
        status: 'ready',
        account: { id: this.session.accountId, displayName: this.session.displayName },
        methodId: this.session.methodId,
        capabilities,
        expiresAt: this.session.expiresAt,
        boundTools,
        ...(flow ? { flow } : {}),
      }
    }
    if (flow) return { ...base, status: 'pending', capabilities: [], boundTools, flow, ...(this.endedAccount ? { account: this.endedAccount.account } : {}) }
    if (this.endedAccount) {
      return { ...base, status: 'expired', account: this.endedAccount.account, methodId: this.endedAccount.methodId, capabilities: [], boundTools }
    }
    return { ...base, status: 'signed-out', capabilities: [], boundTools }
  }

  async getState(): Promise<EnterpriseIdentityState> {
    await this.getProvider()
    if (!this.restoring && this.restoreRetryAt !== 0 && this.now() >= this.restoreRetryAt && !this.session && !this.flow) {
      void this.restoreSession()
    }
    if (this.restoring) await this.waitAtMost(this.restoring, this.restoreWaitMs)
    return this.snapshot()
  }

  /**
   * Resumes the last sign-in the user did not end, from authorization the
   * provider still holds. Never asks the user; one attempt at a time.
   */
  restoreSession(): Promise<void> {
    this.restoring ??= this.runRestore().finally(() => { this.restoring = null })
    return this.restoring
  }

  async beginLogin(methodId: string): Promise<EnterpriseIdentityState> {
    const provider = await this.getProvider()
    if (!provider) throw new Error('Enterprise identity is not available in this build')
    if (this.restoring) await this.restoring
    const method = this.methods().find(m => m.id === methodId)
    if (!method) throw new Error('Unknown sign-in method')
    if (this.flow) await this.cancelLogin(this.flow.flowId)
    const start = await provider.beginLogin(methodId)
    const prompt = start && isString(start.flowId) && typeof start.expiresAt === 'number' && start.expiresAt > this.now()
      ? loginPrompt(method.kind, start)
      : null
    if (!prompt) {
      throw new Error(method.kind === 'qr' ? 'The sign-in service returned an unusable QR code' : 'The sign-in service returned an unusable sign-in page')
    }
    this.flow = { flowId: start.flowId, ...prompt, expiresAt: start.expiresAt, methodId, phase: 'waiting', ...(start.hint ? { hint: start.hint } : {}) }
    this.lastError = undefined
    this.log.log('[EnterpriseIdentity] Sign-in started', { method: methodId })
    return this.snapshot()
  }

  /**
   * Waits a bounded time for the attempt to move on. Answers at once when the
   * phone reads the code, so the screen can say "confirm on your phone".
   */
  async pollLogin(flowId: string): Promise<EnterpriseLoginPollResult> {
    const provider = await this.getProvider()
    const deadline = this.now() + this.pollWaitMs
    const result = (outcome: EnterpriseLoginOutcome, message?: string): EnterpriseLoginPollResult =>
      ({ outcome, state: this.snapshot(), ...(message ? { message } : {}) })
    for (;;) {
      if (this.confirmedFlowId === flowId && this.session) return result('ready')
      const flow = this.flow
      if (!provider || !flow || flow.flowId !== flowId) return result('cancelled')
      if (this.now() >= flow.expiresAt) {
        this.flow = null
        void provider.cancelLogin(flowId).catch(() => undefined)
        return result('expired')
      }
      let answer
      try {
        answer = await provider.pollLogin(flowId)
      } catch (err) {
        if (this.flow?.flowId !== flowId) return result('cancelled')
        this.flow = null
        this.log.error('[EnterpriseIdentity] Sign-in check failed', { message: err instanceof Error ? err.message : String(err) })
        return result('failed', 'The sign-in service could not be reached')
      }
      if (this.flow?.flowId !== flowId) {
        return this.confirmedFlowId === flowId && this.session ? result('ready') : result('cancelled')
      }
      switch (answer?.status) {
        case 'confirmed': {
          this.flow = null
          try {
            await this.establish(answer.session, flow.methodId)
          } catch (err) {
            this.log.error('[EnterpriseIdentity] Session refused', { message: err instanceof Error ? err.message : String(err) })
            return result('failed', 'The sign-in service returned an unusable session')
          }
          this.confirmedFlowId = flowId
          return result('ready')
        }
        case 'denied':
        case 'expired':
        case 'cancelled':
          this.flow = null
          this.log.log('[EnterpriseIdentity] Sign-in ended', { outcome: answer.status })
          return result(answer.status, isString(answer.message) ? answer.message : undefined)
        case 'scanned':
          if (flow.phase === 'waiting') {
            flow.phase = 'scanned'
            return result('scanned')
          }
          break
        case 'pending':
          break
        default:
          this.flow = null
          return result('failed', 'The sign-in service gave an unknown answer')
      }
      if (this.now() + this.pollIntervalMs > deadline) return result(flow.phase === 'scanned' ? 'scanned' : 'pending')
      await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs))
    }
  }

  async cancelLogin(flowId: string): Promise<EnterpriseIdentityState> {
    if (this.flow?.flowId === flowId) {
      this.flow = null
      try {
        await this.provider?.cancelLogin(flowId)
      } catch (err) {
        this.log.error('[EnterpriseIdentity] Cancel was not confirmed', { message: err instanceof Error ? err.message : String(err) })
      }
    }
    return this.snapshot()
  }

  async signOut(): Promise<EnterpriseIdentityState> {
    const provider = await this.getProvider()
    if (this.restoring) await this.restoring
    if (this.flow) await this.cancelLogin(this.flow.flowId)
    const had = this.session !== null || this.endedAccount !== null
    this.generation++
    this.session = null
    this.endedAccount = null
    this.lastError = undefined
    this.restoreRetryAt = 0
    this.clearTimers()
    await this.removeCredentials()
    await this.removeMarker()
    if (provider && had) {
      try {
        await provider.signOut()
      } catch (err) {
        this.log.error('[EnterpriseIdentity] Sign-out was not confirmed by the service', { message: err instanceof Error ? err.message : String(err) })
      }
    }
    this.log.log('[EnterpriseIdentity] Signed out')
    return this.snapshot()
  }

  /** Bindings as the CLI tool store takes them. */
  toolBindings(): ToolCredentialBinding[] {
    return toolCredentialBindings(this.bindings, this.credentialDir)
  }

  /** On quit: stop timers and withdraw every credential. */
  dispose(): void {
    this.generation++
    this.clearTimers()
    this.active.clear()
    try {
      rmSync(this.credentialDir, { recursive: true, force: true })
    } catch {
      // Nothing to withdraw.
    }
  }

  // ── session ────────────────────────────────────────────────────

  private async establish(session: EnterpriseSession, methodId: string): Promise<void> {
    if (!isString(session?.accountId) || typeof session.expiresAt !== 'number' || session.expiresAt <= this.now()) {
      throw new Error('session without account or already ended')
    }
    const generation = ++this.generation
    this.clearTimers()
    await this.removeCredentials()
    this.session = {
      accountId: session.accountId,
      displayName: isString(session.displayName) ? session.displayName : session.accountId,
      capabilities: Array.isArray(session.capabilities) ? session.capabilities.filter(isString) : [],
      expiresAt: session.expiresAt,
      methodId,
    }
    this.endedAccount = null
    this.lastError = undefined
    this.restoreRetryAt = 0
    this.armSessionTimer(generation)
    this.log.log('[EnterpriseIdentity] Signed in', { method: methodId, capabilities: this.session.capabilities.length })
    await this.writeMarker({ methodId, account: { id: this.session.accountId, displayName: this.session.displayName } })
    const audiences = new Set(this.bindings.filter(b => this.session!.capabilities.includes(b.capability)).map(b => b.audience))
    for (const audience of audiences) await this.issue(audience, generation)
  }

  private async runRestore(): Promise<void> {
    const marker = await this.readMarker()
    if (!marker) return
    const provider = await this.getProvider()
    if (!provider?.restore || this.session || this.flow) return
    const methodId = marker.methodId
    if (!this.methods().some(m => m.id === methodId)) {
      this.log.log('[EnterpriseIdentity] Last sign-in method is no longer offered; not restoring', { method: methodId })
      await this.removeMarker()
      return
    }
    const generation = this.generation
    let result: EnterpriseSession | 'renewal-required' | null
    try {
      result = await provider.restore(methodId)
    } catch (err) {
      this.restoreRetryAt = this.now() + this.restoreRetryMs
      this.log.error('[EnterpriseIdentity] Sign-in could not be restored; will retry later', { method: methodId, message: err instanceof Error ? err.message : String(err) })
      return
    }
    this.restoreRetryAt = 0
    if (generation !== this.generation || this.session || this.flow) {
      this.log.log('[EnterpriseIdentity] Restore result dropped: sign-in changed meanwhile', { method: methodId })
      return
    }
    if (result === null) {
      this.log.log('[EnterpriseIdentity] No authorization left to restore', { method: methodId })
      await this.removeMarker()
      return
    }
    if (result === 'renewal-required') {
      this.endedAccount = { account: marker.account, methodId }
      this.log.log('[EnterpriseIdentity] Restore needs a new sign-in', { method: methodId })
      return
    }
    try {
      await this.establish(result, methodId)
      this.log.log('[EnterpriseIdentity] Sign-in restored', { method: methodId })
    } catch (err) {
      this.log.error('[EnterpriseIdentity] Restored session refused', { method: methodId, message: err instanceof Error ? err.message : String(err) })
    }
  }

  private async readMarker(): Promise<SessionMarker | null> {
    if (!this.sessionMarkerFile) return null
    let raw: string
    try {
      raw = await fsp.readFile(this.sessionMarkerFile, 'utf8')
    } catch {
      return null
    }
    try {
      const value = JSON.parse(raw) as Partial<SessionMarker>
      if (isString(value?.methodId) && isString(value.account?.id)) {
        return {
          methodId: value.methodId,
          account: { id: value.account.id, displayName: isString(value.account.displayName) ? value.account.displayName : value.account.id },
        }
      }
    } catch {
      // Unreadable marker: treated as none below.
    }
    this.log.error('[EnterpriseIdentity] Sign-in marker unreadable; removed')
    await this.removeMarker()
    return null
  }

  private async writeMarker(marker: SessionMarker): Promise<void> {
    if (!this.sessionMarkerFile) return
    const tmp = `${this.sessionMarkerFile}.${process.pid}.${Date.now().toString(36)}.tmp`
    try {
      await fsp.writeFile(tmp, JSON.stringify(marker), { mode: 0o600 })
      await fsp.rename(tmp, this.sessionMarkerFile)
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => undefined)
      this.log.error('[EnterpriseIdentity] Sign-in marker not saved; the next launch will ask to sign in', { message: err instanceof Error ? err.message : String(err) })
    }
  }

  private async removeMarker(): Promise<void> {
    if (!this.sessionMarkerFile) return
    await fsp.rm(this.sessionMarkerFile, { force: true }).catch(err => {
      this.log.error('[EnterpriseIdentity] Sign-in marker could not be removed', { message: err instanceof Error ? err.message : String(err) })
    })
  }

  private async waitAtMost(work: Promise<void>, ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>(resolve => {
      timer = setTimeout(resolve, ms)
      timer.unref?.()
    })
    await Promise.race([work, timeout])
    if (timer) clearTimeout(timer)
  }

  private armSessionTimer(generation: number): void {
    if (!this.session) return
    const wait = Math.min(Math.max(0, this.session.expiresAt - this.now()), MAX_TIMER_MS)
    this.sessionTimer = setTimeout(() => {
      this.sessionTimer = null
      if (generation !== this.generation || !this.session) return
      if (this.now() >= this.session.expiresAt) this.endSession()
      else this.armSessionTimer(generation)
    }, wait)
    this.sessionTimer.unref?.()
  }

  /** The session ran out: withdraw credentials, keep the account for display. */
  private endSession(): void {
    if (!this.session) return
    const ended = this.session
    this.generation++
    this.session = null
    this.endedAccount = { account: { id: ended.accountId, displayName: ended.displayName }, methodId: ended.methodId }
    this.clearTimers()
    this.active.clear()
    try {
      rmSync(this.credentialDir, { recursive: true, force: true })
    } catch (err) {
      this.log.error('[EnterpriseIdentity] Credentials could not be removed', { message: err instanceof Error ? err.message : String(err) })
    }
    this.log.log('[EnterpriseIdentity] Session ended')
    void this.provider?.signOut().catch(() => undefined)
  }

  private async issue(audience: string, generation: number): Promise<void> {
    const provider = this.provider
    const session = this.session
    if (!provider || !session || generation !== this.generation) return
    try {
      await this.ready
      const credential = await provider.issueCredential(audience)
      if (generation !== this.generation) return
      if (!isString(credential?.token) || typeof credential.expiresAt !== 'number' || credential.expiresAt <= this.now()) {
        throw new Error('unusable credential')
      }
      const expiresAt = Math.min(credential.expiresAt, session.expiresAt)
      await this.writeCredential(audience, credential.token, expiresAt)
      if (generation !== this.generation) {
        await fsp.rm(credentialFileOf(this.credentialDir, audience), { force: true })
        return
      }
      this.active.add(audience)
      if (expiresAt < session.expiresAt) this.armRefresh(audience, expiresAt, generation)
    } catch (err) {
      if (generation !== this.generation) return
      this.active.delete(audience)
      await fsp.rm(credentialFileOf(this.credentialDir, audience), { force: true }).catch(() => undefined)
      this.lastError = 'credential-failed'
      this.log.error('[EnterpriseIdentity] Tool credential not obtained', { audience, message: err instanceof Error ? err.message : String(err) })
    }
  }

  private armRefresh(audience: string, expiresAt: number, generation: number): void {
    const left = expiresAt - this.now()
    const wait = Math.min(Math.max(1000, left - Math.min(this.refreshMarginMs, left / 2)), MAX_TIMER_MS)
    const timer = setTimeout(() => {
      this.refreshTimers.delete(audience)
      void this.issue(audience, generation)
    }, wait)
    timer.unref?.()
    this.refreshTimers.set(audience, timer)
  }

  private async writeCredential(audience: string, token: string, expiresAt: number): Promise<void> {
    await fsp.mkdir(this.credentialDir, { recursive: true, mode: 0o700 })
    const file = credentialFileOf(this.credentialDir, audience)
    const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`
    await fsp.writeFile(tmp, JSON.stringify({ token, expiresAt }), { mode: 0o600 })
    await fsp.rename(tmp, file)
  }

  private async removeCredentials(): Promise<void> {
    this.active.clear()
    await fsp.rm(this.credentialDir, { recursive: true, force: true }).catch(err => {
      this.log.error('[EnterpriseIdentity] Credentials could not be removed', { message: err instanceof Error ? err.message : String(err) })
    })
  }

  private clearTimers(): void {
    if (this.sessionTimer) clearTimeout(this.sessionTimer)
    this.sessionTimer = null
    for (const timer of this.refreshTimers.values()) clearTimeout(timer)
    this.refreshTimers.clear()
  }
}
