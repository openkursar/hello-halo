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
  app: { getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '0.0.0'), isPackaged: false }
}))
const { createSession } = vi.hoisted(() => ({ createSession: vi.fn() }))
vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({
  createSession,
  getActiveEngine: vi.fn(() => 'claude'),
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
  closeAllV2Sessions,
  stopSessionCleanup,
  activeSessions,
  isSessionBusy,
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
