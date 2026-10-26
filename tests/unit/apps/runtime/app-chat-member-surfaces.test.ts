/**
 * Unit tests for the surfaces a digital-human turn mounts when the app running
 * it was built for a temporary collaboration.
 *
 * Such a member is deleted with the team, so anything whose only purpose is to
 * outlive the work is withheld: its memory (nothing will ever read the file) and
 * managing other digital humans (artifacts that would outlive their maker). The
 * team layer reports the fact (`TeamPromptContext.selfIsDisposable`); this test
 * pins what the turn does with it — the only place that can be wrong.
 *
 * The heavy module graph of app-chat.ts is stubbed (same scaffolding as
 * app-chat-trust-boundary.test.ts) so a turn runs without spawning a real CC
 * subprocess; the session layer is a fake whose send() settles the round.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// ============================================
// Mocks (must be declared before importing app-chat)
// ============================================

const MEMORY_INSTRUCTIONS = '## State | one-line summary'

const { getPromptInstructions, createHaloAppsMcpServer } = vi.hoisted(() => ({
  getPromptInstructions: vi.fn(),
  createHaloAppsMcpServer: vi.fn(() => ({ _isMcpServer: true, name: 'sentinel-halo-apps' })),
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

const { consumers, v2Sessions, send } = vi.hoisted(() => ({
  consumers: new Map<string, unknown>(),
  v2Sessions: new Map<string, unknown>(),
  send: vi.fn(),
}))

vi.mock('../../../../src/main/services/agent/session-manager', () => ({
  activeSessions: new Map(),
  hasPendingSessionInput: () => false,
  v2Sessions,
  closeV2Session: vi.fn(),
  acquireV2Session: vi.fn(async () => ({
    session: { send, setMaxThinkingTokens: vi.fn() },
    isCurrent: true,
    isUsable: true,
    onRetired: () => () => {},
    send,
    close: vi.fn(),
    release: vi.fn(),
  })),
  getConsumerHandle: (id: string) => consumers.get(id) ?? null,
  getRunningConsumerIds: () => Array.from(consumers.keys()),
  markTurnDispatched: vi.fn(),
  updateConsumerDisplayModel: vi.fn(),
}))

vi.mock('../../../../src/main/services/agent/control', () => ({
  stopGeneration: vi.fn(async () => {}),
  getSessionState: () => ({ isActive: false, thoughts: [] }),
}))

// The sink settles as soon as the message is handed to the session — this test
// asks what the turn was built with, not how the reply streams back.
const { sink, beginRound } = vi.hoisted(() => {
  const beginRound = vi.fn(() => ({
    done: Promise.resolve(),
    cancel: vi.fn(),
    noteAskedUser: vi.fn(),
    onProgress: undefined,
    onMessageAccepted: undefined,
    onReply: undefined,
  }))
  return {
    beginRound,
    sink: { writeUserMessage: vi.fn(), beginRound, setTurnIdentity: vi.fn() },
  }
})
vi.mock('../../../../src/main/apps/runtime/app-chat-sink', () => ({
  bindAppChatEngine: (sink: unknown) => sink,
  onAppChatRoundChange: () => () => {},
  getAppChatSink: () => sink,
  peekAppChatSink: () => undefined,
  hasActiveAppChatRound: () => false,
  getConversationsWithActiveRound: () => [],
  disposeAppChatSink: vi.fn(),
}))

// The team layer, reduced to the one fact app-chat reads from it.
const { buildPromptContext, getDelegatedPolicy } = vi.hoisted(() => ({
  buildPromptContext: vi.fn(),
  getDelegatedPolicy: vi.fn(() => undefined),
}))
// Partial: only the accessor is faked, so modules that merely read the runtime
// (live instances, the board) keep their real implementations.
vi.mock('../../../../src/main/apps/runtime/team', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getActiveTeamRuntime: () => ({
    buildPromptContext,
    getDelegatedPolicy,
    getTeamName: () => 'Test Team',
    noteEpochTurn: () => true,
    noteMemberStatusChanged: () => {},
    noteMemberTurnStarted: () => {},
    noteMemberTurnEnded: () => {},
    reconcileAwaitingDecision: () => {},
    recordToolAudit: () => {},
    maybeAutoNameConversation: () => {},
    bus: { drainMailbox: () => {} },
  }),
}))
vi.mock('../../../../src/main/apps/runtime/team/team-tools', () => ({
  createTeamMcpServer: () => ({ _isMcpServer: true, name: 'halo-team' }),
}))
// The base toolset reaches the digital-human tools through the app bridge.
vi.mock('../../../../src/main/services/app-bridge', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createHaloAppsMcpServer,
  getAppManager: () => ({ getApp: () => app, listEffectiveMcpApps }),
}))
const { buildUserSessionSdkOptions } = vi.hoisted(() => ({ buildUserSessionSdkOptions: vi.fn((_options: Record<string, unknown>) => ({})) }))
const { getEngineCapabilities } = vi.hoisted(() => ({ getEngineCapabilities: vi.fn((): unknown => null) }))
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
  // The real merge: what is under test here is that app-chat goes through it.
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
const { prepareNonVisionImageFallback } = vi.hoisted(() => ({ prepareNonVisionImageFallback: vi.fn((_params: unknown): any => undefined) }))
vi.mock('../../../../src/main/services/agent/image-attachments', () => ({ prepareNonVisionImageFallback }))
vi.mock('../../../../src/main/services/agent/helpers', () => ({
  getApiCredentials: vi.fn(async () => ({ provider: 'anthropic' })),
  getApiCredentialsForSelection: vi.fn(async () => ({ provider: 'anthropic' })),
  getWorkingDir: vi.fn(),
  getHeadlessElectronPath: vi.fn(() => '/electron'),
  getDbMcpServers: vi.fn(() => null),
}))
vi.mock('../../../../src/main/services/agent/events', () => ({ onAgentEvent: () => ({ dispose: () => {} }), emitAgentEvent: vi.fn() }))
// A borrowed turn lists the skills it could load; none here.
const { listLoadableSkillCopies } = vi.hoisted(() => ({ listLoadableSkillCopies: vi.fn((_spaceId: string): unknown[] => []) }))
vi.mock('../../../../src/main/apps/skill-discovery', () => ({ listLoadableSkillCopies }))
vi.mock('../../../../src/main/services/analytics/analytics.service', () => ({
  analytics: { track: vi.fn(), trackErrorSurface: vi.fn() },
}))
vi.mock('../../../../src/main/services/ai-browser', () => ({
  createAIBrowserMcpServer: vi.fn(),
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
const { createPersonContextMcpServer } = vi.hoisted(() => ({
  createPersonContextMcpServer: vi.fn((_caller: unknown) => ({ _isMcpServer: true, name: 'halo-person-context' })),
}))
vi.mock('../../../../src/main/apps/runtime/person-context-tool', () => ({
  createPersonContextMcpServer,
  personContextPrompt: () => 'person-context',
}))
vi.mock('../../../../src/main/apps/runtime/report-tool', () => ({
  createReportToolServer: () => ({ _isMcpServer: true, name: 'halo-report' }),
}))
const sessionRegistry = vi.hoisted(() => ({
  current: null as null | {
    register: ReturnType<typeof vi.fn>
    getPendingResume?: () => string | undefined
    getSessionRevision?: (appId: string, channel: string, chatId: string) => object | undefined
    getPushableSessions: () => []
  },
}))
const { loadChatSessionId } = vi.hoisted(() => ({ loadChatSessionId: vi.fn<[], string | undefined>() }))
vi.mock('../../../../src/main/apps/runtime/im-session-registry', () => ({
  getImSessionRegistry: () => sessionRegistry.current,
}))
vi.mock('../../../../src/main/apps/runtime/engine-selection', () => ({
  resolveAppSessionEngine: async (selection: { engineId?: string }) => selection.engineId ?? 'halo',
  prepareAppEngineSession: (options: { state: { sessionId?: string }; legacySessionId?: string }) => ({ resumeSessionId: options.state.sessionId ?? options.legacySessionId }),
}))

vi.mock('../../../../src/main/apps/runtime/session-store', () => ({
  saveChatEngineRouting: (_space: string, _app: string, _run: string, engineId: string, state: any = {}) => state.sessionId || state.binding || state.routingEngine ? state : { routingEngine: engineId },
  loadChatEngineState: () => ({ sessionId: loadChatSessionId() }),
  saveChatEngineBinding: vi.fn(() => true),
  loadChatSessionId,
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
}))

const { app, environment, activityStore, listEffectiveMcpApps } = vi.hoisted(() => {
  const app = {
    id: 'app-member',
    spaceId: 'space-1',
    status: 'active',
    permissions: { granted: [], denied: [] },
    userConfig: {},
    userOverrides: undefined as { engineId?: string } | undefined,
    spec: {
      name: 'Tester',
      type: 'automation',
      system_prompt: 'You test things.',
      config_schema: [],
      permissions: [],
      requires: { mcps: [] },
    },
  }
  return {
    app,
    environment: {
      spaceId: 'space-1',
      spacePath: '/tmp/halo-test/space',
      workDir: '/tmp/halo-test/space',
      memoryDir: '/tmp/halo-test/memory',
      mcpBindings: {} as Record<string, string>,
    },
    listEffectiveMcpApps: vi.fn((): unknown[] => []),
    activityStore: { getSessionEnvironment: vi.fn(), deleteSessionEnvironment: vi.fn(), pinSessionEnvironment: vi.fn() },
  }
})
vi.mock('../../../../src/main/apps/manager', () => ({
  getAppManager: () => ({ getApp: () => app, listEffectiveMcpApps }),
}))
vi.mock('../../../../src/main/apps/runtime/execution-environment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/main/apps/runtime/execution-environment')>()),
  resolveChatEnvironment: () => environment,
  validateExecutionEnvironment: vi.fn(),
  resolveExecutionEnvironment: () => environment,
  legacySessionEnvironmentKey: (appId: string, runId: string) => `legacy:${appId}:${runId}`,
  appChatRunId: (conversationId: string, appId: string) => `run-${conversationId}-${appId}`,
}))
vi.mock('../../../../src/main/apps/runtime/index', () => ({
  getAppMemoryService: () => ({
    getPromptInstructions,
  }),
  getActivityStore: () => activityStore,
}))
vi.mock('../../../../src/main/apps/runtime/turn/memory-lifecycle', () => ({
  prepareMemoryForTurn: vi.fn(async () => ({
    snapshot: {
      exists: false, totalLines: 0, sizeBytes: 0, nowBytes: 0, fullContent: null, headers: [], firstSection: null,
      layout: { file: '/tmp/memory.md', dataDir: '/tmp/memory', topicsDir: '/tmp/memory/topics', runDir: '/tmp/memory/run', archiveDir: '/tmp/memory/archive', snapshotsDir: '/tmp/memory/.snapshots', consolidationDir: '/tmp/memory/.consolidation', stateFile: '/tmp/memory/.state.json' },
      topics: { root: '/tmp/memory/topics', children: [], topicCount: 0, totalBytes: 0, truncated: false },
      runTotalCount: 0, archiveCount: 0,
    },
  })),
  requestAppMemoryConsolidation: vi.fn(),
  memoryPromptOptions: vi.fn(() => ({})),
  loadSpaceTopicsForTurn: vi.fn(async () => null),
  appMemoryGuard: vi.fn(() => ({ writable: [], readOnly: [], label: 'test' })),
  appMemorySettings: vi.fn(() => ({ enabled: true, autoConsolidate: true, cadence: 'diligent' })),
  appTurnFileAccess: vi.fn(() => ({
    cwd: '/tmp', memoryWritable: [], memoryReadable: [], attachedFiles: [],
    workspaceRoots: ['/tmp'], closed: [], hookGuarded: [], memorySystemPaths: [],
  })),
}))

vi.mock('../../../../src/main/services/memory-consolidation', () => ({
  requestConsolidation: vi.fn(),
}))

// ============================================
// Imports (after all mocks)
// ============================================

import { sendAppChatMessage } from '../../../../src/main/apps/runtime/app-chat'
import { hasChatBrowserContext, destroyAllChatBrowserContexts } from '../../../../src/main/apps/runtime/app-chat-browser'
import { createScopedBrowserContext } from '../../../../src/main/services/ai-browser'
import { acquireV2Session, updateConsumerDisplayModel } from '../../../../src/main/services/agent/session-manager'
import { getApiCredentialsForSelection, getDbMcpServers } from '../../../../src/main/services/agent/helpers'
import { resolveCredentialsForSdk } from '../../../../src/main/services/agent/sdk-config'
import { requestAppMemoryConsolidation, prepareMemoryForTurn, appMemorySettings, loadSpaceTopicsForTurn } from '../../../../src/main/apps/runtime/turn/memory-lifecycle'
import { generatePromptInstructions } from '../../../../src/main/platform/memory'
import { describeSelfInstance, formatInstanceTag } from '../../../../src/main/apps/runtime/live-instances'
import { setImPermissionContext, clearImPermissionContext } from '../../../../src/main/apps/runtime/im-permission-registry'
import { setActiveImChannelManager } from '../../../../src/main/apps/runtime/im-channels'
import { buildTeamSessionKey } from '../../../../src/shared/apps/team-types'
import { fullCapabilityPolicy } from '../../../../src/shared/apps/capability-policy'

beforeEach(() => {
  app.userOverrides = undefined
  getPromptInstructions.mockImplementation(generatePromptInstructions)
  send.mockClear()
  loadChatSessionId.mockReset()
  environment.mcpBindings = {}
  listEffectiveMcpApps.mockReset().mockReturnValue([])
  vi.mocked(getDbMcpServers).mockReset().mockReturnValue(null)
  // A chat's browser context lives with its engine session, and the mocked
  // session above never retires; without this, a context from an earlier
  // test would be found held by a live session.
  destroyAllChatBrowserContexts('test-reset')
  getEngineCapabilities.mockReturnValue({ features: { permissionRules: true, hooks: true } })
  sessionRegistry.current = null
  vi.mocked(prepareMemoryForTurn).mockClear()
  vi.mocked(loadSpaceTopicsForTurn).mockClear()
  vi.mocked(appMemorySettings).mockReturnValue({ enabled: true, autoConsolidate: true, cadence: 'diligent' })
})

const TEAM_ID = 'team-1'
const EPOCH_ID = 'epoch-1'
const CONVERSATION = buildTeamSessionKey(app.id, TEAM_ID, EPOCH_ID)

/** The turn as the runtime dispatches it: a teammate's message to this member. */
function memberTurn(opts: { origin?: 'colleague' | 'guest' } = {}): Parameters<typeof sendAppChatMessage>[0] {
  return {
    appId: app.id,
    spaceId: 'space-1',
    message: 'reply "ok"',
    conversationId: CONVERSATION,
    teamContext: {
      teamId: TEAM_ID,
      epochId: EPOCH_ID,
      // How a teammate's message reaches a member (see TeamTriggerContext).
      kind: 'message',
      fromAppId: 'app-coordinator',
      wait: false,
      correlationId: 'corr-1',
      ...(opts.origin ? { origin: opts.origin } : {}),
    },
  }
}

