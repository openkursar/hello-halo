/**
 * A digital human's own thinking level applies to every turn it takes, not
 * only to sends from its Halo chat: IM replies, API sends and team turns run at
 * it too, and it wins over a level a send carries. Without one, the send's
 * level or the model's configured effort decides, as before.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

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
    registry: { createLocalSession: _createLocalSession, resetActivity: vi.fn(), register: vi.fn() },
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
const levels = vi.hoisted(() => ({ overrides: {} as Record<string, unknown> }))
vi.mock('../../../../src/main/services/agent/sdk-config', () => ({
  resolveCredentialsForSdk: vi.fn(async () => { throw new Error('stopped after the level was picked') }),
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
// getSpace returns null so both guards' allow-path skips disk I/O entirely.
vi.mock('../../../../src/main/services/space.service', () => ({
  getSpace: vi.fn().mockReturnValue(null),
}))

vi.mock('../../../../src/main/apps/manager', () => ({
  getAppManager: vi.fn().mockReturnValue({ getApp: (id: string) => ({ id, spaceId: 'new-space', userOverrides: levels.overrides }) }),
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
  getAppMemoryService: vi.fn().mockReturnValue({}),
  getActivityStore: () => activityStore,
}))
vi.mock('../../../../src/main/apps/runtime/dispatch-inbound', () => ({
}))
vi.mock('../../../../src/main/services/memory-consolidation', () => ({
  requestConsolidation: vi.fn(),
}))

import { sendAppChatMessage } from '../../../../src/main/apps/runtime/app-chat'
import { resolveCredentialsForSdk } from '../../../../src/main/services/agent/sdk-config'

async function pickedFor(turn: Record<string, unknown>): Promise<unknown> {
  vi.mocked(resolveCredentialsForSdk).mockClear()
  await sendAppChatMessage({ appId: 'person', spaceId: 'new-space', message: 'hello', ...turn } as never).catch(() => {})
  expect(resolveCredentialsForSdk).toHaveBeenCalledTimes(1)
  return vi.mocked(resolveCredentialsForSdk).mock.calls[0][1]
}

const imTurn = {
  conversationId: 'app-chat:person:wecom-bot:group:g-1',
  imSession: { channel: 'wecom-bot', chatType: 'group', displayName: 'Ops', sessionId: 'inst:g-1' },
  thinkingEnabled: true,
}

describe('the digital human’s own thinking level', () => {
  beforeEach(() => {
    levels.overrides = {}
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('applies to its IM replies, which used to keep the model’s level', async () => {
    levels.overrides = { chatReasoningEffort: 'max' }

    expect(await pickedFor(imTurn)).toBe('max')
  })

  it('applies to its Halo chat and wins over a level an API send carries', async () => {
    levels.overrides = { chatReasoningEffort: 'off' }

    expect(await pickedFor({})).toBe('off')
    expect(await pickedFor({ reasoningEffort: 'high' })).toBe('off')
  })

  it('leaves the send’s level or the model’s configured effort when it has none', async () => {
    expect(await pickedFor(imTurn)).toBeUndefined()
    expect(await pickedFor({ reasoningEffort: 'low' })).toBe('low')
  })
})
