import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createRequire } from 'module'
import { runInNewContext } from 'vm'
import { renderCredentialPreload } from '../../../src/main/services/cli-tools/credentials'

const faults = vi.hoisted(() => ({ replace: new Set<string>(), remove: new Set<string>() }))
vi.mock('fs', async importOriginal => {
  const fs = await importOriginal<typeof import('fs')>()
  return {
    ...fs,
    renameSync(from: string, to: string) {
      if (faults.replace.has(to)) throw new Error('rename denied')
      fs.renameSync(from, to)
    },
    rmSync(path: string, options?: Parameters<typeof fs.rmSync>[1]) {
      if (faults.remove.has(path)) throw new Error('unlink denied')
      fs.rmSync(path, options)
    },
  }
})
import {
  EnterpriseIdentityService,
  toolCredentialBindings,
  type EnterpriseToolBindingConfig,
} from '../../../src/main/services/enterprise-identity/service'
import type { EnterpriseIdentityProvider, OrgProviderSnapshot, OrgSignInOutcome, OrgToolCredential } from '../../../src/shared/interfaces/enterprise-identity-provider'
import type { LoginWindowOptions } from '../../../src/main/services/login-window'

const BINDINGS: EnterpriseToolBindingConfig[] = [
  { toolId: 'npm.gitbeaker', capability: 'intranet', audience: 'code-host', env: 'GITBEAKER_TOKEN', staticEnv: { GITBEAKER_HOST: 'https://git.example' } },
  { toolId: 'npm.mailer', capability: 'mail', audience: 'mail', env: 'MAIL_TOKEN' },
]

type ServiceOptions = ConstructorParameters<typeof EnterpriseIdentityService>[0]

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(settle => { resolve = settle })
  return { promise, resolve }
}

class FakeProvider implements EnterpriseIdentityProvider {
  readonly contractVersion = 2
  current: OrgProviderSnapshot = { phase: 'settled', capabilities: {} }
  private listeners = new Set<() => void>()
  readonly terminal = deferred<OrgSignInOutcome>()
  readonly supportsDeviceUnbind = true
  readonly beginSignIn = vi.fn(async () => ({ flowId: 'flow', url: 'https://login.example/' }))
  readonly awaitSignIn = vi.fn(() => this.terminal.promise)
  readonly cancelSignIn = vi.fn(async () => {})
  readonly signOut = vi.fn(async (_scope: 'session' | 'device') => this.set({ phase: 'settled', capabilities: {} }))
  readonly verify = vi.fn(async () => {})
  readonly issueCredential = vi.fn(async (audience: string) => ({ token: `mock-${audience}`, expiresAt: Date.now() + 60_000 }))

  snapshot() { return this.current }
  capabilityCatalog() { return [{ id: 'intranet', label: 'Intranet' }, { id: 'mail', label: 'Mail' }] }
  onDidChange(listener: () => void) {
    this.listeners.add(listener)
    return { dispose: () => this.listeners.delete(listener) }
  }
  set(snapshot: OrgProviderSnapshot) {
    this.current = snapshot
    for (const listener of this.listeners) listener()
  }
}

const active = (subject = 'principal-a', capabilities: OrgProviderSnapshot['capabilities'] = {
  intranet: { status: 'ready' }, mail: { status: 'ready' },
}): OrgProviderSnapshot => ({ phase: 'settled', subject, account: { displayName: 'Same name' }, capabilities })

let dir: string
let credentialDir: string
let provider: FakeProvider
let windowOptions: LoginWindowOptions | undefined
const services: EnterpriseIdentityService[] = []
const window = { focus: vi.fn(), close: vi.fn() }
const loadProvider = vi.fn(async () => provider)
const openWindow = vi.fn((options: LoginWindowOptions) => { windowOptions = options; return window })
const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn() }
const credentialPath = (audience: string) => join(credentialDir, `${audience}.json`)
const credential = (audience: string): OrgToolCredential => JSON.parse(readFileSync(credentialPath(audience), 'utf8'))
const require = createRequire(import.meta.url)
function launcherToken(audience: string): string | undefined {
  const binding = toolCredentialBindings(BINDINGS, credentialDir).find(binding => binding.file === credentialPath(audience))!
  const env: Record<string, string> = { [binding.env]: 'inherited' }
  runInNewContext(renderCredentialPreload(binding), { process: { env }, require, Date })
  return env[binding.env]
}
const flush = () => vi.advanceTimersByTimeAsync(0)

