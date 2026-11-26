import { rmdirSync } from 'fs'
import {
  ENTERPRISE_IDENTITY_CONTRACT_VERSION,
  type EnterpriseIdentityProvider,
  type OrgProviderSnapshot,
} from '../../../shared/interfaces/enterprise-identity-provider'
import type { OrgCapabilityView, OrgSignInResult, OrgSignInState } from '../../../shared/types/enterprise-identity'
import { Emitter, type IDisposable } from '../../platform/event'
import type { LoginWindow, LoginWindowOptions } from '../login-window'
import { credentialFileOf, withdrawCredential, writeCredential } from './credential-slot'

export interface EnterpriseToolBindingConfig {
  toolId: string
  capability: string
  audience: string
  env: string
  staticEnv?: Record<string, string>
}

export interface ToolCredentialBinding {
  toolId: string
  env: string
  file: string
  staticEnv?: Record<string, string>
}

export interface EnterpriseIdentityServiceOptions {
  name?: string
  bindings: EnterpriseToolBindingConfig[]
  credentialDir: string
  loadProvider: () => Promise<EnterpriseIdentityProvider | null>
  openWindow: (options: LoginWindowOptions) => LoginWindow
  prepareCredentials?: () => Promise<boolean>
  now?: () => number
  signInTimeoutMs?: number
  refreshMarginMs?: number
  log?: Pick<Console, 'error' | 'warn' | 'info'>
}

const AUDIENCE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const MAX_TIMER_MS = 2 ** 31 - 1
const SIGN_IN_TIMEOUT_MS = 10 * 60_000
const ISSUE_RETRY_MS = [30_000, 120_000, 300_000]

type SignOutScope = Parameters<EnterpriseIdentityProvider['signOut']>[0]

export function usableBindings(bindings: EnterpriseToolBindingConfig[] | undefined): EnterpriseToolBindingConfig[] {
  const candidates = (bindings ?? []).filter(binding =>
    binding && typeof binding.toolId === 'string' && binding.toolId !== '' &&
    typeof binding.capability === 'string' && binding.capability !== '' &&
    typeof binding.audience === 'string' && AUDIENCE.test(binding.audience) &&
    typeof binding.env === 'string' && binding.env !== '')
  const capabilities = new Map<string, Set<string>>()
  for (const binding of candidates) {
    const key = binding.audience.toLowerCase()
    const uses = capabilities.get(key) ?? new Set<string>()
    uses.add(`${binding.audience}:${binding.capability}`)
    capabilities.set(key, uses)
  }
  return candidates.filter(binding => capabilities.get(binding.audience.toLowerCase())?.size === 1)
}

export function toolCredentialBindings(
  bindings: EnterpriseToolBindingConfig[] | undefined,
  credentialDir: string,
): ToolCredentialBinding[] {
  return usableBindings(bindings).map(binding => ({
    toolId: binding.toolId,
    env: binding.env,
    file: credentialFileOf(credentialDir, binding.audience),
    ...(binding.staticEnv ? { staticEnv: binding.staticEnv } : {}),
  }))
}

function isProviderSnapshot(snapshot: unknown): snapshot is OrgProviderSnapshot {
  if (!snapshot || typeof snapshot !== 'object') return false
  const { phase, subject, capabilities, account } = snapshot as Partial<OrgProviderSnapshot>
  if (phase !== 'restoring' && phase !== 'settled') return false
  if (subject !== undefined && (typeof subject !== 'string' || !subject.trim())) return false
  if (account !== undefined && (typeof account?.displayName !== 'string')) return false
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) return false
  const states = Object.values(capabilities)
  if (phase === 'settled' && states.length > 0 && subject === undefined) return false
  return states.every(state => state && (state.status === 'ready' || state.status === 'expired') &&
    (state.expiresAt === undefined || Number.isFinite(state.expiresAt)))
}

interface AudienceState {
  capability: string
  generation: number
  limit?: number
  expiresAt?: number
  refreshAt?: number
  pending: boolean
  issueFailures: number
  issueFailed?: boolean
  withdrawalFailed?: boolean
}

