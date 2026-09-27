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

const MEMORY_INSTRUCTIONS = 'SENTINEL-MEMORY-INSTRUCTIONS'

const { getPromptInstructions, createMemoryStatusMcpServer, createHaloAppsMcpServer } = vi.hoisted(() => ({
  getPromptInstructions: vi.fn(() => 'SENTINEL-MEMORY-INSTRUCTIONS'),
  createMemoryStatusMcpServer: vi.fn(() => ({ _isMcpServer: true, name: 'sentinel-halo-memory' })),
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

const { consumers, v2Sessions } = vi.hoisted(() => ({
  consumers: new Map<string, unknown>(),
  v2Sessions: new Map<string, unknown>(),
}))

vi.mock('../../../../src/main/services/agent/session-manager', () => ({
  v2Sessions,
  closeV2Session: vi.fn(),
  getOrCreateV2Session: vi.fn(async () => ({
    send: vi.fn(),
    setMaxThinkingTokens: vi.fn(),
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
vi.mock('../../../../src/main/apps/conversation-mcp', () => ({
  createHaloAppsMcpServer,
}))
vi.mock('../../../../src/main/platform/memory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/main/platform/memory')>()),
  createMemoryStatusMcpServer,
}))

const { buildBaseSdkOptions } = vi.hoisted(() => ({ buildBaseSdkOptions: vi.fn(() => ({})) }))
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
  buildBaseSdkOptions,
  // The real merge: what is under test here is that app-chat goes through it.
  addSdkHooks: (options: Record<string, any>, hooks: Record<string, unknown[]>) => {
    const merged: Record<string, unknown[]> = { ...(options.hooks ?? {}) }
    for (const [event, list] of Object.entries(hooks)) merged[event] = [...(merged[event] ?? []), ...list]
    options.hooks = merged
  },
}))
vi.mock('../../../../src/main/services/agent/reasoning-effort', () => ({
  applyReasoningEffort: () => 0,
}))

vi.mock('../../../../src/main/services/agent/permission-handler', () => ({
  createCanUseTool: vi.fn(() => vi.fn()),
}))
vi.mock('../../../../src/main/services/agent/message-utils', () => ({
  buildMessageContent: (text: string) => text,
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
  createScopedBrowserContext: vi.fn(),
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
  loadChatSessionId: () => undefined,
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
      runFiles: [], runTotalCount: 0, archiveCount: 0, lastModified: null,
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
import { getOrCreateV2Session } from '../../../../src/main/services/agent/session-manager'
import { requestAppMemoryConsolidation } from '../../../../src/main/apps/runtime/turn/memory-lifecycle'
import { buildTeamSessionKey } from '../../../../src/shared/apps/team-types'

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
  const call = buildBaseSdkOptions.mock.calls.at(-1) as unknown as [{ mcpServers: Record<string, unknown> }]
  const options = buildBaseSdkOptions.mock.results.at(-1)!.value as { systemPrompt?: string }
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
    buildBaseSdkOptions.mockClear()
    beginRound.mockClear()
    getPromptInstructions.mockClear()
    createMemoryStatusMcpServer.mockClear()
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
    expect(createMemoryStatusMcpServer).not.toHaveBeenCalled()
    expect(createHaloAppsMcpServer).not.toHaveBeenCalled()
  })

  it('opens the session with no memory block and does no memory housekeeping', async () => {
    await sendAppChatMessage(memberTurn())
    const sent = (sink.writeUserMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as string
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

describe('a digital human with a life beyond the work keeps both', () => {
  beforeEach(() => {
    buildBaseSdkOptions.mockClear()
    getPromptInstructions.mockClear()
    createMemoryStatusMcpServer.mockClear()
    createHaloAppsMcpServer.mockClear()
    vi.mocked(requestAppMemoryConsolidation).mockClear()
    keptMemberContext()
  })

  it('mounts memory and the digital-human tools as before', async () => {
    await sendAppChatMessage(memberTurn())
    const { mcpServers, systemPrompt } = mountedSurfaces()
    expect(Object.keys(mcpServers)).toContain('halo-memory')
    expect(Object.keys(mcpServers)).toContain('halo-apps')
    expect(getPromptInstructions).toHaveBeenCalled()
    expect(systemPrompt).toContain(MEMORY_INSTRUCTIONS)
    expect(requestAppMemoryConsolidation).toHaveBeenCalled()
  })
})

describe('a restricted borrowed turn keeps every tool-call watcher', () => {
  const guardSentinel = { matcher: 'Write', hooks: [async () => ({})] }

  beforeEach(() => {
    keptMemberContext()
    getDelegatedPolicy.mockReturnValue({ allowedTools: ['Read'] } as never)
    getEngineCapabilities.mockReturnValue({ features: { permissionRules: true, hooks: true } })
    buildBaseSdkOptions.mockReset()
    // What sdk-config installs for memoryGuard before the policy is applied.
    buildBaseSdkOptions.mockImplementation(() => ({ hooks: { PreToolUse: [guardSentinel] } }) as never)
  })

  afterEach(() => {
    getDelegatedPolicy.mockReturnValue(undefined as never)
    getEngineCapabilities.mockReturnValue(null)
    buildBaseSdkOptions.mockReset()
    buildBaseSdkOptions.mockImplementation(() => ({}) as never)
  })

  it('on an engine that cannot enforce a policy (Codex), a restricted turn does not start at all', async () => {
    getEngineCapabilities.mockReturnValue({ features: { permissionRules: false, hooks: false } })
    vi.mocked(getOrCreateV2Session).mockClear()
    await expect(sendAppChatMessage(memberTurn())).rejects.toThrow(/cannot hold/)
    expect(getOrCreateV2Session).not.toHaveBeenCalled()
  })

  const fileBoundaryMatchers = ['Read', 'Glob', 'Grep', 'Edit', 'MultiEdit', 'NotebookEdit']

  it('a teammate from this machine gets the audit and the memory guard, but no path boundary', async () => {
    await sendAppChatMessage(memberTurn())
    const options = buildBaseSdkOptions.mock.results.at(-1)!.value as {
      hooks: Record<string, Array<{ matcher?: string }>>
    }
    expect(options.hooks.PreToolUse).toEqual([guardSentinel])
    expect(options.hooks.PostToolUse).toHaveLength(1)
    expect(options.hooks.PostToolUse[0].matcher).toBeUndefined()
  })

  it('a request from another machine adds the audit and the file boundary without dropping the memory guard', async () => {
    await sendAppChatMessage(memberTurn({ external: true }))
    const call = buildBaseSdkOptions.mock.calls.at(-1) as unknown as [{ memoryGuard?: unknown }]
    expect(call[0].memoryGuard).toBeDefined()
    const options = buildBaseSdkOptions.mock.results.at(-1)!.value as {
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
