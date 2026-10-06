/**
 * Entry x capability matrix.
 *
 * Every place that starts an agent session assembles its own tool list and takes
 * the user's global AI settings from one shared builder. Each piece was once
 * forgotten by some entry (the run that shipped without Halo's documentation,
 * digital humans that ignored the user's disabled tools), because nothing
 * compared the entries with each other. This test does: it drives the REAL
 * entry points (space chat `sendMessage`, digital-human chat
 * `sendAppChatMessage`, automation `executeRun`) with the session layer faked,
 * and records what each one hands to it.
 *
 * The tables below record CURRENT behavior. A cell that looks wrong is listed
 * under SUSPICIOUS and left as it is: changing one is a product decision, made
 * by editing the table on purpose, not a side effect of a refactor.
 *
 * Adding a capability or a row: add the server id to the affected `EXPECTED_SERVERS`
 * rows (a server that appears in a row without being listed fails the row, so a
 * new one cannot slip in unclassified), and add a driver to `ROW_DRIVERS` for a
 * new entry.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// ============================================
// Shared, mutable test state
// ============================================

const state = vi.hoisted(() => ({
  config: {} as Record<string, any>,
  workDir: '',
  haloConfigDir: '',
  ccConfigDir: '',
  /** Options the session layer received, most recent last. */
  sessions: [] as Array<Record<string, any>>,
  engine: { features: { permissionRules: true, hooks: true } } as unknown,
  teamContext: null as unknown,
  memoryEnabled: true,
  sent: [] as string[],
}))

const { createHaloAppsMcpServer } = vi.hoisted(() => ({
  createHaloAppsMcpServer: vi.fn(() => ({ _isMcpServer: true, name: 'halo-apps' })),
}))

// ============================================
// Engine and config
// ============================================

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  unstable_v2_createSession: vi.fn(),
  tool: vi.fn((opts: any) => ({ ...opts, _isTool: true })),
  createSdkMcpServer: vi.fn((opts: any) => ({ name: opts.name, version: opts.version, tools: opts.tools, _isMcpServer: true })),
}))

vi.mock('../../../../src/main/foundation/config.service', () => ({
  getConfig: () => state.config,
  saveConfig: vi.fn(),
  getHaloDir: () => '/tmp/halo-matrix',
  getTempSpacePath: () => '/tmp/halo-matrix/temp',
  onApiConfigChange: vi.fn(),
  onAgentConfigChange: vi.fn(),
  onNetworkConfigChange: vi.fn(),
  resolveClaudeConfigDir: () => (state.config.agent?.configDirMode === 'cc' ? state.ccConfigDir : state.haloConfigDir),
}))

vi.mock('../../../../src/main/services/agent/resolved-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/main/services/agent/resolved-sdk')>()),
  getActiveEngine: () => null,
  getEngineCapabilities: () => state.engine,
  createSession: vi.fn(async () => {
    async function* stream() {
      yield {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'mcp__halo-report__report_to_user', input: {} }] },
      }
    }
    return { send: vi.fn((message: string) => state.sent.push(message)), close: vi.fn(), stream }
  }),
  query: vi.fn(),
}))

// Real option builder, faked credentials: what a session is built WITH is under test.
vi.mock('../../../../src/main/services/agent/sdk-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/main/services/agent/sdk-config')>()),
  resolveCredentialsForSdk: vi.fn(async () => ({
    displayModel: 'test-model',
    sdkModel: 'test-model',
    anthropicApiKey: 'key',
    anthropicBaseUrl: 'https://example.invalid',
    capabilities: {},
  })),
}))

// ============================================
// Session layer: captures the final options of every session
// ============================================