function newService(overrides: Partial<ServiceOptions> = {}) {
  const service = new EnterpriseIdentityService({
    name: 'Organization', bindings: BINDINGS, credentialDir, loadProvider, openWindow, log, ...overrides,
  })
  services.push(service)
  return service
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  dir = mkdtempSync(join(tmpdir(), 'halo-enterprise-identity-'))
  credentialDir = join(dir, 'enterprise-identity')
  provider = new FakeProvider()
  windowOptions = undefined
})

afterEach(() => {
  faults.replace.clear()
  faults.remove.clear()
  for (const service of services.splice(0)) service.dispose()
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

describe('organization sign-in projection', () => {
  it('loads on state demand and never presents a restoring provider as signed out', async () => {
    const service = newService()
    const changed = vi.fn()
    service.onDidChange(changed)
    provider.current = { phase: 'restoring', capabilities: {} }
    expect(service.peekState().status).toBe('loading')
    expect(loadProvider).not.toHaveBeenCalled()
    expect(service.getState().status).toBe('loading')
    await flush()
    expect(changed.mock.calls.map(([state]) => state.status)).toEqual(['restoring'])
    expect(service.getState()).toMatchObject({ status: 'restoring', name: 'Organization' })
    expect(vi.getTimerCount()).toBe(0)
    provider.set({ phase: 'settled', capabilities: {} })
    expect(service.getState().status).toBe('signed-out')
    provider.set(active('principal-a', { intranet: { status: 'expired' } }))
    expect(service.getState()).toMatchObject({
      status: 'active',
      account: { displayName: 'Same name' },
      capabilities: [
        { id: 'intranet', label: 'Intranet', status: 'expired' },
        { id: 'mail', label: 'Mail', status: 'missing' },
      ],
    })
    expect(service.getState()).not.toHaveProperty('subject')
    expect(loadProvider).toHaveBeenCalledTimes(1)
  })

  it.each(['state', 'sign-in'] as const)('retries a transient provider load failure on the next %s request', async retry => {
    const load = vi.fn(async () => provider).mockRejectedValueOnce(new Error('temporary'))
    const service = newService({ loadProvider: load })
    expect(service.getState().status).toBe('loading')
    await flush()
    expect(service.peekState().status).toBe('unavailable')
    expect(log.error).toHaveBeenCalledOnce()
    if (retry === 'state') service.getState()
    else void service.signIn()
    await flush()
    expect(service.peekState().status).toBe('signed-out')
    expect(load).toHaveBeenCalledTimes(2)
    expect(provider.beginSignIn).toHaveBeenCalledTimes(retry === 'sign-in' ? 1 : 0)
  })

  it('recovers a failed load and a cached provider snapshot on Retry without a provider event', async () => {
    const load = vi.fn(async () => provider).mockRejectedValueOnce(new Error('temporary load'))
    const service = newService({ loadProvider: load })
    vi.spyOn(provider, 'snapshot').mockImplementationOnce(() => { throw new Error('temporary snapshot') })
    service.getState()
    await flush()
    expect(service.peekState()).toMatchObject({ status: 'unavailable', unavailableReason: 'temporary' })
    expect(await service.retry()).toMatchObject({ status: 'unavailable', unavailableReason: 'temporary' })
    provider.current = active()
    expect(await service.retry()).toMatchObject({ status: 'active' })
    await flush()
    expect(launcherToken('code-host')).toBe('mock-code-host')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('rejects a v1 provider before calling any of its methods', async () => {
    const snapshot = vi.fn()
    const unsupported = { contractVersion: 1, snapshot } as unknown as EnterpriseIdentityProvider
    const load = vi.fn(async () => unsupported)
    const service = newService({ loadProvider: load })
    service.getState()
    await flush()
    expect(service.getState().status).toBe('unavailable')
    expect(await service.signIn()).toBe('failed')
    expect(await service.retry()).toMatchObject({ status: 'unavailable', unavailableReason: 'incompatible' })
    expect(load).toHaveBeenCalledOnce()
    expect(snapshot).not.toHaveBeenCalled()
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('contract'))
  })
})

describe('organization tool credentials', () => {
  it.each([
    ['missing subject', { subject: undefined }],
    ['blank subject', { subject: ' ' }],
    ['non-string subject', { subject: 42 }],
    ['illegal phase', { phase: 'unknown' }],
    ['illegal status', { capabilities: { unlisted: { status: 'pending' } } }],
    ['non-finite expiry', { capabilities: { intranet: { status: 'ready', expiresAt: Infinity } } }],
  ])('rejects %s, removes existing credentials, and discards a late issue', async (_label, invalid) => {
    const issue = deferred<OrgToolCredential>()
    provider.issueCredential.mockImplementationOnce(() => issue.promise)
    provider.current = active()
    const service = newService()
    service.getState()
    await flush()
    expect(launcherToken('mail')).toBe('mock-mail')
    provider.set({ ...active(), ...invalid } as OrgProviderSnapshot)
    expect(service.peekState().status).toBe('unavailable')
    expect(service.peekState().capabilities).toEqual([])
    expect(launcherToken('mail')).toBeUndefined()
    issue.resolve({ token: 'late', expiresAt: Date.now() + 30_000 })
    await flush()
    expect(launcherToken('code-host')).toBeUndefined()
    expect(provider.issueCredential).toHaveBeenCalledTimes(2)
    expect(log.error.mock.calls).toEqual([['[EnterpriseIdentity] Provider state could not be read']])
  })

  it.each(['replace', 'remove'] as const)('withdraws just one capability when %s fails', async fault => {
    provider.current = active()
    const service = newService()
    service.getState()
    await flush()
    faults[fault].add(credentialPath('code-host'))
    provider.set(active('principal-a', { intranet: { status: 'expired' }, mail: { status: 'ready' } }))
    expect(launcherToken('code-host')).toBeUndefined()
    expect(launcherToken('mail')).toBe('mock-mail')
    expect(service.peekState().credentialFailed).toBeUndefined()
    if (fault === 'remove') expect(credential('code-host')).toEqual({ token: '', expiresAt: 0 })
  })

  it('marks a single audience withdrawal failure without withdrawing a healthy audience', async () => {
    provider.current = active()
    const service = newService()
    service.getState()
    await flush()
    faults.replace.add(credentialPath('code-host'))
    faults.remove.add(credentialPath('code-host'))
    const partial = active('principal-a', { intranet: { status: 'expired' }, mail: { status: 'ready' } })
    provider.set(partial)
    expect(service.peekState()).toMatchObject({ status: 'active', withdrawalPending: true })
    expect(service.peekState().credentialFailed).toBeUndefined()
    expect(service.peekState().boundTools.map(tool => tool.access)).toEqual(['maybe-still-valid', 'ready'])
    expect(launcherToken('mail')).toBe('mock-mail')
    expect(launcherToken('code-host')).toBe('mock-code-host')
    faults.replace.clear()
    await service.retry()
    expect(launcherToken('code-host')).toBeUndefined()
    expect(service.peekState().boundTools.map(tool => tool.access)).toEqual(['none', 'ready'])
    expect(service.peekState().withdrawalPending).toBeUndefined()
  })

  it('does not issue for another subject before every old slot is withdrawn', async () => {
    provider.current = active()
    const service = newService()
    service.getState()
    await flush()
    faults.replace.add(credentialPath('code-host'))
    faults.remove.add(credentialPath('code-host'))
    provider.issueCredential.mockImplementation(async audience => ({ token: `new-${audience}`, expiresAt: Date.now() + 60_000 }))
    provider.set(active('principal-b'))
    await flush()
    expect(service.peekState()).toMatchObject({ status: 'unavailable', withdrawalPending: true })
    expect(service.peekState().boundTools.map(tool => tool.access)).toEqual(['maybe-still-valid', 'none'])
    expect(provider.issueCredential).toHaveBeenCalledTimes(2)
    expect(launcherToken('mail')).toBeUndefined()
    expect(launcherToken('code-host')).toBe('mock-code-host')
    faults.replace.clear()
    provider.set(active('principal-b'))
    expect(launcherToken('code-host')).toBeUndefined()
    faults.remove.clear()
    await flush()
    expect(launcherToken('code-host')).toBe('new-code-host')
    expect(launcherToken('mail')).toBe('new-mail')
  })

  it('rejects local sign-out on total withdrawal failure and clears launcher access on retry', async () => {
    provider.current = active()
    const service = newService()
    service.getState()
    await flush()
    faults.replace.add(credentialPath('code-host'))
    faults.remove.add(credentialPath('code-host'))
    await expect(service.signOut('session')).rejects.toThrow('Tool credentials could not be removed')
    expect(service.peekState()).toMatchObject({ status: 'active', withdrawalPending: true })
    expect(service.peekState().credentialFailed).toBeUndefined()
    expect(provider.signOut).not.toHaveBeenCalled()
    expect(launcherToken('mail')).toBeUndefined()
    expect(launcherToken('code-host')).toBe('mock-code-host')
    faults.replace.clear()
    provider.signOut.mockRejectedValueOnce(new Error('offline'))
    await expect(service.retry()).rejects.toThrow('Organization sign-out could not be confirmed')
    expect(launcherToken('code-host')).toBeUndefined()
    expect(launcherToken('mail')).toBeUndefined()
    expect(service.peekState().status).toBe('active')
    expect(service.peekState().withdrawalPending).toBeUndefined()
    expect((await service.signOut('session')).status).toBe('signed-out')
  })
  it('caps expiry and withdraws only the audience for the expired or missing capability', async () => {
    const service = newService()
    const expiry = Date.now() + 5_000
    provider.current = active('principal-a', { intranet: { status: 'ready', expiresAt: expiry }, mail: { status: 'ready' } })
    service.getState()
    await flush()
    expect(credential('code-host').expiresAt).toBe(expiry)
    if (process.platform !== 'win32') expect(statSync(credentialPath('code-host')).mode & 0o777).toBe(0o600)
    expect(service.getState().boundTools.every(tool => tool.access === 'ready')).toBe(true)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(service.getState().capabilities.map(item => item.status)).toEqual(['expired', 'ready'])
    expect(existsSync(credentialPath('code-host'))).toBe(false)
    expect(credential('mail').token).toBe('mock-mail')
    expect(vi.getTimerCount()).toBe(1)
    provider.set(active('principal-a', { intranet: { status: 'expired' } }))
    expect(existsSync(credentialPath('mail'))).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not resurrect a withdrawn audience when its issue resolves late', async () => {
    const issue = deferred<OrgToolCredential>()
    provider.issueCredential.mockImplementationOnce(() => issue.promise)
    const service = newService()
    provider.current = active()
    service.getState()
    await flush()
    expect(provider.issueCredential).toHaveBeenCalledWith('code-host')
    provider.set(active('principal-a', { mail: { status: 'ready' } }))
    issue.resolve({ token: 'late', expiresAt: Date.now() + 5_000 })
    await flush()
    expect(existsSync(credentialPath('code-host'))).toBe(false)
    expect(credential('mail').token).toBe('mock-mail')
  })

  it('does not overwrite subject B credentials when subject A has the same name and resolves last', async () => {
    const issueA = deferred<OrgToolCredential>()
    provider.issueCredential.mockImplementationOnce(() => issueA.promise)
    const service = newService()
    provider.current = active()
    service.getState()
    await flush()
    expect(existsSync(credentialPath('mail'))).toBe(true)
    provider.issueCredential.mockImplementation(audience => Promise.resolve({ token: `new-${audience}`, expiresAt: Date.now() + 60_000 }))
    provider.set(active('principal-b'))
    expect(existsSync(credentialPath('mail'))).toBe(false)
    await flush()
    expect(credential('code-host').token).toBe('new-code-host')
    issueA.resolve({ token: 'prior-principal', expiresAt: Date.now() + 60_000 })
    await flush()
    expect(credential('code-host').token).toBe('new-code-host')
    expect(credential('mail').token).toBe('new-mail')
  })

  it('renews healthy audiences and keeps a failed renewal usable until its own expiry', async () => {
    const service = newService()
    provider.current = active()
    service.getState()
    await flush()
    const first = credential('mail').expiresAt
    provider.issueCredential.mockImplementation(async audience => {
      if (audience === 'code-host') throw new Error('refused')
      return { token: 'refreshed', expiresAt: Date.now() + 60_000 }
    })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(credential('mail')).toMatchObject({ token: 'refreshed', expiresAt: first + 30_000 })
    expect(launcherToken('code-host')).toBe('mock-code-host')
    expect(service.getState().credentialFailed).toBeUndefined()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(launcherToken('code-host')).toBeUndefined()
    expect(service.getState().credentialFailed).toBe(true)
    expect(launcherToken('mail')).toBe('refreshed')
  })

  it.each(['provider change', 'verify', 'Retry'] as const)('bounds renewal retries and resets after %s', async trigger => {
    const snapshot = active('principal-a', { intranet: { status: 'ready' } })
    provider.current = snapshot
    const service = newService()
    service.getState()
    await flush()
    provider.issueCredential.mockRejectedValue(new Error('offline'))
    for (const [index, delay] of [30_000, 30_000, 120_000, 300_000].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(provider.issueCredential).toHaveBeenCalledTimes(index + 1)
      await vi.advanceTimersByTimeAsync(1)
      expect(provider.issueCredential).toHaveBeenCalledTimes(index + 2)
    }
    expect(service.peekState().credentialFailed).toBe(true)
    await vi.advanceTimersByTimeAsync(300_000)
    expect(provider.issueCredential).toHaveBeenCalledTimes(5)
    provider.issueCredential.mockResolvedValueOnce({ token: 'recovered', expiresAt: Date.now() + 60_000 })
    if (trigger === 'verify') await service.verify()
    else if (trigger === 'Retry') await service.retry()
    else provider.set(snapshot)
    await flush()
    expect(provider.issueCredential).toHaveBeenCalledTimes(6)
    expect(launcherToken('code-host')).toBe('recovered')
    expect(service.peekState().credentialFailed).toBeUndefined()
  })

  it('removes files before device unbinding and on quit', async () => {
    const service = newService()
    provider.current = active()
    service.getState()
    await flush()
    provider.signOut.mockImplementation(async () => {
      expect(existsSync(credentialDir)).toBe(false)
      provider.set({ phase: 'settled', capabilities: {} })
    })
    expect((await service.signOut('device')).status).toBe('signed-out')
    expect(provider.signOut).toHaveBeenCalledWith('device')
    const signedInAgain = service.signIn()
    await flush()
    provider.set(active())
    provider.terminal.resolve('succeeded')
    await signedInAgain
    await flush()
    expect(existsSync(credentialPath('mail'))).toBe(true)
    service.dispose()
    expect(existsSync(credentialDir)).toBe(false)
  })

  it('preserves CLI binding paths and fixed variables while rejecting conflicting audience ownership', () => {
    expect(toolCredentialBindings(BINDINGS, credentialDir)[0]).toEqual({
      toolId: 'npm.gitbeaker', env: 'GITBEAKER_TOKEN', file: credentialPath('code-host'),
      staticEnv: { GITBEAKER_HOST: 'https://git.example' },
    })
    expect(toolCredentialBindings([...BINDINGS, { ...BINDINGS[0], capability: 'mail' }], credentialDir))
      .toEqual(toolCredentialBindings([BINDINGS[1]], credentialDir))
  })
})

describe('organization sign-in lifetime', () => {
  it('expires while activation is pending and a new attempt can use the loaded provider', async () => {
    const loading = deferred<EnterpriseIdentityProvider>()
    const service = newService({ loadProvider: () => loading.promise, signInTimeoutMs: 1000 })
    const first = service.signIn()
    await vi.advanceTimersByTimeAsync(1000)
    expect(await first).toBe('expired')
    const second = service.signIn()
    loading.resolve(provider)
    await flush()
    expect(second).not.toBe(first)
    expect(provider.beginSignIn).toHaveBeenCalledOnce()
    expect(openWindow).toHaveBeenCalledOnce()
  })

  it('expires a hung beginSignIn, starts fresh on retry, and only cancels the late flow', async () => {
    const late = deferred<{ flowId: string; url: string }>()
    provider.beginSignIn.mockImplementationOnce(() => late.promise)
    const service = newService({ signInTimeoutMs: 1000 })
    const first = service.signIn()
    expect(service.signIn()).toBe(first)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await first).toBe('expired')
    expect(openWindow).not.toHaveBeenCalled()
    const second = service.signIn()
    await flush()
    expect(provider.beginSignIn).toHaveBeenCalledTimes(2)
    late.resolve({ flowId: 'stale', url: 'https://login.example/' })
    await flush()
    expect(provider.cancelSignIn.mock.calls).toEqual([['stale']])
    expect(openWindow).toHaveBeenCalledOnce()
    provider.terminal.resolve('succeeded')
    expect(await second).toBe('succeeded')
  })

  it.each(['session', 'device'] as const)('cancels the attempt before %s sign-out and ignores stale provider success', async scope => {
    const service = newService()
    const result = service.signIn()
    await flush()
    expect(service.peekState().signingIn).toBe(true)
    const signOut = service.signOut(scope)
    expect(await result).toBe('cancelled')
    expect(window.close).toHaveBeenCalledOnce()
    expect(provider.cancelSignIn.mock.calls).toEqual([['flow']])
    expect((await signOut).status).toBe('signed-out')
    provider.set(active('stale'))
    provider.terminal.resolve('succeeded')
    await flush()
    expect(service.peekState().status).toBe('signed-out')
    expect(launcherToken('code-host')).toBeUndefined()
    expect(provider.issueCredential).not.toHaveBeenCalled()
  })

  it('cancels a flow ID returned after sign-out without opening its window', async () => {
    const late = deferred<{ flowId: string; url: string }>()
    provider.beginSignIn.mockImplementationOnce(() => late.promise)
    const service = newService()
    const result = service.signIn()
    await flush()
    await service.signOut('session')
    expect(await result).toBe('cancelled')
    late.resolve({ flowId: 'stale', url: 'https://login.example/' })
    await flush()
    expect(provider.cancelSignIn.mock.calls).toEqual([['stale']])
    expect(openWindow).not.toHaveBeenCalled()
    expect(provider.awaitSignIn).not.toHaveBeenCalled()
  })
  it('focuses a pending sign-in and closes only when that flow becomes terminal', async () => {
    const service = newService()
    const result = service.signIn()
    await flush()
    expect(service.getState().signingIn).toBe(true)
    provider.set(active())
    await flush()
    expect(window.close).not.toHaveBeenCalled()
    expect(service.signIn()).toBe(result)
    expect(window.focus).toHaveBeenCalledOnce()
    expect(provider.beginSignIn).toHaveBeenCalledOnce()
    provider.terminal.resolve('succeeded')
    expect(await result).toBe('succeeded')
    expect(window.close).toHaveBeenCalledOnce()
    expect(provider.cancelSignIn).not.toHaveBeenCalled()
    expect(service.getState().signingIn).toBe(false)
  })

  it.each(['cancelled', 'expired'] as const)('cancels once on %s and ignores subsequent outcomes', async outcome => {
    const service = newService()
    const result = service.signIn()
    await flush()
    windowOptions!.onEnd(outcome)
    windowOptions!.onEnd(outcome === 'expired' ? 'cancelled' : 'expired')
    provider.terminal.resolve('succeeded')
    expect(await result).toBe(outcome)
    await flush()
    expect(provider.cancelSignIn.mock.calls).toEqual([['flow']])
    expect(window.close).toHaveBeenCalledOnce()
  })

  it('prunes local expiry on resume before a deduplicated verification that may fail', async () => {
    let now = Date.now()
    const recheck = deferred<void>()
    provider.verify.mockImplementation(async () => { await recheck.promise; throw new Error('offline') })
    provider.current = active('principal-a', { intranet: { status: 'ready', expiresAt: now + 1000 } })
    const service = newService({ now: () => now })
    service.getState()
    await flush()
    expect(existsSync(credentialPath('code-host'))).toBe(true)
    now += 2000
    const check = service.verify()
    expect(service.verify()).toBe(check)
    expect(service.getState().capabilities[0].status).toBe('expired')
    expect(existsSync(credentialPath('code-host'))).toBe(false)
    recheck.resolve()
    await check
    expect(provider.verify).toHaveBeenCalledOnce()
    expect(provider.signOut).not.toHaveBeenCalled()
    expect(service.getState().status).toBe('active')
  })
})
