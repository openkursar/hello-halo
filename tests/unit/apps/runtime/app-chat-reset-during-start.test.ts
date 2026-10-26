/**
 * A chat reset while one of its messages is still on its way to the engine.
 *
 * A reset (an IM clear command, the desktop's clear, "Restart agent", a team
 * session closed) stops the message, closes the chat's session and replaces
 * its browser context and sink. The message's turn does not stop at once: it
 * is somewhere between taking the browser context and getting its session,
 * which can be a cold engine start of seconds to a minute. A session it
 * acquires after the reset was built on what the reset removed — its browser
 * tools close over the destroyed context, its consumer holds the dropped sink.
 * Left registered, the next message reused it and every browser call failed
 * with "Browser context was released", for as long as the chat kept talking.
 *
 * Rule under test: a turn whose conversation was reset under it closes the
 * session it acquired. A person's stop resets nothing, so its warm session is
 * kept; a session the reset itself closed needs nothing more.
 *
 * Same scaffolding as app-chat-reminder-setter.test.ts; the session
 * acquisition is gated so the reset can land while the turn is inside it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// ============================================
// Mocks (must be declared before importing app-chat)
// ============================================

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

vi.mock('fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('fs/promises')>(),
  writeFile: vi.fn(async () => undefined),
}))

/**
 * The engine's sessions as the chat sees them: one registered instance per
 * conversation, a lease on it, and the listeners run when it is retired. A
 * reset's `closeV2Session` retires the registered instance; the gate holds an
 * acquisition inside the engine until the test releases it.
 */
const engine = vi.hoisted(() => {
  const send = vi.fn()
  const v2Sessions = new Map<string, unknown>()
  const retirement = new Map<string, Set<() => void>>()
  const leases: Array<{ conversationId: string; session: object; close: () => void }> = []
  let gate: Promise<void> | null = null
  let release: (() => void) | null = null

  function retire(conversationId: string, session: unknown): void {
    if (v2Sessions.get(conversationId) !== session) return
    v2Sessions.delete(conversationId)
    const listeners = retirement.get(conversationId) ?? new Set()
    retirement.delete(conversationId)
    for (const listener of [...listeners]) listener()
  }

  function lease(conversationId: string) {
    const session = { send, setMaxThinkingTokens: vi.fn() }
    v2Sessions.set(conversationId, session)
    const close = vi.fn(() => retire(conversationId, session))
    const handle = {
      session,
      get isCurrent() { return v2Sessions.get(conversationId) === session },
      get isUsable() { return v2Sessions.get(conversationId) === session },
      onRetired(listener: () => void) {
        if (v2Sessions.get(conversationId) !== session) { listener(); return () => {} }
        const listeners = retirement.get(conversationId) ?? new Set<() => void>()
        listeners.add(listener)
        retirement.set(conversationId, listeners)
        return () => listeners.delete(listener)
      },
      send,
      close,
      release: vi.fn(),
    }
    leases.push({ conversationId, session, close })
    return handle
  }

  async function acquire(conversationId: string) {
    if (gate) await gate
    return lease(conversationId)
  }

  return {
    send,
    v2Sessions,
    leases,
    acquire,
    closeV2Session: vi.fn((conversationId: string) => retire(conversationId, v2Sessions.get(conversationId))),
    acquireV2Session: vi.fn((_spaceId: string, conversationId: string) => acquire(conversationId)),
    /** Hold every acquisition until {@link engine.open}. */
    hold() {
      gate = new Promise<void>(resolve => { release = resolve })
    },
    open() {
      release?.()
      gate = null
      release = null
    },
    reset() {
      v2Sessions.clear()
      retirement.clear()
      leases.length = 0
      gate = null
      release = null
      send.mockClear()
    },
  }
})

vi.mock('../../../../src/main/services/agent/session-manager', () => ({
  activeSessions: new Map(),
  hasPendingSessionInput: () => false,
  v2Sessions: engine.v2Sessions,
  closeV2Session: engine.closeV2Session,
  acquireV2Session: engine.acquireV2Session,
  getConsumerHandle: () => null,
  getRunningConsumerIds: () => [],
  markTurnDispatched: vi.fn(),
  updateConsumerDisplayModel: vi.fn(),
}))

