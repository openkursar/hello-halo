/**
 * Clearing a digital human's chat holds the conversation from the abort until
 * every step is done: the clear awaits (emptying the record) before it forgets
 * the stored session, and a reminder waiting for the chat, or a message, that
 * started in between would run on what was being cleared. Whatever waits for
 * the chat to be free starts once the clear is complete, in the fresh
 * conversation.
 */

import { describe, it, expect, vi } from 'vitest'

// The record is emptied with a write the test releases when it chooses.
const write = vi.hoisted(() => ({ release: null as null | (() => void) }))
vi.mock('fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('fs/promises')>(),
  writeFile: vi.fn(() => new Promise<void>(resolve => { write.release = resolve })),
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  unstable_v2_createSession: vi.fn(),
  tool: vi.fn((opts: any) => ({ ...opts, _isTool: true })),
  createSdkMcpServer: vi.fn((opts: any) => ({
    name: opts.name,
    version: opts.version,
    tools: opts.tools,
    _isMcpServer: true,
  })),
}))

const { consumers, v2Sessions, closeV2Session, stopGeneration } = vi.hoisted(() => {
  const _consumers = new Map<string, unknown>()
  const _v2Sessions = new Map<string, unknown>()
  return {
    consumers: _consumers,
    v2Sessions: _v2Sessions,
    closeV2Session: vi.fn((id: string) => { _v2Sessions.delete(id) }),
    stopGeneration: vi.fn(async (id: string) => { _consumers.delete(id) }),
  }
})

// Registry stub — forkNativeChatSession requires a non-null registry, and
// createLocalSession returns the new session record on the happy path.
const { registry, createLocalSession } = vi.hoisted(() => {
  const _createLocalSession = vi.fn((appId: string, uuid: string) => ({
    appId,
    channel: 'local',
    source: 'local',
    instanceId: '',
    chatId: uuid,
    chatType: 'direct',
    displayName: '',
    proactive: false,
    lastActiveAt: 0,
    messageCount: 0,
  }))
  return {
    createLocalSession: _createLocalSession,
    registry: { createLocalSession: _createLocalSession, resetActivity: vi.fn() },
  }
})

vi.mock('../../../../src/main/services/agent/session-manager', () => ({
  v2Sessions,
  closeV2Session,
  acquireV2Session: vi.fn(),
  getConsumerHandle: (id: string) => consumers.get(id) ?? null,
  getRunningConsumerIds: () => Array.from(consumers.keys()),
  markTurnDispatched: vi.fn(),
  updateConsumerDisplayModel: vi.fn(),
}))

vi.mock('../../../../src/main/services/agent/control', () => ({
  stopGeneration,
  getSessionState: (id: string) =>
    consumers.has(id)
      ? { isActive: true, thoughts: [], spaceId: 'space-1' }
      : { isActive: false, thoughts: [] },
}))

vi.mock('../../../../src/main/apps/runtime/im-session-registry', () => ({
  getImSessionRegistry: vi.fn(() => registry),
}))

vi.mock('../../../../src/main/services/agent/helpers', () => ({
  getApiCredentials: vi.fn(),
  getApiCredentialsForSource: vi.fn(),
  getWorkingDir: vi.fn(),
  getHeadlessElectronPath: vi.fn(),
  getDbMcpServers: vi.fn(),
}))
vi.mock('../../../../src/main/services/agent/sdk-config', () => ({
  resolveCredentialsForSdk: vi.fn(),
  buildUserSessionSdkOptions: vi.fn(),
}))
vi.mock('../../../../src/main/services/agent/permission-handler', () => ({
  createCanUseTool: vi.fn(),
}))
vi.mock('../../../../src/main/services/analytics/analytics.service', () => ({
  analytics: { track: vi.fn(), trackErrorSurface: vi.fn() },
}))

vi.mock('../../../../src/main/services/agent/events', () => ({ emitAgentEvent: vi.fn() }))
vi.mock('../../../../src/main/services/agent/stream-processor', () => ({ processStream: vi.fn() }))
vi.mock('../../../../src/main/services/agent/message-utils', () => ({ buildMessageContent: vi.fn(), formatCanvasContext: () => '' }))

vi.mock('../../../../src/main/services/ai-browser', () => ({
  AI_BROWSER_SYSTEM_PROMPT: '',
  createAIBrowserMcpServer: vi.fn(),
  createScopedBrowserContext: vi.fn(),
}))
vi.mock('../../../../src/main/services/web-search', () => ({
  createWebSearchMcpServer: vi.fn().mockReturnValue({ _isMcpServer: true }),
}))
vi.mock('../../../../src/main/services/email-mcp', () => ({
  createEmailMcpServer: vi.fn().mockReturnValue(null),
}))

