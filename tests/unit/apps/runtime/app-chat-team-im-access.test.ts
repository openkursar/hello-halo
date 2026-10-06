/**
 * Who an IM chat fronted by a team member answers to.
 *
 * The member serving a team-backed chat is held to the chat's owner/guest rules
 * exactly as a digital human's own IM chat is: the same permission context
 * (written by dispatch-inbound), the same capability policy, the same per-call
 * gate and file boundary. Three things are particular to the team session, and
 * this file pins them:
 *
 *   - the session is shared with the owner's own Halo window, which never reads
 *     the chat's last sender;
 *   - a guest's request travels on to teammates and later turns as work that
 *     entered from outside (team/external-origin.ts), so handing it to a
 *     teammate does not launder it;
 *   - a turn woken to continue such work stays restricted even when the chat
 *     cannot say who asked (after a restart) or an owner spoke last.
 *
 * The heavy module graph of app-chat.ts is stubbed (same scaffolding as
 * app-chat-member-surfaces.test.ts); the policy modules, the per-call gate and
 * the origin tracking are real.
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

const { getDelegatedPolicy, createTeamMcpServer } = vi.hoisted(() => ({
  getDelegatedPolicy: vi.fn((): unknown => undefined),
  createTeamMcpServer: vi.fn((_context: Record<string, unknown>) => ({ _isMcpServer: true, name: 'halo-team' })),
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
    noteMemberTurnEnded: () => {},
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

// ============================================
// Imports (after all mocks)
// ============================================

import { sendAppChatMessage, type AppChatRequest } from '../../../../src/main/apps/runtime/app-chat'
import { setImPermissionContext, clearAllImPermissionContexts } from '../../../../src/main/apps/runtime/im-permission-registry'
import type { ImPermissionContext } from '../../../../src/main/apps/runtime/im-permission-registry'
import { decideDelegatedTool } from '../../../../src/main/apps/runtime/delegation-gate'
import { hostSystemPromptText } from '../../../../src/main/services/agent/system-prompt'
import { buildTeamSessionKey } from '../../../../src/shared/apps/team-types'

// ============================================
// Helpers
// ============================================

const TEAM_ID = 'team-1'
const GUEST_POLICY = { allowedTools: ['Read', 'Glob', 'Grep'] }
const IM_GROUP = { channel: 'wecom-bot', chatType: 'group' as const, displayName: 'Ops group', sessionId: 'inst-1:g1' }

const guest: ImPermissionContext = {
  senderId: 'stranger', senderName: 'Stranger', isOwner: false, guestPolicy: GUEST_POLICY, ownerIds: ['boss'],
}
const listedOwner: ImPermissionContext = { senderId: 'boss', senderName: 'Boss', isOwner: true, ownerIds: ['boss'] }
/** Permission control off: everyone is an owner and no roster exists. */
const anyone: ImPermissionContext = { senderId: 'someone', senderName: 'Someone', isOwner: true }

/** One team conversation per test, so no test inherits another's origin or terms. */
let epochSeq = 0
function teamChat(): { conversationId: string; epochId: string } {
  const epochId = `epoch-${++epochSeq}`
  return { conversationId: buildTeamSessionKey(app.id, TEAM_ID, epochId), epochId }
}

function trigger(epochId: string, fields: Record<string, unknown>): AppChatRequest['teamContext'] {
  return { teamId: TEAM_ID, epochId, correlationId: `corr-${epochSeq}`, fromAppId: null, wait: false, ...fields }
}

/** A person's message in the team-fronted chat, as dispatch-inbound hands it over. */
function imTurn(chat: ReturnType<typeof teamChat>, external = false): AppChatRequest {
  return {
    appId: app.id, spaceId: 'space-1', message: 'hello', conversationId: chat.conversationId,
    imSession: IM_GROUP,
    teamContext: trigger(chat.epochId, { kind: 'human_message', ...(external ? { external: true } : {}) }),
  }
}