vi.mock('../../../../src/main/services/agent/control', () => ({
  stopGeneration: vi.fn(async () => {}),
  getSessionState: () => ({ isActive: false, thoughts: [] }),
}))

// The sink settles as soon as the message is handed to the session — these
// tests ask what became of the session, not how a reply streams back.
const { sink } = vi.hoisted(() => ({
  sink: {
    writeUserMessage: vi.fn(() => ({ role: 'user', content: '' })),
    setTurnIdentity: vi.fn(),
    markInputsStopped: vi.fn(),
    beginRound: vi.fn(() => ({
      done: Promise.resolve(),
      cancel: vi.fn(),
      noteAskedUser: vi.fn(),
      onProgress: undefined,
      onMessageAccepted: undefined,
      onReply: undefined,
    })),
  },
}))
vi.mock('../../../../src/main/apps/runtime/app-chat-sink', () => ({
  bindAppChatEngine: (sink: unknown) => sink,
  onAppChatRoundChange: () => () => {},
  getAppChatSink: () => sink,
  peekAppChatSink: () => undefined,
  hasActiveAppChatRound: () => false,
  getConversationsWithActiveRound: () => [],
  disposeAppChatSink: vi.fn(),
}))

const { getDelegatedPolicy, createTeamMcpServer, noteMemberTurnEnded } = vi.hoisted(() => ({
  getDelegatedPolicy: vi.fn((): unknown => undefined),
  createTeamMcpServer: vi.fn((_context: Record<string, unknown>) => ({ _isMcpServer: true, name: 'halo-team' })),
  noteMemberTurnEnded: vi.fn((_input: Record<string, unknown>) => {}),
}))
vi.mock('../../../../src/main/apps/runtime/team', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getActiveTeamRuntime: () => ({
    buildPromptContext: () => ({
      teamName: 'Front office',
      goal: 'Answer the people who message the team',
      collabMode: 'free',
      escalationRouting: 'user',
      selfMemberName: 'desk',
      selfRole: 'Front desk',
      selfIsLead: true,
      selfIsDisposable: false,
      roster: [],
    }),
    getDelegatedPolicy,
    getTeamName: () => 'Front office',
    noteEpochTurn: () => true,
    noteMemberStatusChanged: () => {},
    noteMemberTurnStarted: () => {},
    noteMemberTurnEnded,
    reconcileAwaitingDecision: () => {},
    recordToolAudit: () => {},
    maybeAutoNameConversation: () => {},
    holdSessionAfterStop: () => [],
    teamFolders: {},
    bus: { drainMailbox: () => {} },
  }),
}))
vi.mock('../../../../src/main/apps/runtime/team/team-tools', () => ({ createTeamMcpServer }))

