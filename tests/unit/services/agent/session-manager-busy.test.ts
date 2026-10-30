/**
 * isSessionBusy — the engine's own "must not be disturbed" check, exported for
 * callers outside the engine (cross-conversation delivery) so none of them
 * keeps a copy that can drift.
 */

import { describe, it, expect, vi, afterEach, afterAll } from 'vitest'

vi.mock('../../../../src/main/services/analytics/analytics.service', () => ({
  analytics: { track: vi.fn(), trackErrorSurface: vi.fn() }
}))
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp'), getAppPath: vi.fn(() => '/tmp/halo-test-app'), getVersion: vi.fn(() => '0.0.0'), isPackaged: false }
}))
const { createSession } = vi.hoisted(() => ({ createSession: vi.fn() }))
vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({
  createSession,
  getActiveEngine: vi.fn(() => 'anthropic'),
}))
const { startConsumer } = vi.hoisted(() => ({ startConsumer: vi.fn() }))
vi.mock('../../../../src/main/services/agent/session-consumer', () => ({ startConsumer }))
vi.mock('../../../../src/main/services/agent/conversation-sink', () => ({ createConversationSink: vi.fn() }))
vi.mock('../../../../src/main/services/agent/mcp-auth-state', () => ({ purgeStaleMcpOAuth: vi.fn(async () => {}) }))
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
  getSessionEngineId,
  closeAllV2Sessions,
  stopSessionCleanup,
  activeSessions,
  isSessionBusy,
  markTurnDispatched,
  markTurnInitReceived,
} from '../../../../src/main/services/agent/session-manager'

function fakeSession() {
  return { query: { transport: { isReady: () => true, onExit: () => () => {} } }, close: vi.fn() }
}

type Handle = { isRunning: boolean; turn: unknown; teamThoughts: unknown[] }

/** A session with a persistent consumer whose state the test controls. */
async function withConsumer(conversationId: string, state: Handle): Promise<void> {
  createSession.mockResolvedValueOnce(fakeSession())
  startConsumer.mockReturnValueOnce({
    get isRunning() { return state.isRunning },
    getActiveSessionState: () => state.turn,
    getTeamLifecycleThoughts: () => state.teamThoughts,
    stop: vi.fn(),
  })
  await getOrCreateV2Session('space', conversationId, { systemPrompt: 'p', model: 'm' }, undefined, undefined, {} as never)
}

/** A turn that spawned a team and has not disbanded it. */
const liveTeam = [{ type: 'tool_use', toolName: 'Agent', id: 't1', toolInput: { team_name: 'crew' } }]

afterEach(() => {
  closeAllV2Sessions()
  activeSessions.clear()
  createSession.mockReset()
  startConsumer.mockReset()
})

afterAll(() => {
  stopSessionCleanup()
})

describe('isSessionBusy', () => {
  it('is busy while a legacy in-flight entry exists', () => {
    activeSessions.set('conv-legacy', {} as never)
    expect(isSessionBusy('conv-legacy')).toBe(true)
  })

  it('is not busy without a session', () => {
    expect(isSessionBusy('conv-none')).toBe(false)
  })

  it('is busy after accepted dispatch and before native init', async () => {
    await withConsumer('conv-awaiting', { isRunning: true, turn: null, teamThoughts: [] })
    markTurnDispatched('conv-awaiting')
    expect(isSessionBusy('conv-awaiting')).toBe(true)
    markTurnInitReceived('conv-awaiting')
    expect(isSessionBusy('conv-awaiting')).toBe(false)
  })

  it('is busy while the consumer is processing a turn', async () => {
    await withConsumer('conv-turn', { isRunning: true, turn: { thoughts: [] }, teamThoughts: [] })
    expect(isSessionBusy('conv-turn')).toBe(true)
  })

  it('is not busy when the consumer is idle between turns with nothing running', async () => {
    await withConsumer('conv-idle', { isRunning: true, turn: null, teamThoughts: [] })
    expect(isSessionBusy('conv-idle')).toBe(false)
  })

  it('is busy when idle between turns while its team is still working', async () => {
    await withConsumer('conv-team', { isRunning: true, turn: null, teamThoughts: liveTeam })
    expect(isSessionBusy('conv-team')).toBe(true)
  })

  it('is not busy when the consumer has stopped', async () => {
    await withConsumer('conv-stopped', { isRunning: false, turn: { thoughts: [] }, teamThoughts: [] })
    expect(isSessionBusy('conv-stopped')).toBe(false)
  })
})

