import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  EnterpriseIdentityService,
  toolCredentialBindings,
  type EnterpriseToolBindingConfig,
} from '../../../src/main/services/enterprise-identity/service'
import type {
  EnterpriseIdentityProvider,
  EnterpriseLoginPoll,
  EnterpriseSession,
  EnterpriseToolCredential,
} from '../../../src/shared/interfaces/enterprise-identity-provider'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Scriptable provider: each poll takes the next queued answer, then repeats the last. */
class FakeProvider implements EnterpriseIdentityProvider {
  answers: EnterpriseLoginPoll[] = []
  issued: string[] = []
  cancelled: string[] = []
  signOuts = 0
  flows = 0
  credentialLife = 60_000
  failAudience: string | null = null
  issueGate: Promise<void> | null = null
  methods() {
    return [
      { id: 'cloud', label: 'Cloud', kind: 'qr' as const, capabilities: ['intranet', 'mail'] },
      { id: 'esb', label: 'ESB', kind: 'qr' as const, capabilities: ['intranet'] },
    ]
  }
  async beginLogin(methodId: string) {
    this.flows++
    return { flowId: `flow-${this.flows}-${methodId}`, qrContent: `mock://qr/${this.flows}`, expiresAt: Date.now() + 60_000 }
  }
  async pollLogin(): Promise<EnterpriseLoginPoll> {
    return this.answers.length > 1 ? this.answers.shift()! : this.answers[0] ?? { status: 'pending' }
  }
  async cancelLogin(flowId: string) { this.cancelled.push(flowId) }
  async issueCredential(audience: string): Promise<EnterpriseToolCredential> {
    if (this.issueGate) await this.issueGate
    this.issued.push(audience)
    if (audience === this.failAudience) throw new Error('refused')
    return { token: `secret-${audience}-${this.issued.length}`, expiresAt: Date.now() + this.credentialLife }
  }
  async signOut() { this.signOuts++ }
}

const BINDINGS: EnterpriseToolBindingConfig[] = [
  { toolId: 'npm.gitbeaker', capability: 'intranet', audience: 'code-host', env: 'GITBEAKER_TOKEN', staticEnv: { GITBEAKER_HOST: 'http://h' } },
  { toolId: 'npm.mailer', capability: 'mail', audience: 'mail', env: 'MAIL_TOKEN' },
]

let dir: string
let credDir: string
let provider: FakeProvider
let logs: string[]

function session(overrides: Partial<EnterpriseSession> = {}): EnterpriseSession {
  return { accountId: 'u1', displayName: 'User One', capabilities: ['intranet', 'mail'], expiresAt: Date.now() + 60_000, ...overrides }
}

function newService(overrides: Partial<ConstructorParameters<typeof EnterpriseIdentityService>[0]> = {}) {
  const sink = (...args: unknown[]) => { logs.push(JSON.stringify(args)) }
  return new EnterpriseIdentityService({
    bindings: BINDINGS,
    credentialDir: credDir,
    loadProvider: async () => provider,
    pollIntervalMs: 5,
    pollWaitMs: 200,
    log: { log: sink, error: sink },
    ...overrides,
  })
}

async function signIn(service: EnterpriseIdentityService, methodId = 'cloud', s = session()) {
  const started = await service.beginLogin(methodId)
  provider.answers = [{ status: 'confirmed', session: s }]
  return service.pollLogin(started.flow!.flowId)
}