const { buildUserSessionSdkOptions, getEngineCapabilities } = vi.hoisted(() => ({
  buildUserSessionSdkOptions: vi.fn((_input: Record<string, unknown>): Record<string, any> => ({})),
  getEngineCapabilities: vi.fn((): unknown => ({ features: { permissionRules: true, hooks: true } })),
}))
vi.mock('../../../../src/main/services/agent/resolved-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/main/services/agent/resolved-sdk')>()),
  getEngineCapabilities,
}))
vi.mock('../../../../src/main/services/agent/sdk-config', () => ({
  markMcpServerSettings: (server: unknown) => server,
  resolveCredentialsForSdk: vi.fn(async () => ({
    displayModel: 'test-model',
    sdkModel: 'test-model',
    anthropicApiKey: 'key',
    anthropicBaseUrl: 'https://example.invalid',
    capabilities: {},
  })),
  buildUserSessionSdkOptions,
  addSdkHooks: (options: Record<string, any>, hooks: Record<string, unknown[]>) => {
    const merged: Record<string, unknown[]> = { ...(options.hooks ?? {}) }
    for (const [event, list] of Object.entries(hooks)) merged[event] = [...(merged[event] ?? []), ...list]
    options.hooks = merged
  },
}))
vi.mock('../../../../src/main/services/agent/reasoning-effort', () => ({
  applyReasoningEffort: () => 0,
  pickReasoningEffort: () => undefined,
}))
vi.mock('../../../../src/main/services/agent/permission-handler', () => ({
  createCanUseTool: vi.fn(() => vi.fn()),
}))
vi.mock('../../../../src/main/services/agent/message-utils', () => ({
  buildMessageContent: (text: string) => text,
  formatCanvasContext: () => '',
}))
vi.mock('../../../../src/main/services/agent/image-attachments', () => ({
  prepareNonVisionImageFallback: () => undefined,
}))
vi.mock('../../../../src/main/services/agent/helpers', () => ({
  getApiCredentials: vi.fn(async () => ({ provider: 'anthropic' })),
  getApiCredentialsForSelection: vi.fn(async () => ({ provider: 'anthropic' })),
  getWorkingDir: vi.fn(),
  getHeadlessElectronPath: vi.fn(() => '/electron'),
  getDbMcpServers: vi.fn(() => null),
}))
const { emitAgentEvent } = vi.hoisted(() => ({ emitAgentEvent: vi.fn() }))
vi.mock('../../../../src/main/services/agent/events', () => ({ onAgentEvent: () => ({ dispose: () => {} }), emitAgentEvent }))
vi.mock('../../../../src/main/services/analytics/analytics.service', () => ({
  analytics: { track: vi.fn(), trackErrorSurface: vi.fn() },
}))
vi.mock('../../../../src/main/services/ai-browser', () => ({
  createAIBrowserMcpServer: vi.fn(() => ({ _isMcpServer: true, name: 'ai-browser' })),
  createScopedBrowserContext: vi.fn(() => ({ destroy: vi.fn(), closePages: vi.fn(), ownedViewCount: 0, hasRevealedView: () => false })),
  AI_BROWSER_SYSTEM_PROMPT: 'AI browser instructions',
}))
vi.mock('../../../../src/main/services/ai-terminal', () => ({
  createTerminalMcpServer: vi.fn(),
  getGlobalTerminalContext: vi.fn(),
  isTerminalAvailable: () => false,
  AI_TERMINAL_SYSTEM_PROMPT: 'AI terminal instructions',
}))
vi.mock('../../../../src/main/services/web-search', () => ({
  createWebSearchMcpServer: () => ({ _isMcpServer: true, name: 'web-search' }),
}))
vi.mock('../../../../src/main/services/ocr', () => ({
  createOcrMcpServer: () => ({ _isMcpServer: true, name: 'ocr' }),
}))
vi.mock('../../../../src/main/services/api-ref', () => ({
  createApiRefMcpServer: () => ({ _isMcpServer: true, name: 'halo-api-ref' }),
  HALO_API_USAGE_GUIDE: 'Halo API usage',
  HALO_API_TOOLSET_ID: 'halo-api-ref',
}))
vi.mock('../../../../src/main/services/email-mcp', () => ({
  createEmailMcpServer: () => ({ _isMcpServer: true, name: 'halo-email' }),
}))
vi.mock('../../../../src/main/services/official-docs-mcp', () => ({
  createOfficialDocsSession: () => ({
    server: { _isMcpServer: true, name: 'halo-docs' },
    guideConsulted: () => false,
  }),
}))
vi.mock('../../../../src/main/apps/runtime/notify-tool', () => ({
  createNotifyToolServer: () => ({ _isMcpServer: true, name: 'halo-notify' }),
}))
vi.mock('../../../../src/main/apps/runtime/reminders/tool', () => ({
  createRemindersMcpServer: () => ({ _isMcpServer: true, name: 'halo-reminders' }),
}))
vi.mock('../../../../src/main/apps/runtime/person-context-tool', () => ({
  createPersonContextMcpServer: () => ({ _isMcpServer: true, name: 'halo-person-context' }),
  personContextPrompt: () => 'person-context',
}))
vi.mock('../../../../src/main/apps/runtime/report-tool', () => ({
  createReportToolServer: () => ({ _isMcpServer: true, name: 'halo-report' }),
}))
vi.mock('../../../../src/main/apps/runtime/im-session-registry', () => ({
  getImSessionRegistry: () => null,
}))
vi.mock('../../../../src/main/apps/runtime/engine-selection', () => ({
  resolveAppSessionEngine: async (selection: { engineId?: string }) => selection.engineId ?? 'halo',
  prepareAppEngineSession: (options: { state: { sessionId?: string }; legacySessionId?: string }) => ({ resumeSessionId: options.state.sessionId ?? options.legacySessionId }),
}))