interface SignInAttempt {
  result: Promise<OrgSignInResult>
  resolve: (result: OrgSignInResult) => void
  timeout: ReturnType<typeof setTimeout>
  flowId?: string
  window?: LoginWindow
}

export class EnterpriseIdentityService {
  private readonly bindings: EnterpriseToolBindingConfig[]
  private readonly audiences = new Map<string, AudienceState>()
  private readonly now: () => number
  private readonly log: Pick<Console, 'error' | 'warn' | 'info'>
  private readonly changes = new Emitter<OrgSignInState>()
  readonly onDidChange = this.changes.event
  private state: OrgSignInState
  private providerLoad?: Promise<void>
  private providerIncompatible = false
  private provider?: EnterpriseIdentityProvider
  private preparation?: Promise<boolean>
  private credentialsReady: boolean
  private preparationFailed = false
  private providerChanges?: IDisposable
  private verification?: Promise<void>
  private signOutTask?: Promise<OrgSignInState>
  private signOutScope?: SignOutScope
  private pendingSignOut?: SignOutScope
  private retryTask?: Promise<OrgSignInState>
  private attempt?: SignInAttempt
  private timer?: ReturnType<typeof setTimeout>
  private subject?: string
  private issuanceBlocked = false
  private signedOutLocally = false
  private disposed = false

  constructor(private readonly options: EnterpriseIdentityServiceOptions) {
    this.bindings = usableBindings(options.bindings)
    this.credentialsReady = !options.prepareCredentials
    this.now = options.now ?? Date.now
    this.log = options.log ?? console
    if (this.bindings.length !== options.bindings.length) {
      this.log.warn('[EnterpriseIdentity] Ignored invalid or conflicting credential bindings', { count: options.bindings.length - this.bindings.length })
    }
    for (const { audience, capability } of this.bindings) {
      this.audiences.set(audience, { capability, generation: 0, pending: false, issueFailures: 0 })
    }
    this.state = this.baseState('loading')
  }

  getState(): OrgSignInState {
    void this.prepareCredentials()
    void this.activate()
    return this.state
  }

  peekState(): OrgSignInState {
    return this.state
  }

  /** The provider's session variables while something works now; never loads or checks anything. */
  sessionEnvironment(): Record<string, string> {
    const state = this.state
    if (!this.provider || this.signedOutLocally || state.status !== 'active' || state.withdrawalPending) return {}
    if (!state.capabilities.some(capability => capability.status === 'ready')) return {}
    let raw: unknown
    try {
      raw = this.provider.sessionEnvironment?.()
    } catch (error) {
      this.log.error('[EnterpriseIdentity] Session environment unavailable', { message: error instanceof Error ? error.message : String(error) })
      return {}
    }
    return sanitizeSessionEnvironment(raw)
  }

  retry(): Promise<OrgSignInState> {
    return this.retryTask ??= Promise.resolve().then(async () => {
      if (this.disposed) return this.state
      if (this.signOutTask) return this.signOutTask
      if (this.pendingSignOut) return this.signOut(this.pendingSignOut)
      await this.prepareCredentials()
      if (this.disposed || this.signOutTask) return this.state
      if (this.provider) this.reconcile(true)
      else await this.activate()
      return this.state
    }).finally(() => { this.retryTask = undefined })
  }

  private activate(): Promise<void> {
    if (this.disposed || this.provider || this.providerIncompatible) return Promise.resolve()
    return this.providerLoad ??= Promise.resolve().then(async () => {
      const provider = await this.options.loadProvider()
      if (this.disposed) return
      if (!provider || provider.contractVersion !== ENTERPRISE_IDENTITY_CONTRACT_VERSION) {
        this.providerIncompatible = true
        this.providerUnavailable(`Incompatible provider contract; expected version ${ENTERPRISE_IDENTITY_CONTRACT_VERSION}`, 'incompatible')
        return
      }
      this.providerChanges = provider.onDidChange(() => this.reconcile(true))
      this.provider = provider
      this.reconcile()
    }).catch(() => this.providerUnavailable('Provider activation failed')).finally(() => {
      this.providerLoad = undefined
    })
  }