vi.mock('../../../../src/main/services/agent/session-manager', () => ({
  v2Sessions: new Map(),
  closeV2Session: vi.fn(),
  getConsumerHandle: () => null,
  getRunningConsumerIds: () => [],
  markTurnDispatched: vi.fn(),
  updateConsumerDisplayModel: vi.fn(),
  acquireV2Session: vi.fn(async (
    _spaceId: string, _conversationId: string, sdkOptions: Record<string, any>,
    _resume?: string, _workDir?: string, _consumer?: unknown, _kbIds?: unknown,
    buildMcpServers?: () => Record<string, unknown> | null,
  ) => {
    // What the real session manager does at creation.
    if (buildMcpServers) {
      const record = buildMcpServers()
      if (record && Object.keys(record).length > 0) sdkOptions.mcpServers = record
      else delete sdkOptions.mcpServers
    }
    state.sessions.push(sdkOptions)
    const session = { send: vi.fn((message: string) => state.sent.push(message)), setMaxThinkingTokens: vi.fn(), close: vi.fn() }
    return { session, isCurrent: true, send: session.send, close: session.close, release: vi.fn() }
  }),
}))
vi.mock('../../../../src/main/services/agent/control', () => ({
  stopGeneration: vi.fn(async () => {}),
  getSessionState: () => ({ isActive: false, thoughts: [] }),
}))
vi.mock('../../../../src/main/services/agent/events', () => ({ emitAgentEvent: vi.fn() }))
vi.mock('../../../../src/main/services/agent/reasoning-effort', () => ({ applyReasoningEffort: () => 0, pickReasoningEffort: () => undefined }))
vi.mock('../../../../src/main/services/agent/message-utils', () => ({
  buildMessageContent: (text: string) => text,
  formatCanvasContext: () => '',
}))
vi.mock('../../../../src/main/services/agent/image-attachments', () => ({
  prepareNonVisionImageFallback: () => undefined,
  OCR_TOOLSET_ID: 'ocr',
}))
vi.mock('../../../../src/main/services/agent/helpers', () => ({
  getApiCredentials: vi.fn(async () => ({ provider: 'anthropic', model: 'm' })),
  getApiCredentialsForSource: vi.fn(),
  getApiCredentialsForConversation: vi.fn(async () => ({ provider: 'anthropic', model: 'm' })),
  getWorkingDir: vi.fn(() => state.workDir),
  getHeadlessElectronPath: vi.fn(() => '/electron'),
  getDbMcpServers: vi.fn(() => null),
  getMcpServersForRequires: vi.fn(() => ({})),
}))
vi.mock('../../../../src/main/services/agent/permission-handler', () => ({
  createCanUseTool: vi.fn(() => vi.fn()),
}))
vi.mock('../../../../src/main/services/agent/knowledge-context', () => ({
  resolveConversationKnowledgeBases: vi.fn(() => []),
  resolveConversationKnowledgeBaseIds: vi.fn(() => []),
}))
vi.mock('../../../../src/main/services/agent/conversation-sink', () => ({ createConversationSink: vi.fn() }))
vi.mock('../../../../src/main/services/agent/goal', () => ({ prepareGoalInput: vi.fn(), setGoalForTurn: vi.fn() }))
vi.mock('../../../../src/main/services/agent/stream-processor', () => ({ flushToolStats: vi.fn() }))

// ============================================
// Toolset broker: real assembly, a fixed toolset catalog
// ============================================

vi.mock('../../../../src/main/services/agent/toolsets/registry', () => ({
  getAvailableToolsets: vi.fn(() => [{ id: 'ai-browser' }]),
  getToolset: vi.fn((id: string) =>
    id === 'ai-browser' ? { id, createServer: () => ({ _isMcpServer: true, name: id }) } : undefined
  ),
}))
vi.mock('../../../../src/main/services/agent/toolsets/state', () => ({
  getOpenToolsets: vi.fn(() => new Set<string>()),
  markOpen: vi.fn(),
  markClosed: vi.fn(),
}))
vi.mock('../../../../src/main/services/agent/toolsets/capability-index', () => ({ buildToolsetSection: vi.fn(() => '') }))
vi.mock('../../../../src/main/services/agent/toolsets/meta-server', () => ({
  createBrokerMetaServer: vi.fn(() => ({ _isMcpServer: true, name: 'capabilities' })),
  CAPABILITIES_SERVER_NAME: 'capabilities',
}))

// ============================================
// In-process servers and platform services
// ============================================

