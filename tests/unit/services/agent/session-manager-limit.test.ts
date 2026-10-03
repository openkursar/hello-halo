/**
 * Resident session limit: before a NEW engine session is created, idle
 * sessions are evicted least-recently-used first; busy ones never are.
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
  activeSessions,
  v2Sessions,
  listResidentSessions,
  evictIdleSession,
  setResidentSessionLimit,
} from '../../../../src/main/services/agent/session-manager'

function fakeSession() {
  return { query: { transport: { isReady: () => true, onExit: () => () => {} } }, close: vi.fn() }
}

/** Create a resident session (legacy, no consumer) last used at `lastUsedAt`. */
async function resident(conversationId: string, lastUsedAt: number): Promise<void> {
  createSession.mockResolvedValueOnce(fakeSession())
  await getOrCreateV2Session('space', conversationId, { systemPrompt: 'p', model: 'm' })
  v2Sessions.get(conversationId)!.lastUsedAt = lastUsedAt
}

afterEach(() => {
  setResidentSessionLimit(null)
  closeAllV2Sessions()
  activeSessions.clear()
  createSession.mockReset()
  vi.restoreAllMocks()
})

afterAll(() => {
  stopSessionCleanup()
})

describe('resident session limit', () => {
  it('null limit never evicts (unchanged behavior)', async () => {
    for (let i = 0; i < 5; i++) await resident(`c${i}`, i)
    expect(v2Sessions.size).toBe(5)
  })

  it('evicts the least-recently-used idle sessions to fit the new one', async () => {
    await resident('old', 100)
    await resident('older', 50)
    await resident('recent', 300)
    setResidentSessionLimit(2)

    await resident('new', 400)

    expect([...v2Sessions.keys()].sort()).toEqual(['new', 'recent'])
  })

  it('never evicts a busy session; goes over the limit and warns once per crossing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await resident('busy-a', 1)
    await resident('busy-b', 2)
    activeSessions.set('busy-a', {} as never)
    activeSessions.set('busy-b', {} as never)
    setResidentSessionLimit(2)

    await resident('x', 3)
    activeSessions.set('x', {} as never)
    await resident('y', 4)

    expect(v2Sessions.size).toBe(4)
    const overLimit = warn.mock.calls.filter((c) => String(c[0]).includes('over limit'))
    expect(overLimit).toHaveLength(1)
  })

  it('reuse of an existing session never evicts', async () => {
    await resident('a', 1)
    await resident('b', 2)
    setResidentSessionLimit(1)

    createSession.mockClear()
    await getOrCreateV2Session('space', 'b', { systemPrompt: 'p', model: 'm' })

    expect(createSession).not.toHaveBeenCalled()
    expect(v2Sessions.size).toBe(2)
  })

  it('listResidentSessions reports busy state; evictIdleSession refuses busy sessions', async () => {
    await resident('idle', 1)
    await resident('busy', 2)
    activeSessions.set('busy', {} as never)

    const listed = listResidentSessions().sort((a, b) => a.lastUsedAt - b.lastUsedAt)
    expect(listed.map((s) => [s.conversationId, s.busy])).toEqual([['idle', false], ['busy', true]])
    expect(evictIdleSession('busy', 'test')).toBe(false)
    expect(evictIdleSession('idle', 'test')).toBe(true)
    expect(evictIdleSession('missing', 'test')).toBe(false)
    expect([...v2Sessions.keys()]).toEqual(['busy'])
  })
})