  private prepareCredentials(): Promise<boolean> {
    if (this.credentialsReady || !this.options.prepareCredentials) return Promise.resolve(true)
    return this.preparation ??= this.options.prepareCredentials().catch(() => {
      this.log.error('[EnterpriseIdentity] Startup credential cleanup failed')
      return false
    }).then(ready => {
      this.credentialsReady = ready
      this.preparationFailed = !ready
      if (this.provider) this.reconcile()
      else this.publish(this.baseState(this.state.status, this.state.unavailableReason))
      return ready
    }).finally(() => {
      this.preparation = undefined
    })
  }

  verify(): Promise<void> {
    this.reconcile(!this.verification)
    const provider = this.provider
    if (!provider?.verify || this.signOutTask || this.disposed) return Promise.resolve()
    return this.verification ??= Promise.resolve().then(() => provider.verify?.()).catch(() => {
      this.log.warn('[EnterpriseIdentity] Resume verification failed; retaining provider state')
    }).finally(() => {
      this.verification = undefined
      this.reconcile()
    })
  }

  signIn(): Promise<OrgSignInResult> {
    if (this.attempt) {
      this.attempt.window?.focus()
      return this.attempt.result
    }
    if (this.signOutTask || this.pendingSignOut) return Promise.resolve('busy')
    if (this.disposed) return Promise.resolve('failed')
    let resolve!: SignInAttempt['resolve']
    const promise = new Promise<OrgSignInResult>(settle => { resolve = settle })
    const attempt: SignInAttempt = {
      result: promise, resolve,
      timeout: setTimeout(() => this.finishSignIn(attempt, 'expired', this.provider), this.options.signInTimeoutMs ?? SIGN_IN_TIMEOUT_MS),
    }
    attempt.timeout.unref?.()
    this.attempt = attempt
    void this.runSignIn(attempt)
    return promise
  }

  private async runSignIn(attempt: SignInAttempt): Promise<void> {
    void this.prepareCredentials()
    await this.activate()
    if (this.attempt !== attempt) return
    const provider = this.provider
    if (!provider) {
      this.finishSignIn(attempt, 'failed')
      return
    }
    try {
      const { flowId, url } = await provider.beginSignIn()
      if (typeof flowId !== 'string' || !flowId) throw new Error('Missing sign-in flow ID')
      attempt.flowId = flowId
      if (this.attempt !== attempt) {
        this.cancelSignIn(provider, flowId)
        return
      }
      attempt.window = this.options.openWindow({
        url,
        title: this.options.name,
        onEnd: outcome => this.finishSignIn(attempt, outcome, provider),
      })
      this.reconcile()
      const outcome = await provider.awaitSignIn(flowId)
      switch (outcome) {
        case 'succeeded':
        case 'failed':
        case 'cancelled':
        case 'expired':
          this.finishSignIn(attempt, outcome)
          break
        default:
          throw new Error('Unknown sign-in outcome')
      }
    } catch {
      if (this.attempt !== attempt) return
      this.log.error('[EnterpriseIdentity] Sign-in could not proceed')
      this.finishSignIn(attempt, 'failed', provider)
    }
  }

  private finishSignIn(attempt: SignInAttempt, result: OrgSignInResult, cancelWith?: EnterpriseIdentityProvider): void {
    if (this.attempt !== attempt) return
    this.attempt = undefined
    clearTimeout(attempt.timeout)
    attempt.window?.close()
    if (cancelWith && attempt.flowId) this.cancelSignIn(cancelWith, attempt.flowId)
    if (result === 'succeeded') {
      this.issuanceBlocked = false
      this.signedOutLocally = false
    }
    if (this.provider) this.reconcile(result === 'succeeded')
    else this.publish(this.baseState(this.state.status, this.state.unavailableReason))
    attempt.resolve(result)
    this.log.info('[EnterpriseIdentity] Sign-in ended', { outcome: result })
  }