/** A later turn of the same chat, woken by a teammate's reply (team/index.ts resolveImRoute). */
function wokenTurn(chat: ReturnType<typeof teamChat>, external = false): AppChatRequest {
  return {
    appId: app.id, spaceId: 'space-1', message: '[Team message from researcher] done', conversationId: chat.conversationId,
    imSession: IM_GROUP,
    teamContext: trigger(chat.epochId, { kind: 'message', fromAppId: 'app-researcher', ...(external ? { external: true } : {}) }),
  }
}

/** The owner typing into the same team session from Halo: no kind, no IM framing. */
function ownTurn(chat: ReturnType<typeof teamChat>): AppChatRequest {
  return {
    appId: app.id, spaceId: 'space-1', message: 'from my desk', conversationId: chat.conversationId,
    teamContext: trigger(chat.epochId, {}),
  }
}

/** A digital human's own IM chat — the rules a team-fronted chat must match. */
function plainImTurn(chatId: string): AppChatRequest {
  return {
    appId: app.id, spaceId: 'space-1', message: 'hello',
    conversationId: `app-chat:${app.id}:wecom-bot:group:${chatId}`,
    imSession: { ...IM_GROUP, sessionId: `inst-1:${chatId}` },
  }
}

/** The SDK options the turn ended up with, after any policy narrowed them. */
function lastOptions(): Record<string, any> {
  return buildUserSessionSdkOptions.mock.results.at(-1)!.value
}

function lastSystemPrompt(): string {
  return hostSystemPromptText(lastOptions().systemPrompt)
}

function runsCommands(conversationId: string): boolean {
  return decideDelegatedTool(conversationId, 'Bash', { command: 'ls' }).allow
}

function teamToolsExternal(): boolean {
  return createTeamMcpServer.mock.calls.at(-1)![0].external === true
}

beforeEach(() => {
  buildUserSessionSdkOptions.mockClear()
  createTeamMcpServer.mockClear()
  getDelegatedPolicy.mockReturnValue(undefined)
})

afterEach(() => {
  clearAllImPermissionContexts()
})

// ============================================
// Tests
// ============================================

describe('a guest in a team-fronted chat is held exactly like a guest of a digital human', () => {
  it('gets the same narrowed tools, the same refusal and the same file boundary', async () => {
    const plain = plainImTurn('g-plain')
    setImPermissionContext(plain.conversationId!, guest)
    await sendAppChatMessage(plain)
    const reference = lastOptions()
    expect(reference.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'WebFetch']))
    expect(runsCommands(plain.conversationId!)).toBe(false)

    const chat = teamChat()
    setImPermissionContext(chat.conversationId, guest)
    await sendAppChatMessage(imTurn(chat, true))
    const fronted = lastOptions()

    expect(fronted.disallowedTools).toEqual(reference.disallowedTools)
    expect(fronted.allowedTools).toEqual(reference.allowedTools)
    expect(fronted.permissionMode).toBe('default')
    expect(runsCommands(chat.conversationId)).toBe(false)
    expect((fronted.hooks.PreToolUse as Array<{ matcher?: string }>).map(h => h.matcher))
      .toEqual(expect.arrayContaining(['Read', 'Write']))
    expect(decideDelegatedTool(chat.conversationId, 'Read', { file_path: '/etc/hosts' }).allow).toBe(false)
    expect(decideDelegatedTool(chat.conversationId, 'Read', { file_path: '/tmp/halo-test/space/notes.md' }).allow).toBe(true)
  })

  it('keeps its team tools, and what it hands on carries the guest origin', async () => {
    const chat = teamChat()
    setImPermissionContext(chat.conversationId, guest)
    await sendAppChatMessage(imTurn(chat, true))

    expect(Object.keys(lastOptions().mcpServers)).toEqual(expect.arrayContaining(['halo-team', 'halo-report']))
    expect(teamToolsExternal()).toBe(true)
  })

  it('is told who the owners are, as the guest of a digital human is', async () => {
    const chat = teamChat()
    setImPermissionContext(chat.conversationId, guest)
    await sendAppChatMessage(imTurn(chat, true))

    expect(lastSystemPrompt()).toContain('IM Security Rules')
    expect(lastSystemPrompt()).toContain('Your owner(s): boss.')
  })
})