/** What the turn handed the session layer, once it had assembled everything. */
function mountedSurfaces(): { mcpServers: Record<string, unknown>; systemPrompt: string } {
  const call = buildUserSessionSdkOptions.mock.calls.at(-1) as unknown as [{ mcpServers: Record<string, unknown> }]
  const options = buildUserSessionSdkOptions.mock.results.at(-1)!.value as { systemPrompt?: string | { append: string } }
  return {
    mcpServers: call[0].mcpServers,
    systemPrompt: typeof options.systemPrompt === 'string' ? options.systemPrompt : options.systemPrompt?.append ?? '',
  }
}

function disposableMemberContext(): void {
  buildPromptContext.mockReturnValue({
    teamName: 'Temporary work',
    goal: 'Answer a test message',
    collabMode: 'free',
    escalationRouting: 'user',
    selfMemberName: 'tester',
    selfRole: 'QA',
    selfIsLead: false,
    selfIsDisposable: true,
    roster: [],
  })
}

function keptMemberContext(): void {
  buildPromptContext.mockReturnValue({
    teamName: 'Standing team',
    goal: 'Keep the release green',
    collabMode: 'free',
    escalationRouting: 'user',
    selfMemberName: 'tester',
    selfRole: 'QA',
    selfIsLead: false,
    selfIsDisposable: false,
    roster: [],
  })
}

