/**
 * Before a space's folder is deleted, its idle sessions are closed and their
 * engine processes waited for: Windows will not remove a folder a live process
 * works in. Busy sessions and other spaces' sessions are left running.
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
  closeSpaceSessions,
  stopSessionCleanup,
  isSpaceBusy,
} from '../../../../src/main/services/agent/session-manager'

/** Engine processes still running, by pid. */
const alive = new Set<number>()

function fakeSession(pid: number) {
  alive.add(pid)
  return { pid, query: { transport: { isReady: () => true, onExit: () => () => {} } }, close: vi.fn() }
}

async function withSession(spaceId: string, conversationId: string, pid: number, turn: unknown = null) {
  const session = fakeSession(pid)
  createSession.mockResolvedValueOnce(session)
  startConsumer.mockReturnValueOnce({
    isRunning: true,
    getActiveSessionState: () => turn,
    getTeamLifecycleThoughts: () => [],
    hasRunningTasks: () => false,
    stop: vi.fn(),
  })
  await getOrCreateV2Session(spaceId, conversationId, { systemPrompt: 'p', model: 'm' }, undefined, undefined, {} as never)
  return session
}

vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
  if (!alive.has(pid)) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
  return true
}) as typeof process.kill)

afterEach(() => {
  closeAllV2Sessions()
  alive.clear()
  createSession.mockReset()
  startConsumer.mockReset()
})

afterAll(() => {
  stopSessionCleanup()
})

describe('closeSpaceSessions', () => {
  it('closes the space’s idle sessions and returns only after their processes are gone', async () => {
    const session = await withSession('space-a', 'conv-a', 101)
    session.close.mockImplementation(() => setTimeout(() => alive.delete(101), 120))

    let settled = false
    const closing = closeSpaceSessions('space-a', 'space deleted').then(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(session.close).toHaveBeenCalled()
    expect(settled).toBe(false)

    await closing
    expect(alive.has(101)).toBe(false)
  })

  it('leaves busy sessions and other spaces alone', async () => {
    const answering = await withSession('space-a', 'conv-busy', 201, { thoughts: [] })
    const elsewhere = await withSession('space-b', 'conv-other', 202)

    await closeSpaceSessions('space-a', 'space deleted')

    expect(answering.close).not.toHaveBeenCalled()
    expect(elsewhere.close).not.toHaveBeenCalled()
    expect(isSpaceBusy('space-a')).toBe(true)
  })

  it('gives up waiting after the timeout and logs which process is still there', async () => {
    await withSession('space-a', 'conv-stuck', 301)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await closeSpaceSessions('space-a', 'space deleted', 100)

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('301'))
  })
})