  private cancelSignIn(provider: EnterpriseIdentityProvider, flowId: string): void {
    try {
      void provider.cancelSignIn(flowId).catch(() => {
        this.log.warn('[EnterpriseIdentity] Provider did not confirm sign-in cancellation')
      })
    } catch {
      this.log.warn('[EnterpriseIdentity] Provider could not cancel sign-in')
    }
  }

  signOut(scope: SignOutScope): Promise<OrgSignInState> {
    if (this.signOutTask) {
      if (scope === 'device' && this.signOutScope === 'session') {
        return this.signOutTask.then(() => this.signOut('device'))
      }
      return this.signOutTask
    }
    this.pendingSignOut = scope
    this.signOutScope = scope
    const task = Promise.resolve().then(() => this.performSignOut(scope)).finally(() => {
      this.signOutTask = undefined
      this.signOutScope = undefined
      this.reconcile()
    })
    this.signOutTask = task
    this.issuanceBlocked = true
    if (this.attempt) this.finishSignIn(this.attempt, 'cancelled', this.provider)
    return task
  }

  private async performSignOut(scope: SignOutScope): Promise<OrgSignInState> {
    const prepared = await this.prepareCredentials()
    if (this.disposed) return this.state
    const withdrawn = this.withdrawAll()
    this.reconcile()
    if (!prepared || !withdrawn) {
      if (!this.provider) this.publish(this.baseState(this.state.status, this.state.unavailableReason))
      throw new Error('Tool credentials could not be removed')
    }
    this.pendingSignOut = undefined
    await this.activate()
    const provider = this.provider
    if (this.disposed) return this.state
    if (!provider) throw new Error('Organization sign-out could not be confirmed')
    if (scope === 'device' && !provider.supportsDeviceUnbind) {
      this.log.warn('[EnterpriseIdentity] Provider does not support device unbinding')
      throw new Error('Device unbinding is not available')
    }
    try {
      await provider.signOut(scope)
      this.signedOutLocally = true
    } catch {
      this.log.error('[EnterpriseIdentity] Provider did not confirm sign-out', { scope })
      throw new Error('Organization sign-out could not be confirmed')
    }
    this.reconcile()
    return this.state
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.providerChanges?.dispose()
    if (this.attempt) this.finishSignIn(this.attempt, 'cancelled', this.provider)
    this.withdrawAll()
    this.changes.dispose()
  }

  private baseState(status: OrgSignInState['status'], unavailableReason?: OrgSignInState['unavailableReason']): OrgSignInState {
    const now = this.now()
    const boundTools = this.bindings.map(({ toolId, capability, audience }) => {
      const slot = this.audiences.get(audience)
      const access = this.preparationFailed || slot?.withdrawalFailed ? 'maybe-still-valid' :
        (slot?.expiresAt ?? 0) > now ? 'ready' : 'none'
      return { toolId, capability, access } as const
    })
    const withdrawalPending = this.preparationFailed || boundTools.some(tool => tool.access === 'maybe-still-valid')
    const credentialFailed = [...this.audiences.values()].some(slot =>
      slot.issueFailed && (slot.expiresAt ?? 0) <= now)
    return {
      status,
      ...(this.options.name ? { name: this.options.name } : {}),
      ...(unavailableReason ? { unavailableReason } : {}),
      capabilities: [],
      boundTools,
      signingIn: !!this.attempt?.window,
      canUnbindDevice: false,
      ...(withdrawalPending ? { withdrawalPending: true } : {}),
      ...(credentialFailed ? { credentialFailed: true } : {}),
    }
  }

  private publish(state: OrgSignInState): void {
    if (this.disposed || JSON.stringify(this.state) === JSON.stringify(state)) return
    this.state = state
    this.changes.fire(state)
  }

  private providerUnavailable(reason: string, unavailableReason: OrgSignInState['unavailableReason'] = 'temporary'): void {
    if (this.disposed) return
    this.log.error(`[EnterpriseIdentity] ${reason}`)
    this.armTimer(Infinity, this.now())
    this.withdrawAll()
    this.subject = undefined
    this.publish(this.baseState('unavailable', unavailableReason))
  }