const cred = (audience: string) => join(credDir, `${audience}.json`)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'halo-enterprise-identity-'))
  credDir = join(dir, 'enterprise-identity')
  provider = new FakeProvider()
  logs = []
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('enterprise identity: availability', () => {
  it('is unavailable when the provider cannot be loaded', async () => {
    const service = newService({ loadProvider: async () => null })
    expect(await service.getState()).toEqual({ status: 'unavailable', methods: [], capabilities: [], boundTools: [] })
    await expect(service.beginLogin('cloud')).rejects.toThrow()
  })

  it('lists methods and bound tools while signed out', async () => {
    const state = await newService().getState()
    expect(state.status).toBe('signed-out')
    expect(state.methods.map(m => m.id)).toEqual(['cloud', 'esb'])
    expect(state.boundTools).toEqual([
      { toolId: 'npm.gitbeaker', capability: 'intranet', active: false },
      { toolId: 'npm.mailer', capability: 'mail', active: false },
    ])
  })

  it('refuses an unknown method', async () => {
    await expect(newService().beginLogin('nope')).rejects.toThrow('Unknown sign-in method')
  })
})

describe('enterprise identity: QR flow', () => {
  it('reports the scan, then signs in and writes one private credential per capable audience', async () => {
    const service = newService()
    const started = await service.beginLogin('cloud')
    expect(started.status).toBe('pending')
    expect(started.flow).toMatchObject({ methodId: 'cloud', qrContent: 'mock://qr/1', phase: 'waiting' })

    provider.answers = [{ status: 'pending' }, { status: 'scanned' }]
    const scanned = await service.pollLogin(started.flow!.flowId)
    expect(scanned.outcome).toBe('scanned')
    expect(scanned.state.flow?.phase).toBe('scanned')

    provider.answers = [{ status: 'scanned' }, { status: 'confirmed', session: session() }]
    const done = await service.pollLogin(started.flow!.flowId)
    expect(done.outcome).toBe('ready')
    expect(done.state).toMatchObject({ status: 'ready', account: { id: 'u1', displayName: 'User One' }, methodId: 'cloud', capabilities: ['intranet', 'mail'] })
    expect(done.state.flow).toBeUndefined()
    expect(done.state.boundTools.every(t => t.active)).toBe(true)

    const file = JSON.parse(readFileSync(cred('code-host'), 'utf-8'))
    expect(file.token).toBe('secret-code-host-1')
    expect(statSync(cred('code-host')).mode & 0o777).toBe(0o600)
    expect(statSync(credDir).mode & 0o777).toBe(0o700)
    expect(JSON.stringify(done)).not.toContain('secret-')
    expect(logs.join('\n')).not.toContain('secret-')
  })

  it('only issues credentials for capabilities the session has', async () => {
    const service = newService()
    const done = await signIn(service, 'esb', session({ capabilities: ['intranet'] }))
    expect(done.outcome).toBe('ready')
    expect(provider.issued).toEqual(['code-host'])
    expect(existsSync(cred('mail'))).toBe(false)
    expect(done.state.boundTools).toEqual([
      { toolId: 'npm.gitbeaker', capability: 'intranet', active: true },
      { toolId: 'npm.mailer', capability: 'mail', active: false },
    ])
  })

  it('answers "pending" after the bounded wait', async () => {
    const service = newService({ pollWaitMs: 30 })
    const started = await service.beginLogin('cloud')
    expect((await service.pollLogin(started.flow!.flowId)).outcome).toBe('pending')
  })

  it.each(['denied', 'expired', 'cancelled'] as const)('ends the attempt when the service says %s', async status => {
    const service = newService()
    const started = await service.beginLogin('cloud')
    provider.answers = [{ status, message: 'from service' }]
    const result = await service.pollLogin(started.flow!.flowId)
    expect(result).toMatchObject({ outcome: status, message: 'from service', state: { status: 'signed-out' } })
    expect(result.state.flow).toBeUndefined()
    expect(existsSync(credDir)).toBe(false)
  })

  it('expires a code that outlived its time without asking the service', async () => {
    let now = Date.now()
    const service = newService({ now: () => now })
    const started = await service.beginLogin('cloud')
    now = started.flow!.expiresAt + 1
    const result = await service.pollLogin(started.flow!.flowId)
    expect(result.outcome).toBe('expired')
    expect(provider.cancelled).toEqual([started.flow!.flowId])
  })

  it('stops a waiting poll when the user cancels', async () => {
    const service = newService({ pollWaitMs: 2000 })
    const started = await service.beginLogin('cloud')
    const waiting = service.pollLogin(started.flow!.flowId)
    await sleep(20)
    const after = await service.cancelLogin(started.flow!.flowId)
    expect(after.status).toBe('signed-out')
    expect((await waiting).outcome).toBe('cancelled')
    expect(provider.cancelled).toEqual([started.flow!.flowId])
  })

  it('replaces an earlier attempt when a new one starts', async () => {
    const service = newService()
    const first = await service.beginLogin('cloud')
    const second = await service.beginLogin('esb')
    expect(provider.cancelled).toEqual([first.flow!.flowId])
    expect((await service.pollLogin(first.flow!.flowId)).outcome).toBe('cancelled')
    expect(second.flow!.methodId).toBe('esb')
  })

  it('treats a provider failure as a failed attempt', async () => {
    const service = newService()
    const started = await service.beginLogin('cloud')
    provider.pollLogin = async () => { throw new Error('network down') }
    const result = await service.pollLogin(started.flow!.flowId)
    expect(result.outcome).toBe('failed')
    expect(result.state.status).toBe('signed-out')
  })

  it('refuses a confirmation that is already over', async () => {
    const service = newService()
    const result = await signIn(service, 'cloud', session({ expiresAt: Date.now() - 1 }))
    expect(result.outcome).toBe('failed')
    expect(result.state.status).toBe('signed-out')
  })
})