vi.mock('../../../../src/main/services/web-search', () => ({
  createWebSearchMcpServer: () => ({ _isMcpServer: true, name: 'web-search' }),
}))
vi.mock('../../../../src/main/services/official-docs-mcp', () => ({
  createOfficialDocsSession: () => ({ server: { _isMcpServer: true, name: 'halo-docs' }, guideConsulted: () => false }),
}))
vi.mock('../../../../src/main/services/ocr', () => ({
  createOcrMcpServer: () => ({ _isMcpServer: true, name: 'ocr' }),
}))
vi.mock('../../../../src/main/services/api-ref', () => ({
  createApiRefMcpServer: () => ({ _isMcpServer: true, name: 'halo-api-ref' }),
  HALO_API_USAGE_GUIDE: 'Halo API usage',
  HALO_API_TOOLSET_ID: 'halo-api-ref',
}))
// Only the mount decision is under test here; the server's own tools are covered in
// tests/unit/services/conversation-interop.
vi.mock('../../../../src/main/services/conversation-interop', () => ({
  createConversationInteropMcpServer: vi.fn((_scope: { spaceId: string; conversationId: string }) => ({ _isMcpServer: true, name: 'halo-conversations' })),
}))
vi.mock('../../../../src/main/services/email-mcp', () => ({
  createEmailMcpServer: () => ({ _isMcpServer: true, name: 'halo-email' }),
}))
vi.mock('../../../../src/main/services/ai-browser', () => ({
  createAIBrowserMcpServer: () => ({ _isMcpServer: true, name: 'ai-browser' }),
  createScopedBrowserContext: () => ({ destroy: vi.fn(), ownedViewCount: 0 }),
  AI_BROWSER_SYSTEM_PROMPT: 'AI browser instructions',
}))
vi.mock('../../../../src/main/services/ai-terminal', () => ({
  createTerminalMcpServer: vi.fn(),
  getGlobalTerminalContext: vi.fn(),
  isTerminalAvailable: () => false,
  AI_TERMINAL_SYSTEM_PROMPT: 'AI terminal instructions',
}))
vi.mock('../../../../src/main/services/tlon', () => ({
  getKBChatContext: vi.fn(() => null),
  getKBReferencesForApp: vi.fn(() => []),
}))
vi.mock('../../../../src/main/services/health', () => ({
  onAgentError: vi.fn(),
  runPpidScanAndCleanup: vi.fn(async () => {}),
}))
vi.mock('../../../../src/main/services/analytics/analytics.service', () => ({
  analytics: { track: vi.fn(async () => {}), trackErrorSurface: vi.fn() },
}))
vi.mock('../../../../src/main/services/conversation.service', () => ({
  addMessage: vi.fn((_s: string, _c: string, msg: Record<string, unknown>) => ({ id: 'msg-1', timestamp: 't', ...msg })),
  updateMessageById: vi.fn(),
  getConversation: vi.fn(() => ({ id: 'conv-1', sessionId: undefined })),
}))
vi.mock('../../../../src/main/services/space.service', async () => {
  const { resolveMemoryLayout } = await import('../../../../src/main/platform/memory/paths')
  return {
    getSpace: () => ({ id: 'space-1', path: state.workDir }),
    getSpaceDir: () => state.workDir,
    isSpaceMemoryEnabled: () => state.memoryEnabled,
    getSpaceMemoryLayout: () => resolveMemoryLayout({ type: 'user', spaceId: 'space-1', spacePath: state.workDir }, 'space'),
  }
})

// ============================================
// apps/runtime collaborators
// ============================================

vi.mock('../../../../src/main/apps/runtime/notify-tool', () => ({
  createNotifyToolServer: () => ({ _isMcpServer: true, name: 'halo-notify' }),
}))
vi.mock('../../../../src/main/apps/runtime/reminders/tool', () => ({
  createRemindersMcpServer: () => ({ _isMcpServer: true, name: 'halo-reminders' }),
}))
vi.mock('../../../../src/main/apps/runtime/notify-availability', () => ({
  resolveNotifyAvailability: () => ({
    channelsConfigured: false, emailChannelConfigured: false, imContactsAvailable: false,
    notifyBotAvailable: false, anyNotifyToolAvailable: false,
  }),
}))
vi.mock('../../../../src/main/apps/runtime/file-export-gate', () => ({ FileExportGate: vi.fn().mockImplementation(() => ({})) }))
vi.mock('../../../../src/main/apps/runtime/person-context-tool', () => ({
  createPersonContextMcpServer: () => ({ _isMcpServer: true, name: 'halo-person-context' }),
  personContextPrompt: () => 'person-context',
}))
vi.mock('../../../../src/main/apps/runtime/report-tool', () => ({
  createReportToolServer: () => ({ _isMcpServer: true, name: 'halo-report' }),
}))
vi.mock('../../../../src/main/apps/runtime/im-session-registry', () => ({ getImSessionRegistry: () => null }))
vi.mock('../../../../src/main/apps/runtime/im-auto-sync', () => ({ autoSyncRunResult: vi.fn(async () => ({})) }))
vi.mock('../../../../src/main/apps/runtime/active-runs', () => ({
  registerActiveRun: vi.fn(), unregisterActiveRun: vi.fn(), listActiveRuns: vi.fn(() => []),
}))
vi.mock('../../../../src/main/apps/runtime/session-store', () => ({
  openSessionWriter: vi.fn(() => ({ writeTrigger: vi.fn(), writeEvent: vi.fn() })),
  loadChatSessionId: () => undefined,
  saveChatSessionId: vi.fn(),
  deleteChatSessionId: vi.fn(),
  copySessionJsonl: vi.fn(),
  readSessionMessages: () => [],
}))
vi.mock('../../../../src/main/apps/runtime/memory-control', () => ({
  appConsolidationInputs: vi.fn(() => ({ appName: 'Tester' })),
}))