describe('owners of a team-fronted chat keep full access', () => {
  it('a listed owner is unrestricted, and hands nothing on as a stranger', async () => {
    const chat = teamChat()
    setImPermissionContext(chat.conversationId, listedOwner)
    await sendAppChatMessage(imTurn(chat))

    expect(lastOptions().disallowedTools).toBeUndefined()
    expect(runsCommands(chat.conversationId)).toBe(true)
    expect(teamToolsExternal()).toBe(false)
  })

  it('with permission control off everyone is an owner, in either kind of chat', async () => {
    const plain = plainImTurn('g-open')
    setImPermissionContext(plain.conversationId!, anyone)
    await sendAppChatMessage(plain)
    expect(lastOptions().disallowedTools).toBeUndefined()
    expect(runsCommands(plain.conversationId!)).toBe(true)

    const chat = teamChat()
    setImPermissionContext(chat.conversationId, anyone)
    await sendAppChatMessage(imTurn(chat))
    expect(lastOptions().disallowedTools).toBeUndefined()
    expect(runsCommands(chat.conversationId)).toBe(true)
    expect(lastSystemPrompt()).not.toContain('IM Security Rules')
  })

  it('the owner typing into the same team session from Halo is never read as the chat guest', async () => {
    const chat = teamChat()
    setImPermissionContext(chat.conversationId, guest)
    await sendAppChatMessage(imTurn(chat, true))
    expect(runsCommands(chat.conversationId)).toBe(false)

    await sendAppChatMessage(ownTurn(chat))

    expect(lastOptions().disallowedTools).toBeUndefined()
    expect(runsCommands(chat.conversationId)).toBe(true)
    // The owner at their own keyboard ends the stranger's thread of work.
    expect(teamToolsExternal()).toBe(false)
  })
})

describe('work a guest set in motion stays restricted when it comes back', () => {
  it('a turn woken to continue it runs under the guest policy and keeps its origin', async () => {
    const chat = teamChat()
    setImPermissionContext(chat.conversationId, guest)
    await sendAppChatMessage(imTurn(chat, true))
    const guestTurn = lastOptions()

    // The teammate's own message carries no origin: the thread remembers it.
    await sendAppChatMessage(wokenTurn(chat))

    expect(lastOptions().disallowedTools).toEqual(guestTurn.disallowedTools)
    expect(runsCommands(chat.conversationId)).toBe(false)
    expect(teamToolsExternal()).toBe(true)
  })

  it('after a restart has forgotten the chat sender, it is held to the delegated policy, strictly', async () => {
    const chat = teamChat()
    await sendAppChatMessage(wokenTurn(chat, true))

    expect(lastOptions().disallowedTools).toEqual(expect.arrayContaining(['Bash', 'WebFetch']))
    expect(runsCommands(chat.conversationId)).toBe(false)
  })

  it('an owner speaking last in the chat does not lend it the owner reach', async () => {
    const chat = teamChat()
    setImPermissionContext(chat.conversationId, listedOwner)
    await sendAppChatMessage(wokenTurn(chat, true))

    expect(runsCommands(chat.conversationId)).toBe(false)
  })

  it('a teammate on this machine waking the front desk is unchanged', async () => {
    const chat = teamChat()
    setImPermissionContext(chat.conversationId, listedOwner)
    await sendAppChatMessage(wokenTurn(chat))

    expect(lastOptions().disallowedTools).toBeUndefined()
    expect(runsCommands(chat.conversationId)).toBe(true)
  })
})