describe('enterprise identity: session lifetime', () => {
  it('signs out: removes credentials first, then ends the session at the service', async () => {
    const service = newService()
    await signIn(service)
    expect(existsSync(cred('code-host'))).toBe(true)
    const state = await service.signOut()
    expect(state.status).toBe('signed-out')
    expect(state.account).toBeUndefined()
    expect(existsSync(credDir)).toBe(false)
    expect(provider.signOuts).toBe(1)
  })

  it('ends the session when it runs out and keeps the account for display', async () => {
    const service = newService()
    await signIn(service, 'cloud', session({ expiresAt: Date.now() + 120 }))
    expect(existsSync(cred('code-host'))).toBe(true)
    await sleep(250)
    const state = await service.getState()
    expect(state).toMatchObject({ status: 'expired', account: { id: 'u1' }, capabilities: [] })
    expect(state.boundTools.every(t => !t.active)).toBe(true)
    expect(existsSync(credDir)).toBe(false)
    expect(provider.signOuts).toBe(1)
  })

  it('renews a credential that ends before the session', async () => {
    provider.credentialLife = 1500
    const service = newService({ refreshMarginMs: 1000 })
    await signIn(service, 'esb', session({ capabilities: ['intranet'] }))
    expect(JSON.parse(readFileSync(cred('code-host'), 'utf-8')).token).toBe('secret-code-host-1')
    await sleep(1300)
    expect(JSON.parse(readFileSync(cred('code-host'), 'utf-8')).token).toBe('secret-code-host-2')
    await service.signOut()
  })

  it('never lets a credential outlive the session', async () => {
    const service = newService()
    const ends = Date.now() + 5_000
    await signIn(service, 'esb', session({ capabilities: ['intranet'], expiresAt: ends }))
    expect(JSON.parse(readFileSync(cred('code-host'), 'utf-8')).expiresAt).toBe(ends)
    await service.signOut()
  })

  it('reports a credential the service refused, and the tool stays without one', async () => {
    provider.failAudience = 'code-host'
    const service = newService()
    const result = await signIn(service, 'esb', session({ capabilities: ['intranet'] }))
    expect(result.state).toMatchObject({ status: 'ready', lastError: 'credential-failed' })
    expect(result.state.boundTools[0].active).toBe(false)
    expect(existsSync(cred('code-host'))).toBe(false)
  })

  it('drops a credential that arrives after sign-out', async () => {
    let release!: () => void
    provider.issueGate = new Promise(resolve => { release = resolve })
    const service = newService()
    const started = await service.beginLogin('esb')
    provider.answers = [{ status: 'confirmed', session: session({ capabilities: ['intranet'] }) }]
    const polling = service.pollLogin(started.flow!.flowId)
    await sleep(20)
    await service.signOut()
    release()
    await polling
    expect(existsSync(cred('code-host'))).toBe(false)
    expect((await service.getState()).status).toBe('signed-out')
  })

  it('withdraws every credential on dispose', async () => {
    const service = newService()
    await signIn(service)
    service.dispose()
    expect(existsSync(credDir)).toBe(false)
  })
})