  private reconcile(resetRetries = false): void {
    if (this.disposed || !this.provider) return
    const provider = this.provider
    let snapshot: OrgProviderSnapshot
    let capabilities: OrgCapabilityView[]
    let canUnbindDevice: boolean
    const now = this.now()
    try {
      snapshot = provider.snapshot()
      if (!isProviderSnapshot(snapshot)) throw new Error('Invalid provider snapshot')
      capabilities = provider.capabilityCatalog().map(({ id, label }) => {
        const capability = Object.hasOwn(snapshot.capabilities, id) ? snapshot.capabilities[id] : undefined
        const expiresAt = capability?.expiresAt
        const status = !capability ? 'missing' : capability.status === 'expired' ||
          (expiresAt !== undefined && expiresAt <= now) ? 'expired' : 'ready'
        return { id, label, status, ...(expiresAt !== undefined ? { expiresAt } : {}) }
      })
      canUnbindDevice = provider.supportsDeviceUnbind === true
    } catch {
      this.providerUnavailable('Provider state could not be read')
      return
    }
    if (this.signedOutLocally) {
      this.publish({
        ...this.baseState('signed-out'),
        capabilities: capabilities.map(({ expiresAt: _expiresAt, ...capability }) => ({ ...capability, status: 'missing' as const })),
        canUnbindDevice,
      })
      return
    }
    if (snapshot.subject !== this.subject) {
      if (!this.withdrawAll()) {
        this.armTimer(Infinity, now)
        this.publish(this.baseState('unavailable', 'temporary'))
        return
      }
      this.subject = snapshot.subject
    }
    const status = snapshot.phase === 'restoring' ? 'restoring' :
      capabilities.some(capability => capability.status !== 'missing') ? 'active' : 'signed-out'
    const ready = new Map(capabilities.filter(capability => capability.status === 'ready').map(capability => [capability.id, capability]))
    let deadline = Infinity
    for (const capability of ready.values()) {
      if (capability.expiresAt !== undefined) deadline = Math.min(deadline, capability.expiresAt)
    }
    for (const [audience, slot] of this.audiences) {
      const capability = this.credentialsReady && status === 'active' && !this.issuanceBlocked ? ready.get(slot.capability) : undefined
      const limit = capability ? capability.expiresAt ?? Infinity : undefined
      if (slot.withdrawalFailed && (!resetRetries || !this.withdraw(audience, slot))) continue
      if (slot.limit !== undefined && slot.limit !== limit && !this.withdraw(audience, slot)) continue
      slot.limit = limit
      if (limit === undefined) continue
      if (resetRetries && slot.issueFailed) {
        slot.issueFailures = 0
        slot.refreshAt = now
      }
      if (!slot.pending && ((slot.refreshAt ?? Infinity) <= now ||
          (slot.expiresAt === undefined && !slot.issueFailed))) {
        void this.issue(provider, audience, slot, limit)
      }
      if (slot.expiresAt !== undefined && slot.expiresAt > now) deadline = Math.min(deadline, slot.expiresAt)
      if (!slot.pending && slot.refreshAt !== undefined) deadline = Math.min(deadline, slot.refreshAt)
    }
    this.armTimer(deadline, now)
    this.publish({
      ...this.baseState(status),
      ...(snapshot.account && status === 'active' ? { account: { displayName: snapshot.account.displayName } } : {}),
      capabilities,
      canUnbindDevice,
    })
  }

  private armTimer(deadline: number, now: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (!Number.isFinite(deadline) || deadline <= now) return
    this.timer = setTimeout(() => this.reconcile(), Math.min(Math.ceil(deadline - now), MAX_TIMER_MS))
    this.timer.unref?.()
  }