const sink = vi.hoisted(() => ({
  writeUserMessage: vi.fn(),
  beginRound: vi.fn(() => ({
    done: Promise.resolve(), cancel: vi.fn(), noteAskedUser: vi.fn(),
    onProgress: undefined, onMessageAccepted: undefined, onReply: undefined,
  })),
}))
vi.mock('../../../../src/main/apps/runtime/app-chat-sink', () => ({
  getAppChatSink: () => sink,
  peekAppChatSink: () => undefined,
  hasActiveAppChatRound: () => false,
  getConversationsWithActiveRound: () => [],
  disposeAppChatSink: vi.fn(),
}))

vi.mock('../../../../src/main/apps/runtime/team', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getActiveTeamRuntime: () => ({
    buildPromptContext: () => state.teamContext,
    getDelegatedPolicy: () => undefined,
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

const { app, environment } = vi.hoisted(() => {
  const app = {
    id: 'app-1',
    spaceId: 'space-1',
    status: 'active',
    permissions: { granted: [], denied: [] },
    userConfig: {},
    userOverrides: undefined,
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
    environment: { spaceId: 'space-1', spacePath: '', workDir: '', memoryDir: '/tmp/halo-matrix/memory' },
  }
})
vi.mock('../../../../src/main/apps/manager', () => ({
  getAppManager: () => ({ getApp: () => app, getAppWorkDir: () => '/tmp/halo-matrix/app' }),
}))
vi.mock('../../../../src/main/apps/runtime/execution-environment', () => ({
  resolveChatEnvironment: () => environment,
  resolveExecutionEnvironment: () => environment,
  validateExecutionEnvironment: vi.fn(),
  validateEnvironmentConnections: vi.fn(),
  missingConnections: vi.fn(() => []),
  legacySessionEnvironmentKey: (appId: string, runId: string) => `legacy:${appId}:${runId}`,
  appChatRunId: (conversationId: string, appId: string) => `run-${conversationId}-${appId}`,
}))
vi.mock('../../../../src/main/apps/runtime/index', async () => {
  const { generatePromptInstructions } = await import('../../../../src/main/platform/memory/prompt')
  return {
    getAppMemoryService: () => ({ getPromptInstructions: generatePromptInstructions, saveSessionSummary: vi.fn() }),
    getActivityStore: () => ({ getSessionEnvironment: vi.fn(), deleteSessionEnvironment: vi.fn(), pinSessionEnvironment: vi.fn() }),
  }
})
vi.mock('../../../../src/main/apps/runtime/turn/memory-lifecycle', () => ({
  prepareMemoryForTurn: vi.fn(async () => ({
    snapshot: {
      exists: false, totalLines: 0, sizeBytes: 0, nowBytes: 0, fullContent: null, headers: [], firstSection: null,
      layout: { file: '/m/memory.md', dataDir: '/m', topicsDir: '/m/topics', runDir: '/m/run', archiveDir: '/m/archive', snapshotsDir: '/m/.snapshots', consolidationDir: '/m/.c', stateFile: '/m/.state.json' },
      topics: { root: '/m/topics', children: [], topicCount: 0, totalBytes: 0, truncated: false },
      runTotalCount: 0, archiveCount: 0,
    },
    runTimestamp: '2026-08-30-1000',
  })),
  finalizeMemoryAfterTurn: vi.fn(async () => {}),
  requestAppMemoryConsolidation: vi.fn(),
  memoryPromptOptions: vi.fn(() => ({})),
  loadSpaceTopicsForTurn: vi.fn(async () => null),
  appMemoryGuard: vi.fn(() => ({ writable: [], readOnly: [], label: 'test' })),
  appMemorySettings: vi.fn(() => ({ enabled: state.memoryEnabled, autoConsolidate: true, cadence: 'diligent' })),
  appTurnFileAccess: vi.fn(() => ({
    cwd: '/tmp', memoryWritable: [], memoryReadable: [], attachedFiles: [],
    workspaceRoots: ['/tmp'], closed: [], hookGuarded: [], memorySystemPaths: [],
  })),
}))
vi.mock('../../../../src/main/services/memory-consolidation', () => ({ requestConsolidation: vi.fn() }))

// ============================================
// Imports (after all mocks)
// ============================================

import { sendMessage } from '../../../../src/main/services/agent/send-message'
import { sendAppChatMessage } from '../../../../src/main/apps/runtime/app-chat'
import { executeRun } from '../../../../src/main/apps/runtime/execute'
import { registerAppBridge } from '../../../../src/main/services/app-bridge'
import { createConversationInteropMcpServer } from '../../../../src/main/services/conversation-interop'
import { setConversationInteropFactory } from '../../../../src/main/services/agent/toolsets/broker'
import { setImPermissionContext, clearImPermissionContext } from '../../../../src/main/apps/runtime/im-permission-registry'
import { buildImSessionKey, buildTeamSessionKey } from '../../../../src/shared/apps/im-keys'
import { createSession } from '../../../../src/main/services/agent/resolved-sdk'
import { DEFAULT_DISABLED_TOOLS } from '../../../../src/shared/constants/disabled-tools'
import { generatePromptInstructions, MEMORY_FILE_FORMAT, TOPIC_FILE_FORMAT } from '../../../../src/main/platform/memory'
import { describeSelfInstance, formatInstanceTag } from '../../../../src/main/apps/runtime/live-instances'

// ============================================
// Row drivers: run the real entry, return the options it built the session with
// ============================================

interface Observed {
  /** Every in-process/external MCP server the session was started with. */
  servers: string[]
  maxTurns: number
  disallowedTools: string[]
  systemPrompt: string
  configDir: string
}

function observe(options: Record<string, any>): Observed {
  const prompt = options.systemPrompt
  return {
    servers: Object.keys(options.mcpServers ?? {}).sort(),
    maxTurns: options.maxTurns,
    disallowedTools: options.disallowedTools ?? [],
    systemPrompt: typeof prompt === 'string' ? prompt : (prompt?.append ?? ''),
    configDir: options.env?.CLAUDE_CONFIG_DIR,
  }
}

async function lastSession(run: () => Promise<unknown>): Promise<Observed> {
  state.sessions.length = 0
  await run()
  expect(state.sessions.length, 'the entry never started a session').toBeGreaterThan(0)
  return observe(state.sessions.at(-1)!)
}

const SPACE_ID = 'space-1'
const GUEST_KEY = () => buildImSessionKey(app.id, 'wecom-bot', 'direct', 'stranger')
const TEAM_KEY = () => buildTeamSessionKey(app.id, 'team-1', 'epoch-1')
// Its own epoch: a guest's turn marks its thread as coming from outside, which
// must not reach the plain team-member row.
const FRONTED_KEY = () => buildTeamSessionKey(app.id, 'team-1', 'epoch-im')

const chatTurn = (over: Record<string, unknown> = {}) => ({
  appId: app.id, spaceId: SPACE_ID, message: 'hello', ...over,
}) as Parameters<typeof sendAppChatMessage>[0]

function teamPromptContext(selfIsDisposable: boolean) {
  return {
    teamName: 'Team', goal: 'Goal', collabMode: 'free', escalationRouting: 'user',
    selfMemberName: 'tester', selfRole: 'QA', selfIsLead: false, selfIsDisposable, roster: [],
  }
}

const teamTurn = () => chatTurn({
  conversationId: TEAM_KEY(),
  teamContext: {
    teamId: 'team-1', epochId: 'epoch-1', kind: 'message', fromAppId: 'app-lead', wait: false, correlationId: 'c-1',
  },
})

const ROW_DRIVERS = {
  'space chat': () => lastSession(() => sendMessage({ spaceId: SPACE_ID, conversationId: 'conv-1', message: 'hello' })),
  'digital human chat (owner)': () => lastSession(() => {
    state.teamContext = null
    return sendAppChatMessage(chatTurn())
  }),
  'digital human chat (IM guest)': () => lastSession(() => {
    state.teamContext = null
    setImPermissionContext(GUEST_KEY(), { senderId: 'stranger', senderName: 'Stranger', isOwner: false, guestPolicy: {} })
    return sendAppChatMessage(chatTurn({
      conversationId: GUEST_KEY(),
      imSession: { channel: 'wecom-bot', chatType: 'direct', displayName: 'Stranger', sessionId: 'inst:stranger' },
    })).finally(() => clearImPermissionContext(GUEST_KEY()))
  }),
  'team member': () => lastSession(() => {
    state.teamContext = teamPromptContext(false)
    return sendAppChatMessage(teamTurn())
  }),
  'team member (disposable)': () => lastSession(() => {
    state.teamContext = teamPromptContext(true)
    return sendAppChatMessage(teamTurn())
  }),
  'team-fronted IM chat (guest)': () => lastSession(() => {
    state.teamContext = teamPromptContext(false)
    setImPermissionContext(FRONTED_KEY(), { senderId: 'stranger', senderName: 'Stranger', isOwner: false, guestPolicy: {} })
    return sendAppChatMessage(chatTurn({
      conversationId: FRONTED_KEY(),
      imSession: { channel: 'wecom-bot', chatType: 'group', displayName: 'Ops', sessionId: 'inst:ops' },
      teamContext: {
        teamId: 'team-1', epochId: 'epoch-im', kind: 'human_message', fromAppId: null, wait: false,
        correlationId: 'c-im', external: true,
      },
    })).finally(() => clearImPermissionContext(FRONTED_KEY()))
  }),
  'automation run': async () => {
    const store = {
      getRun: vi.fn(), pinRunEnvironment: vi.fn(), insertRun: vi.fn(), completeRun: vi.fn(),
      updateRunSessionId: vi.fn(), insertEntry: vi.fn(),
    } as any
    const memory = { getPromptInstructions: generatePromptInstructions, saveSessionSummary: vi.fn(async () => {}) } as any
    vi.mocked(createSession).mockClear()
    const result = await executeRun({
      app: { ...app, userOverrides: {} } as any,
      trigger: { type: 'manual', description: 'run' } as any,
      store,
      memory,
    })
    const calls = vi.mocked(createSession).mock.calls
    expect(calls.length, `the run never created a session: ${JSON.stringify(result)}`).toBeGreaterThan(0)
    return observe(calls.at(-1)![0] as Record<string, any>)
  },
} satisfies Record<string, () => Promise<Observed>>

type Row = keyof typeof ROW_DRIVERS
const ROWS = Object.keys(ROW_DRIVERS) as Row[]

// ============================================
// Tables (current behavior)
// ============================================

/**
 * Servers each entry starts with, exactly. A row lists only what the
 * configuration in `beforeEach` produces: every built-in capability on its
 * default, digital humans enabled, no external MCP apps, no email channel.
 */
const EXPECTED_SERVERS: Record<Row, readonly string[]> = {
  'space chat': ['capabilities', 'halo-apps', 'halo-conversations', 'halo-docs', 'web-search'],
  'digital human chat (owner)': [
    'ai-browser', 'halo-apps', 'halo-docs', 'halo-notify', 'halo-person-context', 'halo-reminders', 'ocr', 'web-search',
  ],
  // Only what the strict policy classes as safe survives the guest filter
  // (reminders included: a guest is offered no switch for them).
  'digital human chat (IM guest)': ['web-search'],
  'team member': [
    'ai-browser', 'halo-apps', 'halo-docs', 'halo-notify', 'halo-person-context', 'halo-report',
    'halo-team', 'ocr', 'web-search',
  ],
  'team member (disposable)': [
    'ai-browser', 'halo-docs', 'halo-notify', 'halo-person-context', 'halo-report', 'halo-team', 'ocr', 'web-search',
  ],
  // The same guest filter, plus the team channel the member is reached on.
  'team-fronted IM chat (guest)': ['halo-report', 'halo-team', 'web-search'],
  'automation run': [
    'ai-browser', 'halo-docs', 'halo-notify', 'halo-person-context', 'halo-report', 'ocr', 'web-search',
  ],
}

/** Entries that never mount halo-apps, so their prompt must not offer it. */
const NO_HALO_APPS_BY_DESIGN: ReadonlySet<Row> = new Set<Row>(['automation run', 'team member (disposable)'])
const DIGITAL_HUMANS_LINE = 'Halo Digital Humans: Create and manage'

// ============================================
// Setup
// ============================================

beforeAll(() => {
  state.workDir = mkdtempSync(join(tmpdir(), 'halo-matrix-work-'))
  state.haloConfigDir = mkdtempSync(join(tmpdir(), 'halo-matrix-cfg-'))
  state.ccConfigDir = mkdtempSync(join(tmpdir(), 'halo-matrix-cc-'))
  environment.spacePath = state.workDir
  environment.workDir = state.workDir
  registerAppBridge({
    getAppManager: () => null,
    createHaloAppsMcpServer,
    onMcpAppsChange: () => () => {},
  })
  // Bootstrap wires this seam in the running app; without it space chat never mounts halo-conversations.
  setConversationInteropFactory(createConversationInteropMcpServer)
})

afterAll(() => {
  for (const dir of [state.workDir, state.haloConfigDir, state.ccConfigDir]) rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  app.permissions = { granted: [], denied: [] } as any
  state.config = { agent: {}, notificationChannels: {} }
  state.teamContext = null
  state.engine = { features: { permissionRules: true, hooks: true } }
  state.memoryEnabled = true
  state.sent.length = 0
})

// ============================================
// The matrix
// ============================================

describe('entry x capability: servers each entry starts with', () => {
  for (const row of ROWS) {
    it(row, async () => {
      const observed = await ROW_DRIVERS[row]()
      expect(observed.servers).toEqual([...EXPECTED_SERVERS[row]].sort())
    })
  }
})

describe('entry x memory harness', () => {
  it.each(ROWS)('%s: shared format reaches the final engine prompt without a retired tool or roster', async row => {
    const { systemPrompt, servers } = await ROW_DRIVERS[row]()
    if (row === 'team member (disposable)') {
      expect(systemPrompt).not.toContain(MEMORY_FILE_FORMAT)
      expect(state.sent.join('\n')).not.toContain('## Memory')
    } else {
      expect(systemPrompt).toContain(MEMORY_FILE_FORMAT)
      expect(systemPrompt).toContain(TOPIC_FILE_FORMAT)
      expect(systemPrompt).toContain('Your History author tag is')
    }
    expect(servers).not.toContain('halo-memory')
    expect(systemPrompt).not.toContain('memory_status')
    expect(state.sent.join('\n')).not.toMatch(/Running right now|No other instance|You are `(?:chat|im|team|manual)#/)
  })

  it.each(ROWS)('%s: disabled memory does not describe automatic memory maintenance', async row => {
    state.memoryEnabled = false
    const { systemPrompt, servers } = await ROW_DRIVERS[row]()
    expect(systemPrompt).not.toContain(MEMORY_FILE_FORMAT)
    expect(state.sent.join('\n')).not.toContain('## Memory')
    expect(servers).not.toContain('halo-memory')
  })

  it('signs IM guest entries with runtime-owned provenance', async () => {
    const observed = await ROW_DRIVERS['digital human chat (IM guest)']()
    setImPermissionContext(GUEST_KEY(), { senderId: 'stranger', senderName: 'Stranger', isOwner: false, guestPolicy: {} })
    try {
      const tag = formatInstanceTag(describeSelfInstance({ conversationId: GUEST_KEY() }))
      expect(tag).toMatch(/^im-guest#/)
      expect(observed.systemPrompt).toContain(`Your History author tag is \`${tag}\``)
    } finally {
      clearImPermissionContext(GUEST_KEY())
    }
  })
})

describe('entry x global setting: every entry follows the user\'s AI settings', () => {
  describe.each(ROWS)('%s', (row) => {
    it('maxTurns', async () => {
      state.config.agent = { maxTurns: 7 }
      expect((await ROW_DRIVERS[row]()).maxTurns).toBe(7)
    })

    // A policy adds to the session's disallowedTools and never replaces them,
    // so the user's list reaches guests and borrowed turns too. A guest is also
    // held to a whitelist, which may deny the default tools for its own reasons.
    const policyAddsToDisallowed = row === 'digital human chat (IM guest)' || row === 'team-fronted IM chat (guest)'

    it('disabledTools replaces the built-in default list', async () => {
      state.config.agent = { disabledTools: ['UserDisabledTool'] }
      const { disallowedTools } = await ROW_DRIVERS[row]()
      expect(disallowedTools).toContain('UserDisabledTool')
      if (policyAddsToDisallowed) return
      for (const tool of DEFAULT_DISABLED_TOOLS) expect(disallowedTools).not.toContain(tool)
    })

    it('never configured disabledTools means the built-in defaults', async () => {
      state.config.agent = {}
      const { disallowedTools } = await ROW_DRIVERS[row]()
      for (const tool of DEFAULT_DISABLED_TOOLS) expect(disallowedTools).toContain(tool)
    })

    it('promptProfile picks the prompt template', async () => {
      state.config.agent = { promptProfile: 'halo' }
      const halo = (await ROW_DRIVERS[row]()).systemPrompt
      state.config.agent = { promptProfile: 'official' }
      const official = (await ROW_DRIVERS[row]()).systemPrompt
      expect(official).not.toBe(halo)
    })

    it('enableDigitalHumans: false removes halo-apps', async () => {
      state.config.agent = { enableDigitalHumans: false }
      expect((await ROW_DRIVERS[row]()).servers).not.toContain('halo-apps')
    })

    it('the prompt offers digital-human management only where it is on and halo-apps is mounted', async () => {
      state.config.agent = { enableDigitalHumans: true }
      const on = (await ROW_DRIVERS[row]()).systemPrompt
      state.config.agent = { enableDigitalHumans: false }
      const off = (await ROW_DRIVERS[row]()).systemPrompt
      expect(on.includes(DIGITAL_HUMANS_LINE)).toBe(!NO_HALO_APPS_BY_DESIGN.has(row))
      expect(off).not.toContain(DIGITAL_HUMANS_LINE)
    })

    it('configDirMode decides the engine config directory', async () => {
      state.config.agent = { configDirMode: 'halo' }
      expect((await ROW_DRIVERS[row]()).configDir).toBe(state.haloConfigDir)
      state.config.agent = { configDirMode: 'cc' }
      expect((await ROW_DRIVERS[row]()).configDir).toBe(state.ccConfigDir)
    })
  })
})

describe('entry x conversation collaboration: halo-conversations', () => {
  const COLLAB = 'conversation-collab'
  const grant = (): void => { app.permissions = { granted: [COLLAB], denied: [] } as any }

  // Where the switch applies. Space chat has no switch: it is the user's own conversation
  // and follows the global setting only.
  const SWITCHED: readonly Row[] = ['digital human chat (owner)', 'automation run']
  // Someone else acting through the digital human, or a team channel: never, switch or not.
  const NEVER: readonly Row[] = [
    'digital human chat (IM guest)', 'team member', 'team member (disposable)', 'team-fronted IM chat (guest)',
  ]

  it('a scheduled run acts under its own sender key, never its digital human\'s default chat', async () => {
    grant()
    vi.mocked(createConversationInteropMcpServer).mockClear()
    await ROW_DRIVERS['automation run']()
    const scope = vi.mocked(createConversationInteropMcpServer).mock.calls.at(-1)![0] as { conversationId: string }
    expect(scope.conversationId).toMatch(/^app-run:app-1:/)
  })

  it.each(SWITCHED)('%s: off by default, mounted once the owner grants it', async (row) => {
    expect((await ROW_DRIVERS[row]()).servers).not.toContain('halo-conversations')
    grant()
    expect((await ROW_DRIVERS[row]()).servers).toContain('halo-conversations')
  })

  it.each(SWITCHED)('%s: an explicit denial wins over a grant', async (row) => {
    app.permissions = { granted: [COLLAB], denied: [COLLAB] } as any
    expect((await ROW_DRIVERS[row]()).servers).not.toContain('halo-conversations')
  })

  it.each(NEVER)('%s: never mounted, even when the owner granted it', async (row) => {
    grant()
    expect((await ROW_DRIVERS[row]()).servers).not.toContain('halo-conversations')
  })

  // Which of the owner's own DH sessions get it: the ones the conversation directory can route replies to.
  describe('digital human chat (owner) by session kind', () => {
    const serversAt = async (conversationId: string): Promise<string[]> => {
      grant()
      state.teamContext = null
      return (await lastSession(() => sendAppChatMessage(chatTurn({ conversationId })))).servers
    }

    it('default and local sessions mount it', async () => {
      expect(await serversAt(`app-chat:${app.id}`)).toContain('halo-conversations')
      expect(await serversAt(`app-chat:${app.id}:local:direct:abc`)).toContain('halo-conversations')
    })

    it('an IM or HTTP session of the owner does not, switch or not', async () => {
      expect(await serversAt(buildImSessionKey(app.id, 'wecom-bot', 'direct', 'owner-chat'))).not.toContain('halo-conversations')
      expect(await serversAt(buildImSessionKey(app.id, 'wecom-bot', 'group', 'owner-group'))).not.toContain('halo-conversations')
      expect(await serversAt(`app-chat:${app.id}:http:direct:s1`)).not.toContain('halo-conversations')
    })
  })

  it.each([...SWITCHED, 'space chat' as Row])('%s: the global master switch removes it', async (row) => {
    grant()
    state.config.agent = { enableConversationInterop: false }
    expect((await ROW_DRIVERS[row]()).servers).not.toContain('halo-conversations')
  })

  it.each([...SWITCHED, 'space chat' as Row])('%s: read-only mode keeps the server (its send tool is what goes)', async (row) => {
    grant()
    state.config.agent = { enableConversationSend: false }
    expect((await ROW_DRIVERS[row]()).servers).toContain('halo-conversations')
  })
})

/*
 * SUSPICIOUS cells — recorded above as they are today, NOT changed:
 *
 * - IM guest and `halo-apps`: app-chat mounts it for anyone who is not a
 *   disposable member; only the strict capability policy removes it for a
 *   guest. It is a policy outcome, not an entry decision.
 * - The system prompt names the halo config directory whatever `configDirMode`
 *   is; only the subprocess's CLAUDE_CONFIG_DIR follows it.
 */