describe('enterprise identity: tool bindings', () => {
  it('maps each usable binding to its credential file and drops unsafe audiences', () => {
    const bindings = toolCredentialBindings([
      ...BINDINGS,
      { toolId: 'bad', capability: 'intranet', audience: '../escape', env: 'X' },
    ], '/data/ei')
    expect(bindings).toEqual([
      { toolId: 'npm.gitbeaker', env: 'GITBEAKER_TOKEN', file: join('/data/ei', 'code-host.json'), staticEnv: { GITBEAKER_HOST: 'http://h' } },
      { toolId: 'npm.mailer', env: 'MAIL_TOKEN', file: join('/data/ei', 'mail.json') },
    ])
  })
})

/** Provider that can resume a session from authorization it still holds. */
class RestoringProvider extends FakeProvider {
  restoreCalls: string[] = []
  restoreResult: EnterpriseSession | 'renewal-required' | null = null
  restoreError: Error | null = null
  restoreGate: Promise<void> | null = null
  async restore(methodId: string) {
    this.restoreCalls.push(methodId)
    if (this.restoreGate) await this.restoreGate
    if (this.restoreError) throw this.restoreError
    return this.restoreResult
  }
}

describe('enterprise identity: resuming a sign-in after launch', () => {
  let marker: string
  let restoring: RestoringProvider
  let clock: number

  const writeMarker = (methodId = 'cloud') =>
    writeFileSync(marker, JSON.stringify({ methodId, account: { id: 'u1', displayName: 'User One' } }))
  const launch = (overrides: Partial<ConstructorParameters<typeof EnterpriseIdentityService>[0]> = {}) =>
    newService({ loadProvider: async () => restoring, sessionMarkerFile: marker, ...overrides })

  beforeEach(() => {
    marker = join(dir, 'enterprise-identity-session.json')
    restoring = new RestoringProvider()
    provider = restoring
    clock = Date.now()
  })

  it('remembers a sign-in without any credential, and forgets it on sign-out', async () => {
    const service = launch()
    await signIn(service)
    const saved = readFileSync(marker, 'utf-8')
    expect(JSON.parse(saved)).toEqual({ methodId: 'cloud', account: { id: 'u1', displayName: 'User One' } })
    expect(saved).not.toContain('secret')
    expect(statSync(marker).mode & 0o777).toBe(0o600)
    await service.signOut()
    expect(existsSync(marker)).toBe(false)
  })

  it('keeps the marker when the session runs out', async () => {
    const service = launch()
    await signIn(service, 'cloud', session({ expiresAt: Date.now() + 40 }))
    await sleep(80)
    expect((await service.getState()).status).toBe('expired')
    expect(existsSync(marker)).toBe(true)
  })

  it('does nothing without a marker', async () => {
    await launch().restoreSession()
    expect(restoring.restoreCalls).toEqual([])
  })

  it('resumes the last method and issues credentials as a scan would', async () => {
    writeMarker()
    restoring.restoreResult = session()
    const service = launch()
    await service.restoreSession()
    expect(restoring.restoreCalls).toEqual(['cloud'])
    const state = await service.getState()
    expect(state).toMatchObject({ status: 'ready', methodId: 'cloud', account: { id: 'u1' } })
    expect(state.boundTools.every(t => t.active)).toBe(true)
    expect(existsSync(cred('code-host'))).toBe(true)
  })

  it('shows the ended account when a new sign-in is required, keeping the marker', async () => {
    writeMarker()
    restoring.restoreResult = 'renewal-required'
    const service = launch()
    await service.restoreSession()
    expect(await service.getState()).toMatchObject({ status: 'expired', methodId: 'cloud', account: { id: 'u1', displayName: 'User One' } })
    expect(existsSync(marker)).toBe(true)
    expect(existsSync(credDir)).toBe(false)
  })

  it('forgets the marker when no authorization is left', async () => {
    writeMarker()
    const service = launch()
    await service.restoreSession()
    expect((await service.getState()).status).toBe('signed-out')
    expect(existsSync(marker)).toBe(false)
  })

  it('forgets a marker for a method the build no longer offers, or one it cannot read', async () => {
    writeMarker('gone')
    await launch().restoreSession()
    expect(restoring.restoreCalls).toEqual([])
    expect(existsSync(marker)).toBe(false)

    writeFileSync(marker, '{not json')
    await launch().restoreSession()
    expect(existsSync(marker)).toBe(false)
  })

  it('stays signed out when the service is unreachable and retries on a state read after the wait', async () => {
    writeMarker()
    restoring.restoreError = new Error('offline')
    const service = launch({ now: () => clock, restoreRetryMs: 1000 })
    await service.restoreSession()
    expect((await service.getState()).status).toBe('signed-out')
    expect(restoring.restoreCalls).toHaveLength(1)
    expect(existsSync(marker)).toBe(true)

    clock += 500
    await service.getState()
    expect(restoring.restoreCalls).toHaveLength(1)

    clock += 600
    restoring.restoreError = null
    restoring.restoreResult = session()
    expect((await service.getState()).status).toBe('ready')
    expect(restoring.restoreCalls).toHaveLength(2)
  })

  it('answers a state read within its wait while a restore is still under way', async () => {
    writeMarker()
    let release!: () => void
    restoring.restoreGate = new Promise<void>(resolve => { release = resolve })
    restoring.restoreResult = session()
    const service = launch({ restoreWaitMs: 20 })
    const work = service.restoreSession()
    expect((await service.getState()).status).toBe('signed-out')
    release()
    await work
    expect((await service.getState()).status).toBe('ready')
  })

  it('runs one restore at a time', async () => {
    writeMarker()
    restoring.restoreResult = session()
    const service = launch()
    await Promise.all([service.restoreSession(), service.restoreSession()])
    expect(restoring.restoreCalls).toHaveLength(1)
  })

  it('lets a sign-out during a restore win: no session, no marker, no credential', async () => {
    writeMarker()
    let release!: () => void
    restoring.restoreGate = new Promise<void>(resolve => { release = resolve })
    restoring.restoreResult = session()
    const service = launch()
    const work = service.restoreSession()
    await sleep(5)
    const out = service.signOut()
    release()
    await work
    expect((await out).status).toBe('signed-out')
    expect(restoring.signOuts).toBe(1)
    expect(existsSync(marker)).toBe(false)
    expect(existsSync(credDir)).toBe(false)
  })

  it('finishes a restore under way before starting a scan', async () => {
    writeMarker()
    let release!: () => void
    restoring.restoreGate = new Promise<void>(resolve => { release = resolve })
    restoring.restoreResult = session({ accountId: 'restored' })
    const service = launch({ restoreWaitMs: 5 })
    const work = service.restoreSession()
    const begun = service.beginLogin('esb')
    release()
    await work
    const state = await begun
    expect(state.status).toBe('ready')
    expect(state.account?.id).toBe('restored')
    expect(state.flow?.methodId).toBe('esb')
  })

  it('ignores the marker when the provider cannot restore', async () => {
    writeMarker()
    provider = new FakeProvider()
    const service = newService({ sessionMarkerFile: marker })
    await service.restoreSession()
    expect((await service.getState()).status).toBe('signed-out')
    expect(existsSync(marker)).toBe(true)
  })
})