describe('a temporary collaboration member mounts no memory and no digital-human tools', () => {
  beforeEach(() => {
    buildUserSessionSdkOptions.mockClear()
    beginRound.mockClear()
    getPromptInstructions.mockClear()
    createHaloAppsMcpServer.mockClear()
    vi.mocked(requestAppMemoryConsolidation).mockClear()
    disposableMemberContext()
  })

  it('never asks the digital human for its memory instructions', async () => {
    await sendAppChatMessage(memberTurn())
    expect(getPromptInstructions).not.toHaveBeenCalled()
    expect(mountedSurfaces().systemPrompt).not.toContain(MEMORY_INSTRUCTIONS)
  })

  it('mounts neither the memory tool nor the digital-human tools', async () => {
    await sendAppChatMessage(memberTurn())
    const servers = mountedSurfaces().mcpServers
    expect(Object.keys(servers)).not.toContain('halo-memory')
    expect(Object.keys(servers)).not.toContain('halo-apps')
    // Not merely uninjected — never built, so nothing can leak one back in.
    expect(createHaloAppsMcpServer).not.toHaveBeenCalled()
  })

  it('opens the session with no memory block and does no memory housekeeping', async () => {
    await sendAppChatMessage(memberTurn())
    const sent = send.mock.calls.at(-1)![0] as string
    expect(sent).not.toContain('## Memory')
    expect(requestAppMemoryConsolidation).not.toHaveBeenCalled()
  })

  it('accepts the next teammate message without a paused inherited MCP and restores it when enabled again', async () => {
    const connection = {
      id: 'original-connection', specId: 'messages', status: 'active',
      spec: { type: 'mcp', mcp_server: { transport: 'http', url: 'https://example.invalid/mcp' } },
    }
    const { getDbMcpServers: assembleServers } = await vi.importActual<typeof import('../../../../src/main/services/agent/helpers')>(
      '../../../../src/main/services/agent/helpers',
    )
    vi.mocked(getDbMcpServers).mockImplementation(assembleServers)
    listEffectiveMcpApps.mockReturnValue([connection])
    environment.mcpBindings = { messages: connection.id }
    loadChatSessionId.mockReturnValue('original-sdk-session')

    await sendAppChatMessage(memberTurn())
    expect(mountedSurfaces().mcpServers).toHaveProperty('messages')

    connection.status = 'paused'
    await sendAppChatMessage(memberTurn())
    expect(send).toHaveBeenCalledTimes(2)
    expect(mountedSurfaces().mcpServers).not.toHaveProperty('messages')
    expect(mountedSurfaces().mcpServers).toHaveProperty('halo-team')
    expect(vi.mocked(acquireV2Session).mock.calls.at(-1)!.slice(0, 4)).toEqual([
      'space-1', CONVERSATION, expect.any(Object), 'original-sdk-session',
    ])
    expect(environment.mcpBindings).toEqual({ messages: connection.id })

    connection.status = 'active'
    await sendAppChatMessage(memberTurn())
    expect(send).toHaveBeenCalledTimes(3)
    expect(mountedSurfaces().mcpServers).toHaveProperty('messages')
  })

  it('still gives the member the rest of its turn — the team channel and its work tools', async () => {
    await sendAppChatMessage(memberTurn())
    const servers = mountedSurfaces().mcpServers
    expect(Object.keys(servers)).toContain('halo-team')
    expect(Object.keys(servers)).toContain('web-search')
    expect(mountedSurfaces().systemPrompt).toContain('Team Session Context')
  })
})