vi.mock('../../../../src/main/apps/runtime/session-store', () => ({
  saveChatEngineRouting: (_space: string, _app: string, _run: string, engineId: string, state: any = {}) => state.sessionId || state.binding || state.routingEngine ? state : { routingEngine: engineId },
  loadChatEngineState: () => ({}),
  saveChatEngineBinding: vi.fn(() => true),
  loadChatSessionId: vi.fn(() => undefined),
  saveChatSessionId: vi.fn(),
  deleteChatSessionId: vi.fn(),
  copySessionJsonl: vi.fn(),
  readSessionMessages: () => [],
}))
vi.mock('../../../../src/main/foundation/config.service', () => ({
  getConfig: () => ({}),
  getHaloDir: () => '/tmp/halo-test',
  getTempSpacePath: () => '/tmp/halo-test/temp',
  onApiConfigChange: vi.fn(),
  onAgentConfigChange: vi.fn(),
  onNetworkConfigChange: vi.fn(),
}))
vi.mock('../../../../src/main/services/space.service', () => ({
  getSpace: () => ({ id: 'space-1', path: '/tmp/halo-test/space' }),
  getSpaceDir: () => '/tmp/halo-test/space',
  isSpaceMemoryEnabled: () => false,
}))

const { app, environment, activityStore } = vi.hoisted(() => ({
  app: {
    id: 'app-desk',
    spaceId: 'space-1',
    status: 'active',
    permissions: { granted: ['ai-browser'], denied: [] },
    userConfig: {},
    userOverrides: undefined,
    spec: {
      name: 'Desk',
      type: 'automation',
      system_prompt: 'You answer people.',
      config_schema: [],
      permissions: ['ai-browser'],
      requires: { mcps: [] },
    },
  },
  environment: {
    spaceId: 'space-1',
    spacePath: '/tmp/halo-test/space',
    workDir: '/tmp/halo-test/space',
    memoryDir: '/tmp/halo-test/memory',
  },
  activityStore: { getSessionEnvironment: vi.fn(), deleteSessionEnvironment: vi.fn(), pinSessionEnvironment: vi.fn() },
}))
vi.mock('../../../../src/main/apps/manager', () => ({
  getAppManager: () => ({ getApp: () => app }),
}))
vi.mock('../../../../src/main/apps/runtime/execution-environment', () => ({
  resolveChatEnvironment: () => environment,
  validateEnvironmentConnections: vi.fn(),
  validateExecutionEnvironment: vi.fn(),
  resolveExecutionEnvironment: () => environment,
  legacySessionEnvironmentKey: (appId: string, runId: string) => `legacy:${appId}:${runId}`,
  appChatRunId: (conversationId: string, appId: string) => `run-${conversationId}-${appId}`,
}))
vi.mock('../../../../src/main/apps/runtime/index', () => ({
  getAppMemoryService: () => ({ getPromptInstructions: () => '' }),
  getActivityStore: () => activityStore,
}))
vi.mock('../../../../src/main/apps/runtime/turn/memory-lifecycle', () => ({
  prepareMemoryForTurn: vi.fn(async () => ({ snapshot: {} })),
  requestAppMemoryConsolidation: vi.fn(),
  memoryPromptOptions: vi.fn(() => ({})),
  loadSpaceTopicsForTurn: vi.fn(async () => null),
  appMemoryGuard: vi.fn(() => ({ writable: [], readOnly: [], label: 'test' })),
  appMemorySettings: vi.fn(() => ({ enabled: false, autoConsolidate: false, cadence: 'diligent' })),
  appTurnFileAccess: vi.fn(() => ({
    cwd: '/tmp/halo-test/space', memoryWritable: [], memoryReadable: [], attachedFiles: [],
    workspaceRoots: ['/tmp/halo-test/space'], closed: [], hookGuarded: [], memorySystemPaths: [],
  })),
}))
vi.mock('../../../../src/main/services/memory-consolidation', () => ({
  requestConsolidation: vi.fn(),
}))
vi.mock('../../../../src/main/apps/skill-discovery', () => ({
  listLoadableSkillCopies: () => [],
}))