  private async issue(provider: EnterpriseIdentityProvider, audience: string, slot: AudienceState, limit: number): Promise<void> {
    slot.pending = true
    const { generation } = slot
    const current = () => slot.generation === generation && !this.disposed && !this.issuanceBlocked
    try {
      await Promise.resolve()
      if (!current() || limit <= this.now()) return
      const credential = await provider.issueCredential(audience)
      if (!current() || limit <= this.now()) return
      const now = this.now()
      const expiresAt = Math.min(limit, credential.expiresAt)
      if (typeof credential.token !== 'string' || !credential.token || !Number.isFinite(credential.expiresAt) || expiresAt <= now) {
        throw new Error('Invalid tool credential')
      }
      if (slot.expiresAt !== undefined && expiresAt <= slot.expiresAt) {
        this.scheduleIssueRetry(slot, now)
        this.log.warn('[EnterpriseIdentity] Renewal did not extend the tool credential', { audience, attempt: slot.issueFailures })
      } else {
        writeCredential(credentialFileOf(this.options.credentialDir, audience), credential.token, expiresAt)
        slot.expiresAt = expiresAt
        slot.issueFailures = 0
        slot.issueFailed = false
        const remaining = expiresAt - now
        slot.refreshAt = expiresAt < limit ? now + Math.max(1, remaining - Math.min(this.options.refreshMarginMs ?? 60_000, remaining / 2)) : undefined
      }
    } catch {
      if (!current()) return
      this.scheduleIssueRetry(slot, this.now())
      this.log.warn('[EnterpriseIdentity] Could not obtain tool credential', { audience, attempt: slot.issueFailures })
    } finally {
      if (slot.generation === generation) {
        slot.pending = false
        this.reconcile()
      }
    }
  }

  private scheduleIssueRetry(slot: AudienceState, now: number): void {
    slot.issueFailed = true
    const delay = ISSUE_RETRY_MS[slot.issueFailures++]
    slot.refreshAt = delay === undefined ? undefined : now + delay
  }

  private withdraw(audience: string, slot: AudienceState): boolean {
    slot.generation++
    slot.limit = undefined
    slot.pending = false
    slot.refreshAt = undefined
    slot.issueFailures = 0
    slot.issueFailed = false
    if (slot.expiresAt === undefined && !slot.withdrawalFailed) return true
    if (!withdrawCredential(credentialFileOf(this.options.credentialDir, audience))) {
      if (!slot.withdrawalFailed) this.log.error('[EnterpriseIdentity] Could not withdraw tool credential', { audience })
      slot.withdrawalFailed = true
      return false
    }
    slot.expiresAt = undefined
    slot.withdrawalFailed = false
    return true
  }

  private withdrawAll(): boolean {
    let withdrawn = true
    for (const [audience, slot] of this.audiences) {
      if (!this.withdraw(audience, slot)) withdrawn = false
    }
    if (withdrawn && this.credentialsReady && this.audiences.size > 0) {
      try {
        rmdirSync(this.options.credentialDir)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOENT' && code !== 'ENOTEMPTY') this.log.warn('[EnterpriseIdentity] Could not remove the credential directory')
      }
    }
    return withdrawn
  }
}

const SESSION_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
/** Variables that decide how shells and runtimes start; a provider never sets them. */
const RESERVED_SESSION_ENV = /^(PATH|PATHEXT|HOME|USERPROFILE|SHELL|COMSPEC|SYSTEMROOT|TEMP|TMP|TMPDIR|NODE_.*|HALO_.*|ELECTRON_.*|LD_.*|DYLD_.*|ANTHROPIC_.*|OPENAI_.*)$/i
const MAX_SESSION_ENV = 16
const MAX_SESSION_ENV_VALUE = 4096

/** Only well-formed, non-reserved variables with bounded values pass. */
export function sanitizeSessionEnvironment(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw as Record<string, unknown>).slice(0, MAX_SESSION_ENV)) {
    if (!SESSION_ENV_NAME.test(name) || RESERVED_SESSION_ENV.test(name)) continue
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SESSION_ENV_VALUE || /[\0\r\n]/.test(value)) continue
    env[name] = value
  }
  return env
}
