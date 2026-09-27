/**
 * A goal the user set before a conversation's engine session had an id is
 * seeded into a fresh session, and only then: a resumed session keeps the
 * goal the engine persisted with it.
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
  getActiveEngine: vi.fn(() => 'halo'),
  getEngineCapabilities: vi.fn(() => ({ features: { goal: true } })),
}))
vi.mock('../../../../src/main/services/agent/session-consumer', () => ({ startConsumer: vi.fn() }))
vi.mock('../../../../src/main/services/agent/conversation-sink', () => ({ createConversationSink: vi.fn() }))
vi.mock('../../../../src/main/services/agent/mcp-auth-state', () => ({ purgeStaleMcpOAuth: vi.fn(async () => {}) }))
vi.mock('../../../../src/main/services/agent/events', () => ({ emitAgentEvent: vi.fn() }))
vi.mock('../../../../src/main/services/agent/reasoning-effort', () => ({ applySessionReasoningEffort: vi.fn() }))
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
} from '../../../../src/main/services/agent/session-manager'
import { setGoalDraft } from '../../../../src/main/services/agent/goal/draft'

function fakeSession() {
  return { query: { transport: { isReady: () => true, onExit: () => () => {} } }, close: vi.fn() }
}

const draft = { objective: 'Ship', doneWhen: ['tests pass'], status: 'active' as const, updatedBy: 'user' as const, updatedAt: 'x' }

afterEach(() => {
  closeAllV2Sessions()
  createSession.mockReset()
})

afterAll(() => {
  stopSessionCleanup()
})

describe('goal draft seeding at session creation', () => {
  it('seeds a session created without a recorded engine session id', async () => {
    setGoalDraft('conv-new', draft)
    createSession.mockResolvedValueOnce(fakeSession())

    await getOrCreateV2Session('space', 'conv-new', { systemPrompt: 'p', model: 'm' })

    expect(createSession.mock.calls[0][0].goal).toEqual({ objective: 'Ship', doneWhen: ['tests pass'] })
    setGoalDraft('conv-new', null)
  })

  it('does not seed a resumed session', async () => {
    setGoalDraft('conv-resumed', draft)
    createSession.mockResolvedValueOnce(fakeSession())

    await getOrCreateV2Session('space', 'conv-resumed', { systemPrompt: 'p', model: 'm' }, 'sess-1')

    expect(createSession.mock.calls[0][0].goal).toBeUndefined()
    expect(createSession.mock.calls[0][0].resume).toBe('sess-1')
    setGoalDraft('conv-resumed', null)
  })
})