describe('a kept digital human retains persistent memory through native file tools', () => {
  beforeEach(() => {
    buildUserSessionSdkOptions.mockClear()
    getPromptInstructions.mockClear()
    createHaloAppsMcpServer.mockClear()
    vi.mocked(requestAppMemoryConsolidation).mockClear()
    keptMemberContext()
  })

  it('mounts memory and the digital-human tools as before', async () => {
    await sendAppChatMessage(memberTurn())
    const { mcpServers, systemPrompt } = mountedSurfaces()
    expect(Object.keys(mcpServers)).not.toContain('halo-memory')
    expect(Object.keys(mcpServers)).toContain('halo-apps')
    expect(getPromptInstructions).toHaveBeenCalled()
    expect(systemPrompt).toContain(MEMORY_INSTRUCTIONS)
    expect(requestAppMemoryConsolidation).toHaveBeenCalled()
  })
})

describe('model-only relay context stays out of the human-readable record', () => {
  it.each(['native', 'im'] as const)('records clean content without invented provenance for a %s owner turn', async surface => {
    keptMemberContext()
    sink.writeUserMessage.mockClear()
    loadChatSessionId.mockReturnValue('saved-sdk-session')
    const register = vi.fn()
    sessionRegistry.current = { register, getPushableSessions: () => [] }
    const content = 'Use the attached report.\n\n[Attached files — use the Read tool to access their content]\n- [file] report.txt: /tmp/report.txt'
    const message = `${content}\n\n<relay-context>\n<relay-action>curl -H "Authorization: Bearer test-only-grant"</relay-action>\n</relay-context>`
    const images = [{ id: 'chart', type: 'image' as const, mediaType: 'image/png' as const, data: 'Y2hhcnQ=' }]
    const conversationId = surface === 'im' ? `app-chat:${app.id}:wecom-bot:direct:owner` : `app-chat:${app.id}`

    await sendAppChatMessage({
      appId: app.id, spaceId: 'space-1', conversationId,
      message, recorded: { content }, images, attachedFiles: ['/tmp/report.txt'],
    })

    expect(send).toHaveBeenCalledWith(message, expect.any(Function))
    expect(sink.writeUserMessage).toHaveBeenCalledOnce()
    expect(sink.writeUserMessage).toHaveBeenCalledWith(content, images, undefined, undefined, undefined)
    expect(sink.writeUserMessage.mock.calls[0][0]).not.toMatch(/curl|test-only-grant|<relay-/)
    if (surface === 'native') {
      expect(register).toHaveBeenCalledWith(app.id, 'native', 'default', 'direct', '', expect.objectContaining({ lastMessage: content }))
    } else {
      expect(register).not.toHaveBeenCalled()
    }
  })
})