// ============================================
// Imports (after all mocks)
// ============================================

import {
  sendAppChatMessage,
  clearImSession,
  closeTeamSession,
  restartAppChat,
  stopAppChatConversation,
  type AppChatRequest,
} from '../../../../src/main/apps/runtime/app-chat'
import { isAppChatConversationGenerating } from '../../../../src/main/apps/runtime/app-chat-live-turn'
import { destroyAllChatBrowserContexts, hasChatBrowserContext } from '../../../../src/main/apps/runtime/app-chat-browser'
import { buildTeamSessionKey } from '../../../../src/shared/apps/team-types'

const IM_CHAT = { channel: 'wecom-bot', chatType: 'direct' as const, chatId: 'u-1' }
const IM_KEY = `app-chat:${app.id}:${IM_CHAT.channel}:${IM_CHAT.chatType}:${IM_CHAT.chatId}`
const TEAM_ID = 'team-1'
const EPOCH_ID = 'epoch-1'
const TEAM_KEY = buildTeamSessionKey(app.id, TEAM_ID, EPOCH_ID)

function imTurn(): AppChatRequest {
  return {
    appId: app.id, spaceId: 'space-1', message: 'todo', conversationId: IM_KEY,
    imSession: { channel: IM_CHAT.channel, chatType: IM_CHAT.chatType, displayName: 'Owner', sessionId: `inst-1:${IM_CHAT.chatId}` },
    imPermission: { senderId: 'boss', senderName: 'Boss', isOwner: true, ownerIds: ['boss'] },
  }
}

function teamTurn(): AppChatRequest {
  return {
    appId: app.id, spaceId: 'space-1', message: 'reply "ok"', conversationId: TEAM_KEY,
    teamContext: { teamId: TEAM_ID, epochId: EPOCH_ID, kind: 'message', fromAppId: 'app-coordinator', wait: false, correlationId: 'corr-1' },
  }
}

/** Start a message and wait until its turn is inside the engine's (held) session acquisition. */
async function startHeldInAcquire(request: AppChatRequest): Promise<{ turn: Promise<void> }> {
  engine.hold()
  const turn = sendAppChatMessage(request)
  await vi.waitFor(() => expect(engine.acquireV2Session).toHaveBeenCalled())
  return { turn }
}

