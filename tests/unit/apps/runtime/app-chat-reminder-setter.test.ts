/**
 * Who set a reminder is the sender of the turn it was set in. The reminder
 * tool outlives that turn (a session's tools serve every later turn), and the
 * chat's last sender changes as soon as someone else writes in it, so the tool
 * asks for the turn's own sender: a guest writing in the group while the
 * owner's turn runs does not become the one who asked.
 *
 * Same scaffolding as app-chat-team-im-access.test.ts: a turn runs against a
 * fake session whose send() settles the round.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

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

const { send } = vi.hoisted(() => ({ send: vi.fn() }))

vi.mock('../../../../src/main/services/agent/session-manager', () => ({
  v2Sessions: new Map(),
  closeV2Session: vi.fn(),
  acquireV2Session: vi.fn(async () => ({
    session: { send, setMaxThinkingTokens: vi.fn() },
    isCurrent: true,
    send,
    close: vi.fn(),
    release: vi.fn(),
  })),
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
// tests ask what the turn was allowed to do, not how the reply streams back.
const { sink } = vi.hoisted(() => ({
  sink: {
    writeUserMessage: vi.fn(),
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
  getApiCredentialsForSource: vi.fn(),
  getWorkingDir: vi.fn(),
  getHeadlessElectronPath: vi.fn(() => '/electron'),
  getDbMcpServers: vi.fn(() => null),
}))
vi.mock('../../../../src/main/services/agent/events', () => ({ emitAgentEvent: vi.fn() }))
vi.mock('../../../../src/main/services/analytics/analytics.service', () => ({
  analytics: { track: vi.fn(), trackErrorSurface: vi.fn() },
}))
vi.mock('../../../../src/main/services/ai-browser', () => ({
  createAIBrowserMcpServer: vi.fn(() => ({ _isMcpServer: true, name: 'ai-browser' })),
  createScopedBrowserContext: vi.fn(() => ({ destroy: vi.fn(), ownedViewCount: 0, hasRevealedView: () => false })),
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
// The options each turn's reminder tool is made with.
const reminderTools = vi.hoisted(() => [] as Array<{ currentSetter: () => { id: string; name: string } | undefined }>)
vi.mock('../../../../src/main/apps/runtime/reminders/tool', () => ({
  createRemindersMcpServer: (options: (typeof reminderTools)[number]) => {
    reminderTools.push(options)
    return { _isMcpServer: true, name: 'halo-reminders' }
  },
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
vi.mock('../../../../src/main/apps/runtime/session-store', () => ({
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
    permissions: { granted: [], denied: [] },
    userConfig: {},
    userOverrides: undefined,
    spec: {
      name: 'Desk',
      type: 'automation',
      system_prompt: 'You answer people.',
      config_schema: [],
      permissions: [],
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
  // Memory off keeps these tests on the policy: nothing else differs per caller.
  appMemorySettings: vi.fn(() => ({ enabled: false, autoConsolidate: false, cadence: 'diligent' })),
  appTurnFileAccess: vi.fn(() => ({
    cwd: '/tmp/halo-test/space', memoryWritable: [], memoryReadable: [], attachedFiles: [],
    workspaceRoots: ['/tmp/halo-test/space'], closed: [], hookGuarded: [], memorySystemPaths: [],
  })),
}))
vi.mock('../../../../src/main/services/memory-consolidation', () => ({
  requestConsolidation: vi.fn(),
}))
// The skills the digital human can load: one a guest may be allowed, one not.
vi.mock('../../../../src/main/apps/skill-discovery', () => ({
  listLoadableSkillCopies: () => ['weekly-report', 'place-order'].map(dirName => ({
    name: dirName, description: '', scope: 'global', dirName,
    path: `/tmp/halo-test/skills/${dirName}`, content: `---\nname: ${dirName}\n---\nDo it.\n`,
  })),
}))

// ============================================
// Imports (after all mocks)
// ============================================

import { sendAppChatMessage, type AppChatRequest } from '../../../../src/main/apps/runtime/app-chat'
import { setImPermissionContext, clearAllImPermissionContexts, type ImPermissionContext } from '../../../../src/main/apps/runtime/im-permission-registry'

const GROUP = `app-chat:${app.id}:wecom-bot:group:g-1`
const owner: ImPermissionContext = { senderId: 'boss', senderName: 'Boss', isOwner: true, ownerIds: ['boss'] }
const guest: ImPermissionContext = { senderId: 'stranger', senderName: 'Stranger', isOwner: false, guestPolicy: { allowedTools: [] }, ownerIds: ['boss'] }

/** A turn of the digital human's own IM group chat, as dispatch-inbound or a reminder hands it over. */
function groupTurn(imPermission?: ImPermissionContext): AppChatRequest {
  return {
    appId: app.id, spaceId: 'space-1', message: 'remind me at five', conversationId: GROUP,
    imSession: { channel: 'wecom-bot', chatType: 'group', displayName: 'Ops group', sessionId: 'inst-1:g-1' },
    ...(imPermission ? { imPermission } : {}),
  }
}

describe('who set a reminder', () => {
  beforeEach(() => {
    reminderTools.length = 0
    clearAllImPermissionContexts()
  })

  it('is the sender of the turn it is set in, even after someone else wrote in the chat', async () => {
    await sendAppChatMessage(groupTurn(owner))
    // A guest writes in the group while the owner’s turn is still running.
    setImPermissionContext(GROUP, guest)

    expect(reminderTools.at(-1)!.currentSetter()).toEqual({ id: 'boss', name: 'Boss' })
  })

  it('follows the turn it is called in, not the one the session’s tools were made in', async () => {
    await sendAppChatMessage(groupTurn(owner))
    const madeInFirstTurn = reminderTools[0]
    await sendAppChatMessage(groupTurn(guest))

    expect(madeInFirstTurn.currentSetter()).toEqual({ id: 'stranger', name: 'Stranger' })
  })

  it('takes the chat’s last sender as it was when the turn began, for a turn without one of its own', async () => {
    setImPermissionContext(GROUP, owner)
    await sendAppChatMessage(groupTurn())
    setImPermissionContext(GROUP, guest)

    expect(reminderTools.at(-1)!.currentSetter()).toEqual({ id: 'boss', name: 'Boss' })
  })
})
