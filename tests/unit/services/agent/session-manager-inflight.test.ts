/**
 * getOrCreateV2Session in-flight sharing vs. SessionGates.requireFreshInputs.
 *
 * The in-flight map exists so a warm-up racing the first send does not spawn
 * two CC processes for one conversation. But sharing happens BEFORE any
 * fingerprint/gate check, so a gated caller (delegated turn: the options ARE
 * the restriction) could be handed a creation built on somebody else's
 * permissions. The rule under test: a gated latecomer shares only when the
 * creation in flight was invoked with matching inputs; otherwise it waits the
 * creation out and re-evaluates against the finished session, where the
 * existing stale check rebuilds on its own options. Non-gated callers keep the
 * old behavior unchanged.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import type { AISource } from '../../../../src/shared/types/ai-sources'

vi.mock('../../../../src/main/services/analytics/analytics.service', () => ({
  analytics: { track: vi.fn(), trackErrorSurface: vi.fn() }
}))
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '0.0.0'),
    getAppPath: vi.fn(() => process.cwd()), isPackaged: false,
  }
}))
const { createSession, startConsumer, purgeStaleMcpOAuth } = vi.hoisted(() => ({
  createSession: vi.fn(),
  startConsumer: vi.fn(),
  purgeStaleMcpOAuth: vi.fn(async () => {}),
}))
vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({
  createSession,
  getActiveEngine: vi.fn(() => 'claude'),
}))
vi.mock('../../../../src/main/services/agent/session-consumer', () => ({ startConsumer }))
vi.mock('../../../../src/main/services/agent/conversation-sink', () => ({ createConversationSink: vi.fn() }))
vi.mock('../../../../src/main/services/agent/mcp-auth-state', () => ({ purgeStaleMcpOAuth }))
vi.mock('../../../../src/main/services/agent/events', () => ({ emitAgentEvent: vi.fn() }))
vi.mock('../../../../src/main/services/agent/reasoning-effort', () => ({ applySessionReasoningEffort: vi.fn(), pickReasoningEffort: vi.fn(() => undefined) }))
vi.mock('../../../../src/main/services/agent/knowledge-context', () => ({
  resolveConversationKnowledgeBases: vi.fn(() => []),
  resolveConversationKnowledgeBaseIds: vi.fn(() => []),
}))
vi.mock('../../../../src/main/services/agent/toolsets/broker', () => ({
  setSessionInvalidator: vi.fn(),
  buildCreationTimeServers: vi.fn(() => ({})),
}))
vi.mock('../../../../src/main/services/agent/toolsets/capability-index', () => ({ buildToolsetSection: vi.fn(() => '') }))
vi.mock('../../../../src/main/services/agent/toolsets/state', () => ({
  dropConversationState: vi.fn(),
  getOpenToolsets: vi.fn(() => []),
}))
vi.mock('../../../../src/main/services/api-ref', () => ({ HALO_API_TOOLSET_ID: 'halo-api-ref' }))
vi.mock('../../../../src/main/services/conversation.service', () => ({ getConversation: vi.fn(() => null) }))
vi.mock('../../../../src/main/services/health', () => ({
  registerProcess: vi.fn(),
  unregisterProcess: vi.fn(),
  getCurrentInstanceId: vi.fn(() => null),
}))

import {
  getOrCreateV2Session,
  acquireV2Session,
  isSessionBusy,
  evictIdleSession,
  closeAllV2Sessions,
  closeV2Session,
  stopSessionCleanup,
  v2Sessions,
  activeSessions,
  registerActiveSession,
  unregisterActiveSession,
  createSessionState,
  consumePendingRebuild,
  markTurnDispatched,
  markTurnInitReceived,
  SessionOptionsStaleError,
} from '../../../../src/main/services/agent/session-manager'
import { getConfig, saveConfig, getCredentialsGeneration } from '../../../../src/main/foundation/config.service'
import { encodeBackendConfig } from '../../../../src/main/openai-compat-router'

/** A session whose transport reads ready, so the reuse path exercises the fingerprint check. */
function fakeSession(label: string) {
  return {
    label,
    query: { transport: { isReady: () => true, onExit: () => () => {} } },
    close: vi.fn(),
    send: vi.fn((_message: unknown): void | Promise<void> => {}),
  }
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

afterEach(() => {
  closeAllV2Sessions()
  activeSessions.clear()
  createSession.mockReset()
  startConsumer.mockReset()
  purgeStaleMcpOAuth.mockReset().mockResolvedValue(undefined)
})

afterAll(() => {
  stopSessionCleanup()
})

describe('getOrCreateV2Session in-flight sharing', () => {
  it('a gated latecomer with DIFFERENT inputs does not share: it waits, then rebuilds on its own options', async () => {
    const conv = 'conv-gate-mismatch'
    const s1 = fakeSession('s1')
    const s2 = fakeSession('s2')
    const first = deferred<any>()
    createSession.mockImplementationOnce(() => first.promise).mockResolvedValueOnce(s2)

    const creator = getOrCreateV2Session('space', conv, { systemPrompt: 'creator prompt', model: 'm' })
    await flush()
    expect(createSession).toHaveBeenCalledTimes(1)

    let settled = false
    const latecomer = getOrCreateV2Session(
      'space', conv, { systemPrompt: 'delegated prompt', model: 'm', permissionMode: 'default' },
      undefined, undefined, undefined, undefined, undefined, undefined,
      { requireFreshInputs: true }
    ).then((s) => { settled = true; return s })

    // Not shared and not started: the latecomer is waiting the creation out.
    await flush()
    expect(settled).toBe(false)
    expect(createSession).toHaveBeenCalledTimes(1)

    first.resolve(s1)
    await expect(creator).resolves.toBe(s1)
    // Re-entry lands on the finished session, whose inputs fingerprint does not
    // match → the existing stale path rebuilds with the latecomer's options.
    await expect(latecomer).resolves.toBe(s2)
    expect(createSession).toHaveBeenCalledTimes(2)
    expect(createSession.mock.calls[1][0].systemPrompt).toBe('delegated prompt')
    expect(s1.close).toHaveBeenCalled()
  })

  it('a gated latecomer with MATCHING inputs shares the creation in flight', async () => {
    const conv = 'conv-gate-match'
    const s1 = fakeSession('s1')
    const first = deferred<any>()
    createSession.mockImplementationOnce(() => first.promise)

    const options = { systemPrompt: 'same prompt', model: 'm', permissionMode: 'default' }
    const creator = getOrCreateV2Session('space', conv, { ...options })
    await flush()
    const latecomer = getOrCreateV2Session(
      'space', conv, { ...options },
      undefined, undefined, undefined, undefined, undefined, undefined,
      { requireFreshInputs: true }
    )

    first.resolve(s1)
    await expect(creator).resolves.toBe(s1)
    await expect(latecomer).resolves.toBe(s1)
    expect(createSession).toHaveBeenCalledTimes(1)
  })

  it('a NON-gated latecomer shares even when its options differ (pre-existing behavior)', async () => {
    const conv = 'conv-ungated'
    const s1 = fakeSession('s1')
    const first = deferred<any>()
    createSession.mockImplementationOnce(() => first.promise)

    const creator = getOrCreateV2Session('space', conv, { systemPrompt: 'A', model: 'm' })
    await flush()
    const latecomer = getOrCreateV2Session('space', conv, { systemPrompt: 'B', model: 'm' })

    first.resolve(s1)
    await expect(creator).resolves.toBe(s1)
    await expect(latecomer).resolves.toBe(s1)
    expect(createSession).toHaveBeenCalledTimes(1)
  })

  it('a gated latecomer never shares a lazy-MCP creation (its inputs cannot be verified)', async () => {
    const conv = 'conv-lazy'
    const s1 = fakeSession('s1')
    const s2 = fakeSession('s2')
    const first = deferred<any>()
    createSession.mockImplementationOnce(() => first.promise).mockResolvedValueOnce(s2)

    const options = { systemPrompt: 'same prompt', model: 'm' }
    // Main-chat style creation: MCP servers built lazily → no eager fingerprint.
    const creator = getOrCreateV2Session(
      'space', conv, { ...options },
      undefined, undefined, undefined, undefined,
      () => ({})
    )
    await flush()
    const latecomer = getOrCreateV2Session(
      'space', conv, { ...options },
      undefined, undefined, undefined, undefined, undefined, undefined,
      { requireFreshInputs: true }
    )

    await flush()
    expect(createSession).toHaveBeenCalledTimes(1)

    first.resolve(s1)
    await expect(creator).resolves.toBe(s1)
    // The finished session carries no inputs fingerprint either → stale path rebuilds.
    await expect(latecomer).resolves.toBe(s2)
    expect(createSession).toHaveBeenCalledTimes(2)
  })
})

function account(id: string): AISource {
  return {
    id, name: id, provider: 'chatgpt', authType: 'oauth',
    apiUrl: 'https://example.invalid', accessToken: `test-${id}`, model: 'gpt-test',
    availableModels: [{ id: 'gpt-test', name: 'Test' }],
    createdAt: '2026-01-01', updatedAt: '2026-01-01',
  }
}

function accountOptions(sourceId: string, key = `test-${sourceId}`, marker = true) {
  return {
    model: 'gpt-test', systemPrompt: 'same prompt',
    env: {
      ...(marker ? { HALO_AI_SOURCE_ID: sourceId } : {}),
      ANTHROPIC_API_KEY: encodeBackendConfig({
        sourceId, url: 'https://example.invalid', key, model: 'gpt-test', apiType: 'responses',
      }),
    },
  }
}

/** A change sessions must follow; a bare token rotation is not one (the router supplies it per request). */
function reconfigure(sourceId: string): void {
  updateAccount(sourceId, { apiUrl: `https://reconfigured-${sourceId}.invalid` })
}

function updateAccount(sourceId: string, updates: Partial<AISource>): void {
  const aiSources = getConfig().aiSources!
  saveConfig({ aiSources: {
    ...aiSources, sources: aiSources.sources.map(source => source.id === sourceId ? { ...source, ...updates } : source),
  } })
}

describe('independent account session lifecycle', () => {
  beforeEach(async () => {
    saveConfig({ aiSources: {
      version: 2, currentId: 'account-a', sources: [account('account-a'), account('account-b')],
    } })
    await flush()
  })

  it.each(['reconfigure', 'logout'])('%s invalidates only the affected account session', async (change) => {
    const first = fakeSession('account-a')
    const second = fakeSession('account-b')
    createSession.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    await getOrCreateV2Session('space', 'conv-a', accountOptions('account-a'))
    await getOrCreateV2Session('space', 'conv-b', accountOptions('account-b', undefined, false))
    expect(v2Sessions.get('conv-b')?.sourceId).toBe('account-b')
    const otherGeneration = getCredentialsGeneration('account-b')

    if (change === 'reconfigure') {
      reconfigure('account-a')
    } else {
      const aiSources = getConfig().aiSources!
      saveConfig({ aiSources: { ...aiSources, sources: aiSources.sources.filter(source => source.id !== 'account-a') } })
    }
    await flush()
    expect(first.close).toHaveBeenCalledTimes(1)
    expect(second.close).not.toHaveBeenCalled()
    expect(v2Sessions.has('conv-a')).toBe(false)
    expect(getCredentialsGeneration('account-b')).toBe(otherGeneration)
    await expect(getOrCreateV2Session('space', 'conv-b', accountOptions('account-b', undefined, false))).resolves.toBe(second)
    expect(createSession).toHaveBeenCalledTimes(2)
  })

  it('keeps every session when an account token or model-session token rotates', async () => {
    const first = fakeSession('account-a')
    const second = fakeSession('account-b')
    createSession.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    const options = (token: string, sessionToken: string) => ({
      ...accountOptions('account-a', token),
      env: {
        HALO_AI_SOURCE_ID: 'account-a',
        ANTHROPIC_API_KEY: encodeBackendConfig({
          sourceId: 'account-a', url: 'https://example.invalid', key: token,
          model: 'gpt-test', apiType: 'chat_completions', headers: { 'copilot-session-token': sessionToken },
        }),
      },
    })
    const generation = getCredentialsGeneration('account-a')
    await getOrCreateV2Session('space', 'conv-a', options('test-account-a', 'test-session-a'))
    await getOrCreateV2Session('space', 'conv-b', accountOptions('account-b'))
    updateAccount('account-a', { accessToken: 'test-refreshed-a', refreshToken: 'test-next-a', tokenExpires: 1 })
    await flush()
    expect(getCredentialsGeneration('account-a')).toBe(generation)
    await expect(getOrCreateV2Session('space', 'conv-a', options('test-refreshed-a', 'test-session-b'))).resolves.toBe(first)
    await expect(getOrCreateV2Session('space', 'conv-b', accountOptions('account-b'))).resolves.toBe(second)
    expect(first.close).not.toHaveBeenCalled()
    expect(second.close).not.toHaveBeenCalled()
    expect(createSession).toHaveBeenCalledTimes(2)
  })

  it('a selection-only change retains both account sessions and closes only untagged legacy sessions', async () => {
    const first = fakeSession('account-a')
    const second = fakeSession('account-b')
    const legacy = fakeSession('legacy')
    createSession.mockResolvedValueOnce(first).mockResolvedValueOnce(second).mockResolvedValueOnce(legacy)
    await getOrCreateV2Session('space', 'conv-a', accountOptions('account-a'))
    await getOrCreateV2Session('space', 'conv-b', accountOptions('account-b'))
    await getOrCreateV2Session('space', 'conv-legacy', { model: 'gpt-test', systemPrompt: 'p' })
    const aiSources = getConfig().aiSources!
    saveConfig({ aiSources: { ...aiSources, currentId: 'account-b' } })
    await flush()

    expect(first.close).not.toHaveBeenCalled()
    expect(second.close).not.toHaveBeenCalled()
    expect(legacy.close).toHaveBeenCalledTimes(1)
    await expect(getOrCreateV2Session('space', 'conv-a', accountOptions('account-a'))).resolves.toBe(first)
    await expect(getOrCreateV2Session('space', 'conv-b', accountOptions('account-b'))).resolves.toBe(second)
  })

  it.each(['mcp-auth', 'sdk'])('captures the epoch before asynchronous %s creation and rebuilds stale options', async (stage) => {
    const first = fakeSession('old-a')
    const replacement = fakeSession('new-a')
    const creation = deferred<ReturnType<typeof fakeSession>>()
    const purge = deferred<void>()
    if (stage === 'mcp-auth') {
      purgeStaleMcpOAuth.mockReturnValueOnce(purge.promise)
      createSession.mockResolvedValueOnce(first)
    } else {
      createSession.mockReturnValueOnce(creation.promise)
    }
    createSession.mockResolvedValueOnce(replacement)
    const before = getCredentialsGeneration('account-a')
    const pending = getOrCreateV2Session('space', 'conv-racing-a', accountOptions('account-a'))
    await flush()
    expect(purgeStaleMcpOAuth).toHaveBeenCalledTimes(1)

    reconfigure('account-a')
    await flush()
    if (stage === 'mcp-auth') purge.resolve()
    else creation.resolve(first)
    await expect(pending).resolves.toBe(first)
    expect(v2Sessions.get('conv-racing-a')?.credentialsGeneration).toBe(before)
    expect(before).not.toBe(getCredentialsGeneration('account-a'))
    await expect(getOrCreateV2Session('space', 'conv-racing-a', accountOptions('account-a', 'test-refreshed-a'))).resolves.toBe(replacement)
    expect(first.close).toHaveBeenCalledTimes(1)
  })

  it('preserves the credential snapshot generation when config changes before entering session creation', async () => {
    const first = fakeSession('old-a')
    const replacement = fakeSession('new-a')
    createSession.mockResolvedValueOnce(first).mockResolvedValueOnce(replacement)
    const before = getCredentialsGeneration('account-a')
    const options = { ...accountOptions('account-a'), credentialsGeneration: before }
    reconfigure('account-a')
    await flush()
    await getOrCreateV2Session('space', 'conv-snapshot-a', options)
    expect(v2Sessions.get('conv-snapshot-a')?.credentialsGeneration).toBe(before)
    await expect(getOrCreateV2Session('space', 'conv-snapshot-a', accountOptions('account-a', 'test-refreshed-a'))).resolves.toBe(replacement)
    expect(first.close).toHaveBeenCalledTimes(1)
  })

  it('reconfiguring another account does not stale a session being created', async () => {
    const first = fakeSession('account-a')
    const creation = deferred<ReturnType<typeof fakeSession>>()
    createSession.mockReturnValueOnce(creation.promise)
    const pending = getOrCreateV2Session('space', 'conv-racing-a', accountOptions('account-a'))
    await flush()
    reconfigure('account-b')
    await flush()
    creation.resolve(first)
    await pending

    expect(consumePendingRebuild('conv-racing-a')).toBe(false)
    await expect(getOrCreateV2Session('space', 'conv-racing-a', accountOptions('account-a'))).resolves.toBe(first)
    expect(first.close).not.toHaveBeenCalled()
    expect(createSession).toHaveBeenCalledTimes(1)
  })

  it('keeps a legacy active turn until unregistering it, without disturbing another account', async () => {
    const first = fakeSession('account-a')
    const second = fakeSession('account-b')
    createSession.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    await getOrCreateV2Session('space', 'conv-a', accountOptions('account-a'))
    await getOrCreateV2Session('space', 'conv-b', accountOptions('account-b'))
    registerActiveSession('conv-a', createSessionState('space', 'conv-a', new AbortController()))
    reconfigure('account-a')
    await flush()

    await expect(getOrCreateV2Session('space', 'conv-a', accountOptions('account-a', 'test-refreshed-a'))).resolves.toBe(first)
    expect(first.close).not.toHaveBeenCalled()
    unregisterActiveSession('conv-a')
    expect(first.close).toHaveBeenCalledTimes(1)
    expect(second.close).not.toHaveBeenCalled()
  })

  it('releases a managed headless execution once without retaining an invalidation for its next resume', async () => {
    const first = fakeSession('account-a')
    const second = fakeSession('account-b')
    const resumed = fakeSession('resumed-a')
    createSession.mockResolvedValueOnce(first).mockResolvedValueOnce(second).mockResolvedValueOnce(resumed)
    await getOrCreateV2Session('space', 'run-a', accountOptions('account-a'))
    await getOrCreateV2Session('space', 'run-b', accountOptions('account-b'))
    registerActiveSession('run-a', createSessionState('space', 'run-a', new AbortController()))
    reconfigure('account-a')
    await flush()
    expect(first.close).not.toHaveBeenCalled()
    expect(second.close).not.toHaveBeenCalled()

    closeV2Session('run-a')
    unregisterActiveSession('run-a')
    expect(first.close).toHaveBeenCalledTimes(1)
    expect(v2Sessions.has('run-a')).toBe(false)
    expect(activeSessions.has('run-a')).toBe(false)
    await getOrCreateV2Session('space', 'run-a', accountOptions('account-a', 'test-refreshed-a'))
    registerActiveSession('run-a', createSessionState('space', 'run-a', new AbortController()))
    unregisterActiveSession('run-a')
    expect(resumed.close).not.toHaveBeenCalled()
    expect(second.close).not.toHaveBeenCalled()
  })

  it.each(['turn', 'awaiting-init', 'team', 'background'])('defers an account change at the %s boundary until safely idle', async (boundary) => {
    const first = fakeSession('old-a')
    const replacement = fakeSession('new-a')
    const state = {
      turn: boundary === 'turn' ? { thoughts: [] } : null,
      background: boundary === 'background',
      teamThoughts: boundary === 'team'
        ? [{ type: 'tool_use', toolName: 'Agent', id: 'task', toolInput: { team_name: 'crew' } }]
        : [],
    }
    startConsumer.mockReturnValueOnce({
      isRunning: true, getActiveSessionState: () => state.turn,
      getTeamLifecycleThoughts: () => state.teamThoughts, hasRunningTasks: () => state.background, stop: vi.fn(),
    })
    createSession.mockResolvedValueOnce(first).mockResolvedValueOnce(replacement)
    await getOrCreateV2Session('space', 'conv-busy-a', accountOptions('account-a'), undefined, undefined, {} as never)
    if (boundary === 'awaiting-init') markTurnDispatched('conv-busy-a')
    reconfigure('account-a')
    await flush()
    await expect(getOrCreateV2Session('space', 'conv-busy-a', accountOptions('account-a', 'test-refreshed-a'))).resolves.toBe(first)
    expect(first.close).not.toHaveBeenCalled()

    state.turn = null
    state.teamThoughts = []
    state.background = false
    markTurnInitReceived('conv-busy-a')
    await expect(getOrCreateV2Session('space', 'conv-busy-a', accountOptions('account-a', 'test-refreshed-a'))).resolves.toBe(replacement)
    expect(first.close).toHaveBeenCalledTimes(1)
  })

  it.each(['turn', 'background'])('a gated caller defers a same-account credential change at the %s boundary and refuses only changed inputs', async (boundary) => {
    const first = fakeSession('gated-a')
    const replacement = fakeSession('gated-a-refreshed')
    const state = { turn: boundary === 'turn' ? { thoughts: [] } : null, background: boundary === 'background' }
    startConsumer.mockReturnValueOnce({
      isRunning: true, getActiveSessionState: () => state.turn,
      getTeamLifecycleThoughts: () => [], hasRunningTasks: () => state.background, stop: vi.fn(),
    })
    createSession.mockResolvedValueOnce(first).mockResolvedValueOnce(replacement)
    const gated = (options: Record<string, unknown>) => getOrCreateV2Session(
      'space', 'conv-gated-a', options, undefined, undefined, undefined, undefined, undefined, undefined, { requireFreshInputs: true }
    )
    await getOrCreateV2Session('space', 'conv-gated-a', accountOptions('account-a'), undefined, undefined, {} as never)
    reconfigure('account-a')
    await flush()
    const refreshed = accountOptions('account-a', 'test-refreshed-a')

    await expect(gated(refreshed)).resolves.toBe(first)
    await expect(gated({ ...refreshed, systemPrompt: 'Changed caller context' })).rejects.toBeInstanceOf(SessionOptionsStaleError)
    expect(first.close).not.toHaveBeenCalled()

    state.turn = null
    state.background = false
    await expect(gated(refreshed)).resolves.toBe(replacement)
    expect(first.close).toHaveBeenCalledTimes(1)
  })

  it('background work blocks fingerprint-only rebuild, source switches and restricted reuse even after lease release', async () => {
    const first = fakeSession('background-a')
    const replacement = fakeSession('after-background-a')
    let background = true
    startConsumer.mockReturnValueOnce({
      isRunning: true, getActiveSessionState: () => null,
      getTeamLifecycleThoughts: () => [], hasRunningTasks: () => background, stop: vi.fn(),
    })
    createSession.mockResolvedValueOnce(first).mockResolvedValueOnce(replacement)
    const initial = accountOptions('account-a')
    await getOrCreateV2Session('space', 'conv-background', initial, undefined, undefined, {} as never)
    const changed = { ...initial, systemPrompt: 'Changed caller context' }
    await expect(getOrCreateV2Session('space', 'conv-background', changed)).resolves.toBe(first)
    const lease = await acquireV2Session('space', 'conv-background', changed)
    lease.release()
    expect(first.close).not.toHaveBeenCalled()
    expect(consumePendingRebuild('conv-background')).toBe(false)
    await expect(getOrCreateV2Session('space', 'conv-background', accountOptions('account-b'))).rejects.toBeInstanceOf(SessionOptionsStaleError)
    await expect(getOrCreateV2Session('space', 'conv-background', changed, undefined, undefined, undefined, undefined, undefined, undefined, { requireFreshInputs: true })).rejects.toBeInstanceOf(SessionOptionsStaleError)
    expect(first.close).not.toHaveBeenCalled()
    background = false
    await expect(getOrCreateV2Session('space', 'conv-background', changed)).resolves.toBe(replacement)
    expect(first.close).toHaveBeenCalledTimes(1)
  })

  it('keeps a second accepted message awaiting init after the first was acknowledged', async () => {
    const first = fakeSession('queued-a')
    createSession.mockResolvedValueOnce(first)
    const failures = [vi.fn(), vi.fn()]
    const acquire = (failure: typeof failures[number]) => acquireV2Session('space', 'conv-queued', accountOptions('account-a'), undefined, undefined, undefined, undefined, undefined, undefined, undefined, failure)
    const firstLease = await acquire(failures[0])
    const secondLease = await acquire(failures[1])
    await firstLease.send('First message')
    await secondLease.send('Second message')
    markTurnInitReceived('conv-queued')
    expect(evictIdleSession('conv-queued', 'fixture unacknowledged second turn')).toBe(false)
    markTurnInitReceived('conv-queued')
    expect(evictIdleSession('conv-queued', 'fixture both turns acknowledged')).toBe(true)
    expect(failures.every(failure => failure.mock.calls.length === 0)).toBe(true)
  })

  it('a late caller selecting another account never shares the in-flight account session', async () => {
    const first = fakeSession('account-a')
    const second = fakeSession('account-b')
    const creation = deferred<ReturnType<typeof fakeSession>>()
    createSession.mockReturnValueOnce(creation.promise).mockResolvedValueOnce(second)
    const creator = getOrCreateV2Session('space', 'conv-switch', accountOptions('account-a'))
    await flush()
    const latecomer = getOrCreateV2Session('space', 'conv-switch', accountOptions('account-b'))
    creation.resolve(first)
    await expect(creator).resolves.toBe(first)
    await expect(latecomer).resolves.toBe(second)
    expect(first.close).toHaveBeenCalledTimes(1)
    expect(v2Sessions.get('conv-switch')?.sourceId).toBe('account-b')
  })

  it.each(['new', 'reused', 'shared-warmup'] as const)('protects a %s acquisition before handing it to the sender', async kind => {
    const first = fakeSession('account-a')
    const other = fakeSession('account-b')
    const replacement = fakeSession('refreshed-a')
    createSession.mockResolvedValueOnce(other)
    await getOrCreateV2Session('space', 'conv-b', accountOptions('account-b'))
    let warm: Promise<unknown> | undefined
    const creation = deferred<ReturnType<typeof fakeSession>>()
    if (kind === 'shared-warmup') {
      createSession.mockReturnValueOnce(creation.promise)
      warm = getOrCreateV2Session('space', 'conv-a', accountOptions('account-a'))
      await flush()
    } else {
      createSession.mockResolvedValueOnce(first)
      if (kind === 'reused') await getOrCreateV2Session('space', 'conv-a', accountOptions('account-a'))
    }
    const pending = acquireV2Session('space', 'conv-a', accountOptions('account-a')).then(lease => {
      expect(isSessionBusy('conv-a')).toBe(true)
      reconfigure('account-a')
      return lease
    })
    if (kind === 'shared-warmup') creation.resolve(first)
    const lease = await pending
    await warm
    await flush()
    expect(first.close).not.toHaveBeenCalled()
    expect(other.close).not.toHaveBeenCalled()
    expect(evictIdleSession('conv-a', 'test budget')).toBe(false)
    expect(consumePendingRebuild('conv-a')).toBe(false)
    await expect(getOrCreateV2Session('space', 'conv-a', accountOptions('account-b'))).rejects.toBeInstanceOf(SessionOptionsStaleError)
    await expect(getOrCreateV2Session('space', 'conv-a', accountOptions('account-a', 'test-refreshed-a'))).resolves.toBe(first)
    await lease.send('original turn')
    lease.release()
    expect(first.send).toHaveBeenCalledWith('original turn')
    expect(first.close).not.toHaveBeenCalled()
    expect(consumePendingRebuild('conv-a')).toBe(false)
    markTurnInitReceived('conv-a')
    createSession.mockResolvedValueOnce(replacement)
    await expect(getOrCreateV2Session('space', 'conv-a', accountOptions('account-a', 'test-refreshed-a'))).resolves.toBe(replacement)
    expect(first.close).toHaveBeenCalledTimes(1)
    expect(other.close).not.toHaveBeenCalled()
  })

  it('establishes a sender lease before a different-source waiter resumes from creation', async () => {
    const first = fakeSession('account-a')
    const creation = deferred<ReturnType<typeof fakeSession>>()
    createSession.mockReturnValueOnce(creation.promise)
    const sender = acquireV2Session('space', 'conv-handoff', accountOptions('account-a'))
    await flush()
    const latecomer = getOrCreateV2Session('space', 'conv-handoff', accountOptions('account-b'))
    const refused = expect(latecomer).rejects.toBeInstanceOf(SessionOptionsStaleError)
    creation.resolve(first)
    const lease = await sender
    await refused
    expect(first.close).not.toHaveBeenCalled()
    await lease.send('original turn')
    expect(first.send).toHaveBeenCalledWith('original turn')
    expect(createSession).toHaveBeenCalledTimes(1)
  })

  it('refuses restricted inputs while an acquired turn is still preparing', async () => {
    const first = fakeSession('account-a')
    createSession.mockResolvedValueOnce(first)
    const lease = await acquireV2Session('space', 'conv-restricted', accountOptions('account-a'))
    await expect(acquireV2Session(
      'space', 'conv-restricted', { ...accountOptions('account-a'), permissionMode: 'default' },
      undefined, undefined, undefined, undefined, undefined, undefined, { requireFreshInputs: true }
    )).rejects.toBeInstanceOf(SessionOptionsStaleError)
    expect(first.close).not.toHaveBeenCalled()
    await lease.send('original unrestricted turn')
    expect(first.send).toHaveBeenCalledWith('original unrestricted turn')
  })

  it('waits for every preparation holder before consuming an invalidation', async () => {
    const first = fakeSession('account-a')
    createSession.mockResolvedValueOnce(first)
    const [one, two] = await Promise.all([
      acquireV2Session('space', 'conv-holders', accountOptions('account-a')),
      acquireV2Session('space', 'conv-holders', accountOptions('account-a')),
    ])
    reconfigure('account-a')
    await flush()
    one.release()
    one.close()
    expect(first.close).not.toHaveBeenCalled()
    expect(isSessionBusy('conv-holders')).toBe(true)
    expect(consumePendingRebuild('conv-holders')).toBe(false)
    two.release()
    expect(first.close).toHaveBeenCalledTimes(1)
    expect(isSessionBusy('conv-holders')).toBe(false)
    expect(consumePendingRebuild('conv-holders')).toBe(false)
  })

  it('refuses a stale lease without closing or unprotecting its replacement', async () => {
    const first = fakeSession('account-a')
    const replacement = fakeSession('account-b')
    createSession.mockResolvedValueOnce(first).mockResolvedValueOnce(replacement)
    const original = await acquireV2Session('space', 'conv-replaced', accountOptions('account-a'))
    closeV2Session('conv-replaced')
    const next = await acquireV2Session('space', 'conv-replaced', accountOptions('account-b'))
    await expect(original.send('late turn')).rejects.toThrow('no longer available')
    original.close()
    original.release()
    expect(replacement.close).not.toHaveBeenCalled()
    expect(replacement.send).not.toHaveBeenCalled()
    expect(isSessionBusy('conv-replaced')).toBe(true)
    next.release()
    expect(isSessionBusy('conv-replaced')).toBe(false)
  })

  it('keeps a manager-owned headless lease protected until the execution release boundary', async () => {
    const first = fakeSession('account-a')
    createSession.mockResolvedValueOnce(first)
    const lease = await acquireV2Session('space', 'run-lease', accountOptions('account-a'))
    reconfigure('account-a')
    await flush()
    expect(first.close).not.toHaveBeenCalled()
    registerActiveSession('run-lease', createSessionState('space', 'run-lease', new AbortController()))
    lease.session.send('headless turn')
    expect(consumePendingRebuild('run-lease')).toBe(false)
    expect(evictIdleSession('run-lease', 'budget')).toBe(false)
    expect(first.close).not.toHaveBeenCalled()
    lease.close()
    lease.release()
    unregisterActiveSession('run-lease')
    expect(first.close).toHaveBeenCalledTimes(1)
    expect(activeSessions.has('run-lease')).toBe(false)
    expect(isSessionBusy('run-lease')).toBe(false)
  })

  it('cleans up a failed dispatch exactly once without leaving awaiting-init protection', async () => {
    const first = fakeSession('account-a')
    createSession.mockResolvedValueOnce(first)
    const lease = await acquireV2Session('space', 'conv-send-error', accountOptions('account-a'))
    first.send.mockImplementationOnce(() => { throw new Error('broken transport') })
    await expect(lease.send('turn')).rejects.toThrow('broken transport')
    lease.close()
    lease.release()
    expect(first.close).toHaveBeenCalledTimes(1)
    expect(isSessionBusy('conv-send-error')).toBe(false)
    expect(v2Sessions.has('conv-send-error')).toBe(false)
  })

  it('reports an owned rejection before cleanup and rethrows the original error', async () => {
    const first = fakeSession('account-a')
    const error = new Error('owned transport rejection')
    first.send.mockImplementationOnce(() => Promise.reject(error))
    createSession.mockResolvedValueOnce(first)
    const lease = await acquireV2Session('space', 'conv-owned-failure', accountOptions('account-a'))
    const report = vi.fn((failure: unknown) => {
      expect(failure).toBe(error)
      expect(lease.isCurrent).toBe(true)
      expect(v2Sessions.get('conv-owned-failure')?.session).toBe(first)
      expect(first.close).not.toHaveBeenCalled()
    })
    await expect(lease.send('turn', report)).rejects.toBe(error)
    expect(report).toHaveBeenCalledTimes(1)
    expect(first.close).toHaveBeenCalledTimes(1)
    expect(lease.isCurrent).toBe(false)
  })

  it('retains instance ownership after releasing its successful dispatch reservation', async () => {
    const first = fakeSession('account-a')
    createSession.mockResolvedValueOnce(first)
    const lease = await acquireV2Session('space', 'conv-released-owner', accountOptions('account-a'))
    await lease.send('turn')
    expect(lease.isCurrent).toBe(true)
    closeV2Session('conv-released-owner')
    expect(lease.isCurrent).toBe(false)
  })

  it('holds dispatch protection until SDK acceptance, even if init arrived first', async () => {
    const first = fakeSession('account-a')
    const acceptance = deferred<void>()
    first.send.mockReturnValueOnce(acceptance.promise)
    createSession.mockResolvedValueOnce(first)
    const lease = await acquireV2Session('space', 'conv-acceptance', accountOptions('account-a'))
    let settled = false
    const dispatched = lease.send('turn').finally(() => { settled = true })
    markTurnInitReceived('conv-acceptance')
    reconfigure('account-a')
    await flush()
    expect(settled).toBe(false)
    expect(first.close).not.toHaveBeenCalled()
    expect(isSessionBusy('conv-acceptance')).toBe(true)
    expect(evictIdleSession('conv-acceptance', 'pending SDK acceptance')).toBe(false)
    expect(consumePendingRebuild('conv-acceptance')).toBe(false)
    acceptance.resolve()
    await dispatched
    expect(first.close).toHaveBeenCalledTimes(1)
    expect(isSessionBusy('conv-acceptance')).toBe(false)
    expect(v2Sessions.has('conv-acceptance')).toBe(false)
  })

  it.each(['Error', 'AbortError'])('cleans up an asynchronous %s dispatch rejection exactly once', async name => {
    const first = fakeSession('account-a')
    const error = Object.assign(new Error('rejected transport'), { name })
    first.send.mockImplementationOnce(() => Promise.reject(error))
    createSession.mockResolvedValueOnce(first)
    const lease = await acquireV2Session('space', 'conv-send-rejection', accountOptions('account-a'))
    await expect(lease.send('turn')).rejects.toBe(error)
    lease.close()
    lease.release()
    expect(first.close).toHaveBeenCalledTimes(1)
    expect(isSessionBusy('conv-send-rejection')).toBe(false)
    expect(v2Sessions.has('conv-send-rejection')).toBe(false)
    expect(consumePendingRebuild('conv-send-rejection')).toBe(false)
    await expect(lease.send('retry')).rejects.toThrow('no longer available')
  })

  it.each(['Error', 'AbortError'])('retains a successor lease when the predecessor dispatch rejects with %s', async name => {
    const first = fakeSession('account-a')
    const replacement = fakeSession('account-b')
    const acceptance = deferred<void>()
    const error = Object.assign(new Error('obsolete send rejected'), { name })
    first.send.mockReturnValueOnce(acceptance.promise)
    createSession.mockResolvedValueOnce(first).mockResolvedValueOnce(replacement)
    const lease = await acquireV2Session('space', 'conv-rejected-successor', accountOptions('account-a'))
    const report = vi.fn()
    const dispatched = lease.send('old turn', report)
    const refused = expect(dispatched).rejects.toBe(error)
    closeV2Session('conv-rejected-successor')
    const next = await acquireV2Session('space', 'conv-rejected-successor', accountOptions('account-b'))
    reconfigure('account-b')
    await flush()
    acceptance.reject(error)
    await refused
    expect(report).not.toHaveBeenCalled()
    expect(lease.isCurrent).toBe(false)
    expect(next.isCurrent).toBe(true)
    lease.close()
    lease.release()
    expect(first.close).toHaveBeenCalledTimes(1)
    expect(replacement.close).not.toHaveBeenCalled()
    expect(v2Sessions.get('conv-rejected-successor')?.session).toBe(replacement)
    expect(isSessionBusy('conv-rejected-successor')).toBe(true)
    expect(consumePendingRebuild('conv-rejected-successor')).toBe(false)
    next.release()
    expect(replacement.close).toHaveBeenCalledTimes(1)
  })

  it('refuses another account while the existing account turn is busy', async () => {
    const first = fakeSession('account-a')
    createSession.mockResolvedValueOnce(first)
    await getOrCreateV2Session('space', 'conv-switch-busy', accountOptions('account-a'))
    registerActiveSession('conv-switch-busy', createSessionState('space', 'conv-switch-busy', new AbortController()))
    const refused = getOrCreateV2Session('space', 'conv-switch-busy', accountOptions('account-b'))
    await expect(refused).rejects.toBeInstanceOf(SessionOptionsStaleError)
    await expect(refused).rejects.toThrow('still busy on its previous account')
    expect(first.close).not.toHaveBeenCalled()
  })
})