describe('a chat reset while a message is on its way to the engine', () => {
  beforeEach(() => {
    engine.reset()
    engine.acquireV2Session.mockClear()
    engine.closeV2Session.mockClear()
    emitAgentEvent.mockClear()
    sink.writeUserMessage.mockClear()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    engine.open()
    destroyAllChatBrowserContexts('test-cleanup')
    vi.restoreAllMocks()
  })

  it('an IM clear during a cold start: the session the turn then acquires is closed, so the next message starts fresh', async () => {
    const { turn } = await startHeldInAcquire(imTurn())
    expect(isAppChatConversationGenerating(IM_KEY)).toBe(true)
    expect(hasChatBrowserContext(IM_KEY)).toBe(true)

    // The clear command: stops the message, closes the (not yet existing)
    // session, destroys the browser context the turn built its tools with.
    await clearImSession(app.id, 'space-1', IM_CHAT.channel, IM_CHAT.chatType, IM_CHAT.chatId)
    expect(hasChatBrowserContext(IM_KEY)).toBe(false)

    engine.open()
    await turn

    // The acquired session carried the destroyed context: closed, not left for the next message.
    expect(engine.leases).toHaveLength(1)
    expect(engine.leases[0].close).toHaveBeenCalledTimes(1)
    expect(engine.v2Sessions.has(IM_KEY)).toBe(false)
    // The stopped message sent nothing, and is still in the record as before.
    expect(engine.send).not.toHaveBeenCalled()
    expect(sink.writeUserMessage).toHaveBeenCalled()
    expect(emitAgentEvent).toHaveBeenCalledWith('agent:complete', 'space-1', IM_KEY, expect.objectContaining({ type: 'complete' }))
    expect(isAppChatConversationGenerating(IM_KEY)).toBe(false)

    // The next message builds its own session, bound to its own context.
    await sendAppChatMessage(imTurn())
    expect(engine.leases).toHaveLength(2)
    expect(engine.leases[1].close).not.toHaveBeenCalled()
    expect(engine.v2Sessions.get(IM_KEY)).toBe(engine.leases[1].session)
    expect(engine.send).toHaveBeenCalledTimes(1)
  })

  it('a team session closed during a member’s cold start: the same', async () => {
    const { turn } = await startHeldInAcquire(teamTurn())

    await closeTeamSession(app.id, TEAM_ID, EPOCH_ID)

    engine.open()
    await turn

    expect(engine.leases).toHaveLength(1)
    expect(engine.leases[0].close).toHaveBeenCalledTimes(1)
    expect(engine.v2Sessions.has(TEAM_KEY)).toBe(false)
    expect(engine.send).not.toHaveBeenCalled()
  })

  it('a manual restart that reaches the message in the moment before it takes its warm session: the same', async () => {
    // The chat's warm session is registered; the message is about to take it.
    engine.v2Sessions.set(IM_KEY, { send: engine.send, setMaxThinkingTokens: vi.fn() })
    const { turn } = await startHeldInAcquire(imTurn())

    await restartAppChat(app.id, { interruptActive: true })
    expect(engine.closeV2Session).toHaveBeenCalledWith(IM_KEY)

    engine.open()
    await turn

    expect(engine.leases).toHaveLength(1)
    expect(engine.leases[0].close).toHaveBeenCalledTimes(1)
    expect(engine.v2Sessions.has(IM_KEY)).toBe(false)
  })

  it('a person’s stop resets nothing: the session the stopped message acquired stays warm for the next one', async () => {
    const { turn } = await startHeldInAcquire(imTurn())

    await stopAppChatConversation(IM_KEY)

    engine.open()
    await turn

    expect(engine.leases).toHaveLength(1)
    expect(engine.leases[0].close).not.toHaveBeenCalled()
    expect(engine.v2Sessions.get(IM_KEY)).toBe(engine.leases[0].session)
    expect(engine.send).not.toHaveBeenCalled()
  })

  it('a reset that lands once the message holds its session needs nothing more: that session was the reset’s to close', async () => {
    // The turn takes its session; the clear arrives before it can send.
    let clearing: Promise<void> | undefined
    engine.acquireV2Session.mockImplementationOnce(async (_spaceId: string, conversationId: string) => {
      const lease = await engine.acquire(conversationId)
      clearing = clearImSession(app.id, 'space-1', IM_CHAT.channel, IM_CHAT.chatType, IM_CHAT.chatId)
      return lease
    })

    await sendAppChatMessage(imTurn()).catch(() => undefined)
    await clearing

    expect(engine.leases).toHaveLength(1)
    // Retired by the reset itself; the turn closes nothing again.
    expect(engine.closeV2Session).toHaveBeenCalledWith(IM_KEY)
    expect(engine.leases[0].close).not.toHaveBeenCalled()
    expect(engine.v2Sessions.has(IM_KEY)).toBe(false)
    expect(engine.send).not.toHaveBeenCalled()
  })
})