describe('memory context across session lifecycles', () => {
  beforeEach(() => {
    keptMemberContext()
    buildUserSessionSdkOptions.mockClear()
    getPromptInstructions.mockClear()
    vi.mocked(requestAppMemoryConsolidation).mockClear()
  })

  it('sends a startup snapshot once, not on later resumed messages or into the recorded user text', async () => {
    const turn = memberTurn()
    await sendAppChatMessage(turn)
    expect(send.mock.calls.at(-1)![0]).toContain('## Memory')
    expect(sink.writeUserMessage.mock.calls.at(-1)![0]).toBe(turn.message)
    loadChatSessionId.mockReturnValue('saved-sdk-session')
    await sendAppChatMessage(turn)
    expect(send.mock.calls.at(-1)![0]).toBe(turn.message)
    expect(prepareMemoryForTurn).toHaveBeenCalledTimes(1)
    expect(loadSpaceTopicsForTurn).toHaveBeenCalledTimes(1)
    const tag = formatInstanceTag(describeSelfInstance({ conversationId: CONVERSATION }))
    expect(mountedSurfaces().systemPrompt).toContain(`Your History author tag is \`${tag}\``)
    expect(mountedSurfaces().systemPrompt).toContain('never invent authors for old entries')
    expect(send.mock.calls.flat().join('\n')).not.toMatch(/Running right now|No other instance|You are `team#/)
    expect(vi.mocked(acquireV2Session).mock.calls.at(-1)?.[9]).toEqual({ requireFreshInputs: true })
  })

  it('gives a fork its destination author even when resuming the source transcript', async () => {
    const conversationId = `app-chat:${app.id}:local:direct:fork-7`
    sessionRegistry.current = { register: vi.fn(), getPendingResume: () => 'source-sdk-session', getPushableSessions: () => [] }
    await sendAppChatMessage({ appId: app.id, spaceId: 'space-1', conversationId, message: 'continue' })
    const call = vi.mocked(acquireV2Session).mock.calls.at(-1)!
    expect(call[3]).toBe('source-sdk-session')
    expect(call[2]).toHaveProperty('forkSession', true)
    const tag = formatInstanceTag(describeSelfInstance({ conversationId }))
    expect(mountedSurfaces().systemPrompt).toContain(`Your History author tag is \`${tag}\``)
    expect(prepareMemoryForTurn).not.toHaveBeenCalled()
    expect(send.mock.calls.at(-1)![0]).toBe('continue')
  })

  it('refreshes owner and guest attribution for the same IM session without a repeated roster', async () => {
    const conversationId = `app-chat:${app.id}:wecom-bot:group:group-7`
    const turn = {
      appId: app.id, spaceId: 'space-1', conversationId, message: 'answer',
      imSession: { channel: 'wecom-bot', chatType: 'group' as const, displayName: 'Group', sessionId: 'inst:group-7' },
    }
    loadChatSessionId.mockReturnValue('saved-sdk-session')
    try {
      setImPermissionContext(conversationId, { senderId: 'guest', senderName: 'Guest', isOwner: false, guestPolicy: {} })
      await sendAppChatMessage(turn)
      expect(mountedSurfaces().systemPrompt).toMatch(/Your History author tag is `im-guest#[a-f0-9]{4}`/)
      expect(mountedSurfaces().systemPrompt).toContain('Do not reveal sensitive')
      setImPermissionContext(conversationId, { senderId: 'owner', senderName: 'Owner', isOwner: true, ownerIds: ['owner'] })
      await sendAppChatMessage(turn)
      expect(mountedSurfaces().systemPrompt).toMatch(/Your History author tag is `im#[a-f0-9]{4}`/)
      expect(mountedSurfaces().systemPrompt).not.toMatch(/Your History author tag is `im-guest#/)
      expect(vi.mocked(acquireV2Session).mock.calls.at(-1)?.[9]).toEqual({ requireFreshInputs: true })
      expect(send.mock.calls.map(([message]) => message)).toEqual(['answer', 'answer'])
      expect(send.mock.calls.every(([, onFailure]) => typeof onFailure === 'function')).toBe(true)
    } finally {
      clearImPermissionContext(conversationId)
    }
  })

  it('with memory disabled sends only the user message and skips all automatic memory work', async () => {
    vi.mocked(appMemorySettings).mockReturnValue({ enabled: false, autoConsolidate: true, cadence: 'diligent' })
    const turn = memberTurn()
    await sendAppChatMessage(turn)
    expect(getPromptInstructions).not.toHaveBeenCalled()
    expect(prepareMemoryForTurn).not.toHaveBeenCalled()
    expect(requestAppMemoryConsolidation).not.toHaveBeenCalled()
    expect(send.mock.calls.at(-1)![0]).toBe(turn.message)
    expect(mountedSurfaces().systemPrompt).not.toContain('Your History author tag')
    expect(mountedSurfaces().mcpServers).not.toHaveProperty('halo-memory')
  })
})

describe('a restricted borrowed turn keeps every tool-call watcher', () => {
  const guardSentinel = { matcher: 'Write', hooks: [async () => ({})] }

  beforeEach(() => {
    keptMemberContext()
    getDelegatedPolicy.mockReturnValue({ allowedTools: ['Read'] } as never)
    getEngineCapabilities.mockReturnValue({ features: { permissionRules: true, hooks: true } })
    buildUserSessionSdkOptions.mockReset()
    // What sdk-config installs for memoryGuard before the policy is applied.
    buildUserSessionSdkOptions.mockImplementation(() => ({ hooks: { PreToolUse: [guardSentinel] } }) as never)
  })

  afterEach(() => {
    getDelegatedPolicy.mockReturnValue(undefined as never)
    getEngineCapabilities.mockReturnValue(null)
    buildUserSessionSdkOptions.mockReset()
    buildUserSessionSdkOptions.mockImplementation(() => ({}) as never)
  })

  it('on an engine that cannot enforce a policy (Codex), a restricted turn does not start at all', async () => {
    app.userOverrides = { engineId: 'codex' }
    getEngineCapabilities.mockReturnValue({ features: { permissionRules: false, hooks: false } })
    vi.mocked(acquireV2Session).mockClear()
    await expect(sendAppChatMessage(memberTurn({ origin: 'colleague' }))).rejects.toThrow(/cannot hold/)
    expect(acquireV2Session).not.toHaveBeenCalled()
    expect(getEngineCapabilities).toHaveBeenCalledWith('codex')
  })

  it('on an engine that runs no hooks (Codex, dsh), a colleague turn with full reach does not start: nothing would record it', async () => {
    getDelegatedPolicy.mockReturnValue(null as never)
    getEngineCapabilities.mockReturnValue({ displayName: 'Codex', features: { permissionRules: false, hooks: false } })
    vi.mocked(acquireV2Session).mockClear()
    await expect(sendAppChatMessage(memberTurn({ origin: 'colleague' }))).rejects.toThrow(/running on Codex, which cannot keep a record/)
    expect(acquireV2Session).not.toHaveBeenCalled()
    expect(hasChatBrowserContext(CONVERSATION)).toBe(false)
  })

  it('a turn refused while being set up gives back the browser context it took', async () => {
    getEngineCapabilities.mockReturnValue({ features: { permissionRules: false, hooks: false } })
    vi.mocked(createScopedBrowserContext).mockClear()

    await expect(sendAppChatMessage(memberTurn({ origin: 'colleague' }))).rejects.toThrow(/cannot hold/)

    // No session took the context (the turn never reached one), so nothing
    // can hold it: it goes with the turn.
    expect(createScopedBrowserContext).toHaveBeenCalledTimes(1)
    expect(hasChatBrowserContext(CONVERSATION)).toBe(false)
  })

  const fileBoundaryMatchers = ['Read', 'Glob', 'Grep', 'Edit', 'MultiEdit', 'NotebookEdit']

  it('a teammate from this machine runs as the owner: no gate, no record, only the memory guard', async () => {
    await sendAppChatMessage(memberTurn())
    const options = buildUserSessionSdkOptions.mock.results.at(-1)!.value as {
      hooks: Record<string, Array<{ matcher?: string }>>
      disallowedTools?: string[]
    }
    expect(options.hooks.PreToolUse).toEqual([guardSentinel])
    expect(options.hooks.PostToolUse).toBeUndefined()
    expect(options.disallowedTools ?? []).not.toContain('Bash')
  })

  it('a colleague whose member grants everything keeps the owner\u2019s options, and the record', async () => {
    getDelegatedPolicy.mockReturnValue(null as never)
    vi.mocked(acquireV2Session).mockClear()
    await sendAppChatMessage(memberTurn({ origin: 'colleague' }))
    const options = buildUserSessionSdkOptions.mock.results.at(-1)!.value as {
      hooks: Record<string, Array<{ matcher?: string }>>
      disallowedTools?: string[]
      permissionMode?: string
    }
    expect(options.hooks.PreToolUse).toEqual([guardSentinel])
    expect(options.hooks.PostToolUse).toHaveLength(1)
    expect(options.hooks.PostToolUse[0].matcher).toBeUndefined()
    expect(options.disallowedTools ?? []).not.toContain('Bash')
    expect(options.permissionMode).toBeUndefined()
    // A session records calls only if it was built to.
    expect(vi.mocked(acquireV2Session).mock.calls.at(-1)?.[9]).toEqual({ requireFreshInputs: true, creationContext: 'delegation-audit' })
  })

  it('reads what is installed only when the switches leave the answer to it', async () => {
    // Listing skills opens every skill's file on the main thread.
    listLoadableSkillCopies.mockClear()
    await sendAppChatMessage(memberTurn({ origin: 'colleague' }))
    expect(listLoadableSkillCopies).not.toHaveBeenCalled()

    getDelegatedPolicy.mockReturnValue({ ...fullCapabilityPolicy(), allowedSkills: ['weekly-report'] } as never)
    await sendAppChatMessage(memberTurn({ origin: 'colleague' }))
    expect(listLoadableSkillCopies).toHaveBeenCalledTimes(1)
  })

  it('a request from another machine adds the audit and the file boundary without dropping the memory guard', async () => {
    await sendAppChatMessage(memberTurn({ origin: 'colleague' }))
    const call = buildUserSessionSdkOptions.mock.calls.at(-1) as unknown as [{ memoryGuard?: unknown }]
    expect(call[0].memoryGuard).toBeDefined()
    const options = buildUserSessionSdkOptions.mock.results.at(-1)!.value as {
      hooks: Record<string, Array<{ matcher?: string }>>
      disallowedTools: string[]
    }
    expect(options.hooks.PreToolUse[0]).toBe(guardSentinel)
    expect(options.hooks.PreToolUse.map(h => h.matcher)).toEqual(
      expect.arrayContaining(['Write', ...fileBoundaryMatchers])
    )
    expect(options.hooks.PostToolUse.map(h => h.matcher)).toEqual(expect.arrayContaining([undefined, 'Grep', 'Glob']))
    expect(options.disallowedTools).toContain('Bash')
  })
})

describe('the consumer of a digital-human chat knows the model\'s context window', () => {
  beforeEach(() => {
    keptMemberContext()
    vi.mocked(acquireV2Session).mockClear()
    vi.mocked(updateConsumerDisplayModel).mockClear()
    vi.mocked(resolveCredentialsForSdk).mockResolvedValueOnce({
      displayModel: 'test-model',
      sdkModel: 'test-model',
      anthropicApiKey: 'key',
      anthropicBaseUrl: 'https://example.invalid',
      capabilities: { contextWindow: 321_000 },
    } as never)
  })

  it('hands it over when the consumer is created and again on every reuse', async () => {
    // Its own conversation: an earlier case marked EPOCH_ID's as coming from outside.
    const own = buildTeamSessionKey(app.id, TEAM_ID, 'epoch-context-window')
    const turn = memberTurn()
    await sendAppChatMessage({ ...turn, conversationId: own, teamContext: { ...turn.teamContext!, epochId: 'epoch-context-window' } })

    const creation = vi.mocked(acquireV2Session).mock.calls.at(-1)![5] as { contextWindow?: number }
    expect(creation.contextWindow).toBe(321_000)
    // A reuse refreshes the consumer; leaving the window out would clear it.
    expect(updateConsumerDisplayModel).toHaveBeenLastCalledWith(own, 'test-model', 321_000)
  })
})

describe('the conversation list names a message of cards alone', () => {
  it('by its first card, as a space conversation would', async () => {
    const register = vi.fn()
    sessionRegistry.current = { register, getPushableSessions: () => [] }
    keptMemberContext()
    try {
      await sendAppChatMessage({
        appId: app.id,
        spaceId: 'space-1',
        message: '',
        references: [{ id: 'r1', source: { kind: 'file', path: '/spaces/a/src/a.ts', precision: 'lines' }, range: { startLine: 3, endLine: 5 } }],
      }).catch(() => {})
      expect(register.mock.calls[0]?.[5]).toMatchObject({ lastMessage: 'a.ts:3-5' })
    } finally {
      sessionRegistry.current = null
    }
  })
})


describe('live messages keep the current turn envelope', () => {
  beforeEach(() => {
    keptMemberContext()
    sink.setTurnIdentity.mockClear()
    prepareNonVisionImageFallback.mockReset().mockReturnValue(undefined)
  })

  afterEach(() => { prepareNonVisionImageFallback.mockReset().mockReturnValue(undefined) })

  it('invalidates live identity when app tool permissions change', async () => {
    await sendAppChatMessage({ appId: app.id, spaceId: 'space-1', conversationId: 'app-chat:app-member:local:direct:permission-snapshot', message: 'start' })
    const isCurrent = sink.setTurnIdentity.mock.calls.at(-1)![1] as () => boolean
    expect(isCurrent()).toBe(true)
    const prior = app.permissions
    try {
      app.permissions = { granted: ['ai-browser'], denied: [] } as any
      expect(isCurrent()).toBe(false)
    } finally {
      app.permissions = prior
    }
  })

  it('invalidates a borrowed live turn when its governing team policy changes', async () => {
    const turn = memberTurn({ origin: 'colleague' })
    getDelegatedPolicy.mockReturnValue({ allowedTools: ['Read'] } as never)
    await sendAppChatMessage({ ...turn, conversationId: buildTeamSessionKey(app.id, TEAM_ID, 'policy-snapshot'), teamContext: { ...turn.teamContext!, epochId: 'policy-snapshot' } })
    const isCurrent = sink.setTurnIdentity.mock.calls.at(-1)![1] as () => boolean
    expect(isCurrent()).toBe(true)
    getDelegatedPolicy.mockReturnValue({ allowedTools: [] } as never)
    expect(isCurrent()).toBe(false)
    getDelegatedPolicy.mockReturnValue(undefined)
  })

  it.each(['authorization', 'session'] as const)('keeps a changed IM %s revision invalid even after the same values return', async revisionKind => {
    let authorizationRevision = {}
    let sessionRevision = {}
    const channel = { enabled: true, appId: app.id, owners: ['owner'], permissionEnabled: true }
    setActiveImChannelManager({ getInstanceConfig: () => channel, getAuthorizationRevision: () => authorizationRevision } as never)
    const getRevision = vi.fn((_app: string, _channel: string, _chatId: string) => sessionRevision)
    sessionRegistry.current = { register: vi.fn(), getPushableSessions: () => [], getSessionRevision: getRevision }
    try {
      await sendAppChatMessage({
        appId: app.id, spaceId: 'space-1', conversationId: `app-chat:${app.id}:wecom-bot:group:revision-${revisionKind}`, message: 'start',
        imSession: { channel: 'wecom-bot', chatType: 'group', displayName: 'Group', sessionId: 'inst:room:7' },
        imPermission: { senderId: 'owner', senderName: 'Owner', isOwner: true, ownerIds: ['owner'] },
      })
      const isCurrent = sink.setTurnIdentity.mock.calls.at(-1)![1] as () => boolean
      expect(isCurrent()).toBe(true)
      expect(getRevision).toHaveBeenCalledWith(app.id, 'wecom-bot', 'room:7')
      if (revisionKind === 'authorization') {
        channel.owners = []
        authorizationRevision = {}
        channel.owners = ['owner']
        authorizationRevision = {}
      } else {
        sessionRevision = {}
      }
      expect(isCurrent()).toBe(false)
    } finally {
      setActiveImChannelManager(null)
      sessionRegistry.current = null
    }
  })

  it('prepares live images with the captured model and preserves the original image for recording', async () => {
    const credentials = { provider: 'openai' as const, model: 'captured-nonvision', baseUrl: 'https://example.invalid', apiKey: '' }
    vi.mocked(getApiCredentialsForSelection).mockResolvedValueOnce(credentials)
    await sendAppChatMessage({ appId: app.id, spaceId: 'space-1', conversationId: 'app-chat:app-member:local:direct:image-snapshot', message: 'start' })
    prepareNonVisionImageFallback.mockReturnValue({ contextBlock: '<halo_attachments>saved image</halo_attachments>\n', filePaths: ['/tmp/image.png'] })
    const prepare = sink.setTurnIdentity.mock.calls.at(-1)![2] as (text: string, images: unknown[]) => unknown
    const images = [{ id: 'image', mediaType: 'image/png', data: 'aGVsbG8=' }]
    expect(prepare('read the image', images)).toEqual({ text: '<halo_attachments>saved image</halo_attachments>\nread the image', images: undefined })
    expect(prepareNonVisionImageFallback.mock.calls.at(-1)![0]).toMatchObject({ credentials, images, scope: { workDir: environment.workDir } })
    expect(images).toHaveLength(1)
  })

  it('keeps slash commands inert and defers new attachment grants in a restricted turn', async () => {
    const turn = memberTurn({ origin: 'guest' })
    await sendAppChatMessage({ ...turn, conversationId: buildTeamSessionKey(app.id, TEAM_ID, 'restricted-live-input'), teamContext: { ...turn.teamContext!, epochId: 'restricted-live-input' } })
    const prepare = sink.setTurnIdentity.mock.calls.at(-1)![2] as (text: string, images?: unknown[]) => any
    const result = prepare('/dangerous-command')
    expect(result.text).toContain('/dangerous-command')
    expect(result.text.startsWith('/')).toBe(false)
    prepareNonVisionImageFallback.mockReturnValue({ contextBlock: 'image files', filePaths: ['/tmp/new-image.png'] })
    expect(prepare('read image', [{ id: 'img', mediaType: 'image/png', data: 'aGVsbG8=' }])).toBe(false)
  })
})


describe('a request from outside never operates Halo', () => {
  beforeEach(() => {
    keptMemberContext()
    buildUserSessionSdkOptions.mockClear()
    createPersonContextMcpServer.mockClear()
  })

  it.each([undefined, 'message'] as const)('withholds self-API credentials and owner surfaces from a colleague with full reach, kind %s', async kind => {
    const prior = app.permissions
    app.permissions = { granted: ['halo-api-ref'], denied: [] } as any
    try {
      const turn = memberTurn({ origin: 'colleague' })
      const epochId = `external-authority-${kind ?? 'missing'}`
      await sendAppChatMessage({ ...turn, conversationId: buildTeamSessionKey(app.id, TEAM_ID, epochId), teamContext: { ...turn.teamContext!, epochId, kind } })
      const options = buildUserSessionSdkOptions.mock.calls.at(-1)![0] as any
      expect(options.selfApiAccess).toBe(false)
      expect(options.mcpServers).not.toHaveProperty('halo-api-ref')
      expect(createPersonContextMcpServer).toHaveBeenLastCalledWith(expect.objectContaining({ authority: 'team' }))
    } finally {
      app.permissions = prior
    }
  })

  it('keeps the explicitly enabled self-API for a local owner turn', async () => {
    const prior = app.permissions
    app.permissions = { granted: ['halo-api-ref'], denied: [] } as any
    try {
      await sendAppChatMessage({ appId: app.id, spaceId: 'space-1', conversationId: 'app-chat:app-member:local:direct:owner-api', message: 'start' })
      const options = buildUserSessionSdkOptions.mock.calls.at(-1)![0] as any
      expect(options.selfApiAccess).toBe(true)
      expect(options.mcpServers).toHaveProperty('halo-api-ref')
      expect(createPersonContextMcpServer).toHaveBeenLastCalledWith(expect.objectContaining({ authority: 'owner' }))
    } finally {
      app.permissions = prior
    }
  })
})