describe('session engine isolation', () => {
  it('keeps independent engines resident and preserves the other session when one closes', async () => {
    const halo = fakeSession()
    const cc = fakeSession()
    createSession.mockResolvedValueOnce(halo).mockResolvedValueOnce(cc)
    const first = await getOrCreateV2Session('space', 'parallel-halo', { engineId: 'halo', model: 'm' })
    const second = await getOrCreateV2Session('space', 'parallel-cc', { engineId: 'anthropic', model: 'm' })
    expect(getSessionEngineId('parallel-halo')).toBe('halo')
    expect(getSessionEngineId('parallel-cc')).toBe('anthropic')
    expect(await getOrCreateV2Session('space', 'parallel-halo', { engineId: 'halo', model: 'm' })).toBe(first)
    expect(second).not.toBe(first)
    expect(cc.close).not.toHaveBeenCalled()
  })

  it('rebuilds only the idle conversation whose engine changed', async () => {
    const original = fakeSession()
    const replacement = fakeSession()
    createSession.mockResolvedValueOnce(original).mockResolvedValueOnce(replacement)
    await getOrCreateV2Session('space', 'switch-idle', { engineId: 'halo', model: 'm' })
    expect(await getOrCreateV2Session('space', 'switch-idle', { engineId: 'codex', model: 'm' })).toBe(replacement)
    expect(original.close).toHaveBeenCalledOnce()
    expect(getSessionEngineId('switch-idle')).toBe('codex')
  })

  it('refuses an engine mismatch while retaining a leased session', async () => {
    const original = fakeSession()
    createSession.mockResolvedValueOnce(original)
    const lease = await acquireV2Session('space', 'switch-busy', { engineId: 'halo', model: 'm' })
    await expect(getOrCreateV2Session('space', 'switch-busy', { engineId: 'codex', model: 'm' })).rejects.toThrow('previous engine')
    expect(original.close).not.toHaveBeenCalled()
    expect(getSessionEngineId('switch-busy')).toBe('halo')
    lease.release()
  })

  it('pins late completion identity to the engine that created the consumer', async () => {
    const completed = vi.fn()
    const stopped = vi.fn()
    createSession.mockResolvedValueOnce(fakeSession())
    startConsumer.mockReturnValueOnce({ isRunning: true, stop: vi.fn(), getActiveSessionState: () => null, getTeamLifecycleThoughts: () => [] })
    await getOrCreateV2Session('space', 'bound-consumer', { engineId: 'codex', model: 'm' }, undefined, undefined, {
      displayModel: 'm', sink: { onTurnComplete: completed, onConsumerStopped: stopped },
    })
    const sink = startConsumer.mock.calls[0][1].sink
    sink.onTurnComplete({ finalContent: 'done', engineId: 'halo' })
    sink.onConsumerStopped({ finalContent: 'partial' })
    expect(completed).toHaveBeenCalledWith({ finalContent: 'done', engineId: 'codex' })
    expect(stopped).toHaveBeenCalledWith({ finalContent: 'partial', engineId: 'codex' })
  })

  it('hands history to the engine once without changing later user messages', async () => {
    const send = vi.fn(async () => {})
    createSession.mockResolvedValueOnce({ ...fakeSession(), send })
    const first = await acquireV2Session('space', 'handoff-once', { engineId: 'codex', model: 'm', engineHandoffContent: 'Previous completed work' })
    await first.send('Continue')
    markTurnInitReceived('handoff-once')
    const second = await acquireV2Session('space', 'handoff-once', { engineId: 'codex', model: 'm' })
    await second.send('Next task')
    expect(send.mock.calls).toEqual([['Previous completed work\n\nCurrent message:\nContinue'], ['Next task']])
  })
})