vi.mock('../../../../src/main/foundation/config.service', () => ({
  getConfig: vi.fn().mockReturnValue({}),
  getTempSpacePath: vi.fn().mockReturnValue('/tmp/halo-test/temp'),
  onApiConfigChange: vi.fn(),
  onAgentConfigChange: vi.fn(),
  onNetworkConfigChange: vi.fn(),
}))
// The space the chat's record is kept in, so the clear empties it (on a held write).
vi.mock('../../../../src/main/services/space.service', () => ({
  getSpace: vi.fn().mockReturnValue({ path: '/space' }),
}))

vi.mock('../../../../src/main/apps/manager', () => ({
  getAppManager: vi.fn().mockReturnValue({ getApp: (id: string) => ({ id, spaceId: 'new-space' }) }),
}))
const { environment, activityStore, resolveChatEnvironment, copySessionJsonl } = vi.hoisted(() => {
  const environment = { spaceId: 'old-space', spacePath: '/original-space', workDir: '/original-cwd', memoryDir: '/original-memory' }
  return {
    environment,
    activityStore: { getSessionEnvironment: vi.fn(), deleteSessionEnvironment: vi.fn(), pinSessionEnvironment: vi.fn() },
    resolveChatEnvironment: vi.fn(() => environment),
    copySessionJsonl: vi.fn(() => true),
  }
})
vi.mock('../../../../src/main/apps/runtime/execution-environment', () => ({
  resolveChatEnvironment,
  appChatRunId: (conversationId: string, appId: string) => conversationId === `app-chat:${appId}` ? 'chat' : `chat-${conversationId.slice(`app-chat:${appId}:`.length).replace(/:/g, '-')}`,
  legacySessionEnvironmentKey: (appId: string, runId: string) => `legacy-file:${appId}:${runId}`,
}))
vi.mock('../../../../src/main/apps/runtime/session-store', () => ({
  copySessionJsonl,
  loadChatSessionId: vi.fn(() => 'original-sdk-session'),
  deleteChatSessionId: vi.fn(),
}))
vi.mock('../../../../src/main/apps/conversation-mcp', () => ({
  createHaloAppsMcpServer: vi.fn(),
}))
vi.mock('../../../../src/main/apps/runtime/index', () => ({
  getAppMemoryService: vi.fn().mockReturnValue(null),
  getActivityStore: () => activityStore,
}))
vi.mock('../../../../src/main/apps/runtime/dispatch-inbound', () => ({
  flushSupplementBuffer: vi.fn(),
}))
vi.mock('../../../../src/main/services/memory-consolidation', () => ({
  requestConsolidation: vi.fn(),
}))

// ============================================
// Imports (after all mocks)
// ============================================

import { clearAppChat } from '../../../../src/main/apps/runtime/app-chat'
import {
  beginAppChatTurnStart,
  isAppChatConversationGenerating,
  onAppChatConversationChange,
} from '../../../../src/main/apps/runtime/app-chat-live-turn'
import { deleteChatSessionId } from '../../../../src/main/apps/runtime/session-store'

const APP = 'target-app'
const LOCAL = `app-chat:${APP}:local:direct:uuid-1`

/** Something that starts when the chat is free, as a waiting reminder or a buffered message does. */
function waitForFree(conversationId: string): string[] {
  const started: string[] = []
  const stop = onAppChatConversationChange((changed) => {
    if (changed !== conversationId) return
    setImmediate(() => {
      if (started.length > 0 || isAppChatConversationGenerating(conversationId)) return
      started.push(vi.mocked(deleteChatSessionId).mock.calls.length > 0 ? 'after the clear' : 'during the clear')
      stop()
    })
  })
  return started
}

const settle = () => new Promise(resolve => setImmediate(resolve))

describe('clearing a chat while something waits for it', () => {
  it('starts what waited only once the clear is complete, in the fresh conversation', async () => {
    // A turn is on its way; a reminder that came due waits behind it.
    const runningTurn = beginAppChatTurnStart(LOCAL)
    const reminder = waitForFree(LOCAL)

    // /clear (or Clear all conversations) stops the turn and starts emptying the record.
    const clearing = clearAppChat(APP, 'space-1', LOCAL)
    await vi.waitFor(() => expect(write.release).not.toBeNull())
    // The stopped turn has wound down; the clear has not finished.
    runningTurn.end()
    await settle()
    await settle()
    expect(reminder).toEqual([])
    expect(isAppChatConversationGenerating(LOCAL)).toBe(true)

    write.release!()
    await clearing
    await settle()

    expect(reminder).toEqual(['after the clear'])
    expect(isAppChatConversationGenerating(LOCAL)).toBe(false)
  })

  it('lets go of the chat when the clear fails', async () => {
    vi.mocked((await import('fs/promises')).writeFile).mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(clearAppChat(APP, 'space-1', LOCAL)).rejects.toThrow('EACCES')

    expect(isAppChatConversationGenerating(LOCAL)).toBe(false)
  })
})
