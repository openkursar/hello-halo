/**
 * What a working directory change needs from the engine: whether anything in
 * the space is running or about to (so the change can wait for it), and that
 * once the space has left a folder no session of the space starts there — a
 * turn that read the old folder just before the change is refused, not run in
 * a folder nothing will read again.
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
  isSpaceBusy,
} from '../../../../src/main/services/agent/session-manager'
import { retireWorkingDirs } from '../../../../src/main/services/agent/working-dir'

const CHANGED = 'The working folder changed while this message was being prepared. Send it again.'

function fakeSession() {
  return { query: { transport: { isReady: () => true, onExit: () => () => {} } }, close: vi.fn() }
}

type Handle = { isRunning: boolean; turn: unknown; tasks: boolean }

function consumer(state: Handle) {
  return {
    get isRunning() { return state.isRunning },
    getActiveSessionState: () => state.turn,
    getTeamLifecycleThoughts: () => [],
    hasRunningTasks: () => state.tasks,
    stop: vi.fn(),
  }
}

/** A session of `spaceId` with a persistent consumer whose state the test controls. */
async function withConsumer(spaceId: string, conversationId: string, state: Handle): Promise<void> {
  createSession.mockResolvedValueOnce(fakeSession())
  startConsumer.mockReturnValueOnce(consumer(state))
  await getOrCreateV2Session(spaceId, conversationId, { systemPrompt: 'p', model: 'm' }, undefined, undefined, {} as never)
}

function open(spaceId: string, conversationId: string, workDir?: string, cwd?: string) {
  createSession.mockResolvedValueOnce(fakeSession())
  return getOrCreateV2Session(spaceId, conversationId, { systemPrompt: 'p', model: 'm', ...(cwd ? { cwd } : {}) }, undefined, workDir)
}

afterEach(() => {
  closeAllV2Sessions()
  activeSessions.clear()
  createSession.mockReset()
  startConsumer.mockReset()
})

afterAll(() => {
  stopSessionCleanup()
})

describe('isSpaceBusy', () => {
  it('is free with nothing running, and with sessions idle between turns', async () => {
    expect(isSpaceBusy('space-a')).toBe(false)
    await withConsumer('space-a', 'conv-idle', { isRunning: true, turn: null, tasks: false })
    expect(isSpaceBusy('space-a')).toBe(false)
  })

  it('is busy while one of its conversations answers, and only that space', async () => {
    await withConsumer('space-a', 'conv-turn', { isRunning: true, turn: { thoughts: [] }, tasks: false })
    expect(isSpaceBusy('space-a')).toBe(true)
    expect(isSpaceBusy('space-b')).toBe(false)
  })

  it('is busy while background work will come back as a later turn', async () => {
    await withConsumer('space-a', 'conv-tasks', { isRunning: true, turn: null, tasks: true })
    expect(isSpaceBusy('space-a')).toBe(true)
  })

  it('is busy while a run or digital human turn of the space is in flight', () => {
    activeSessions.set('run-1', { spaceId: 'space-a', conversationId: 'run-1' } as never)
    expect(isSpaceBusy('space-a')).toBe(true)
    expect(isSpaceBusy('space-b')).toBe(false)
  })

  it('is busy while a session of the space is still being created', async () => {
    let finish!: (session: unknown) => void
    createSession.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    startConsumer.mockReturnValueOnce(consumer({ isRunning: true, turn: null, tasks: false }))

    const creating = getOrCreateV2Session('space-a', 'conv-new', { systemPrompt: 'p', model: 'm' }, undefined, undefined, {} as never)
    await vi.waitFor(() => expect(createSession).toHaveBeenCalled())
    expect(isSpaceBusy('space-a')).toBe(true)

    finish(fakeSession())
    await creating
    expect(isSpaceBusy('space-a')).toBe(false)
  })
})

describe('a session in a folder its space has left', () => {
  it('is refused before anything starts, in that space only', async () => {
    retireWorkingDirs('space-moved', ['/work/old'], '/work/new')

    await expect(open('space-moved', 'conv-stale', '/work/old')).rejects.toThrow(CHANGED)
    await expect(open('space-moved', 'conv-stale-cwd', undefined, '/work/old/')).rejects.toThrow(CHANGED)
    expect(createSession).not.toHaveBeenCalled()

    await expect(open('space-moved', 'conv-current', '/work/new')).resolves.toBeDefined()
    await expect(open('space-other', 'conv-shared-folder', '/work/old')).resolves.toBeDefined()
  })

  it('is allowed again once the space moves back to it', async () => {
    retireWorkingDirs('space-back', ['/work/first'], '/work/second')
    retireWorkingDirs('space-back', ['/work/second'], '/work/first')

    await expect(open('space-back', 'conv-first', '/work/first')).resolves.toBeDefined()
    await expect(open('space-back', 'conv-second', '/work/second')).rejects.toThrow(CHANGED)
  })
})
