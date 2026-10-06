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
  v2Sessions,
  closeV2Session: vi.fn(),
  acquireV2Session: vi.fn(async () => ({
    session: { send, setMaxThinkingTokens: vi.fn() },
    isCurrent: true,
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
    sink: { writeUserMessage: vi.fn(), beginRound },
  }
})
vi.mock('../../../../src/main/apps/runtime/app-chat-sink', () => ({
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
}))
const { buildUserSessionSdkOptions } = vi.hoisted(() => ({ buildUserSessionSdkOptions: vi.fn(() => ({})) }))
const { getEngineCapabilities } = vi.hoisted(() => ({ getEngineCapabilities: vi.fn((): unknown => null) }))
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
  createAIBrowserMcpServer: vi.fn(),
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
const sessionRegistry = vi.hoisted(() => ({
  current: null as null | {
    register: ReturnType<typeof vi.fn>
    getPendingResume?: () => string | undefined
    getPushableSessions: () => []
  },
}))
const { loadChatSessionId } = vi.hoisted(() => ({ loadChatSessionId: vi.fn<[], string | undefined>() }))
vi.mock('../../../../src/main/apps/runtime/im-session-registry', () => ({
  getImSessionRegistry: () => sessionRegistry.current,
}))
vi.mock('../../../../src/main/apps/runtime/session-store', () => ({
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

const { app, environment, activityStore } = vi.hoisted(() => {
  const app = {
    id: 'app-member',
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
    environment: {
      spaceId: 'space-1',
      spacePath: '/tmp/halo-test/space',
      workDir: '/tmp/halo-test/space',
      memoryDir: '/tmp/halo-test/memory',
    },
    activityStore: { getSessionEnvironment: vi.fn(), deleteSessionEnvironment: vi.fn(), pinSessionEnvironment: vi.fn() },
  }
})
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
import { hasChatBrowserContext } from '../../../../src/main/apps/runtime/app-chat-browser'
import { createScopedBrowserContext } from '../../../../src/main/services/ai-browser'
import { acquireV2Session, updateConsumerDisplayModel } from '../../../../src/main/services/agent/session-manager'
import { resolveCredentialsForSdk } from '../../../../src/main/services/agent/sdk-config'
import { requestAppMemoryConsolidation, prepareMemoryForTurn, appMemorySettings, loadSpaceTopicsForTurn } from '../../../../src/main/apps/runtime/turn/memory-lifecycle'
import { generatePromptInstructions } from '../../../../src/main/platform/memory'
import { describeSelfInstance, formatInstanceTag } from '../../../../src/main/apps/runtime/live-instances'
import { setImPermissionContext, clearImPermissionContext } from '../../../../src/main/apps/runtime/im-permission-registry'
import { buildTeamSessionKey } from '../../../../src/shared/apps/team-types'

beforeEach(() => {
  getPromptInstructions.mockImplementation(generatePromptInstructions)
  send.mockClear()
  loadChatSessionId.mockReset()
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
function memberTurn(opts: { external?: boolean } = {}): Parameters<typeof sendAppChatMessage>[0] {
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
      ...(opts.external ? { external: true } : {}),
    },
  }
}

/** What the turn handed the session layer, once it had assembled everything. */
function mountedSurfaces(): { mcpServers: Record<string, unknown>; systemPrompt: string } {
  const call = buildUserSessionSdkOptions.mock.calls.at(-1) as unknown as [{ mcpServers: Record<string, unknown> }]
  const options = buildUserSessionSdkOptions.mock.results.at(-1)!.value as { systemPrompt?: string }
  return {
    mcpServers: call[0].mcpServers,
    systemPrompt: options.systemPrompt ?? '',
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
    getEngineCapabilities.mockReturnValue({ features: { permissionRules: false, hooks: false } })
    vi.mocked(acquireV2Session).mockClear()
    await expect(sendAppChatMessage(memberTurn())).rejects.toThrow(/cannot hold/)
    expect(acquireV2Session).not.toHaveBeenCalled()
  })

  it('a turn refused while being set up gives back the browser context it took', async () => {
    getEngineCapabilities.mockReturnValue({ features: { permissionRules: false, hooks: false } })
    vi.mocked(createScopedBrowserContext).mockClear()

    await expect(sendAppChatMessage(memberTurn())).rejects.toThrow(/cannot hold/)

    // A team session's context lives for the turn: released, it is gone.
    expect(createScopedBrowserContext).toHaveBeenCalledTimes(1)
    expect(hasChatBrowserContext(CONVERSATION)).toBe(false)
  })

  const fileBoundaryMatchers = ['Read', 'Glob', 'Grep', 'Edit', 'MultiEdit', 'NotebookEdit']

  it('a teammate from this machine gets the audit and the memory guard, but no path boundary', async () => {
    await sendAppChatMessage(memberTurn())
    const options = buildUserSessionSdkOptions.mock.results.at(-1)!.value as {
      hooks: Record<string, Array<{ matcher?: string }>>
    }
    expect(options.hooks.PreToolUse).toEqual([guardSentinel])
    expect(options.hooks.PostToolUse).toHaveLength(1)
    expect(options.hooks.PostToolUse[0].matcher).toBeUndefined()
  })

  it('a request from another machine adds the audit and the file boundary without dropping the memory guard', async () => {
    await sendAppChatMessage(memberTurn({ external: true }))
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
