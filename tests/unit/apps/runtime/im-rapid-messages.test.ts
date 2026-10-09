/**
 * Two IM messages sent in quick succession to a digital human whose session is
 * still starting — a file, then what to do with it.
 *
 * The first message spends a while getting its session ready before its turn
 * is queued with the engine. A second message arriving in that window used to
 * read the conversation as idle and start a turn of its own; the engine folded
 * both into one turn and produced one answer, so the second message's turn
 * never came. The answer looked right, and some time later — when the session
 * was torn down — the chat received "Chat session ended before the message was
 * processed." for a message that had in fact been answered.
 *
 * Real here: dispatch-inbound, app-chat, its sink and live-turn state, the IM
 * permission registry and the delegation gate. The engine is a fake that
 * behaves like the real one where it matters: a message sent while a turn is
 * on its way is absorbed into that turn, which still ends with one result.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import type { ImChannelInstanceConfig, ImSessionRecord } from '../../../../src/shared/types/im-channel'
import type { ImSessionRegistry } from '../../../../src/main/apps/runtime/im-session-registry'

// ============================================
// Mocks (must be declared before importing the modules under test)
// ============================================

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  unstable_v2_createSession: vi.fn(),
  tool: vi.fn((opts: any) => ({ ...opts, _isTool: true })),
  createSdkMcpServer: vi.fn((opts: any) => ({ name: opts.name, version: opts.version, tools: opts.tools, _isMcpServer: true })),
}))

/**
 * The engine. A session is acquired after a cold start the test controls; a
 * message sent while a turn is already on its way joins that turn.
 */
const engine = vi.hoisted(() => {
  interface Turn { inputs: string[]; started: boolean }
  const state = {
    sinks: new Map<string, any>(),
    turns: new Map<string, Turn>(),
    answered: [] as string[][],
    coldStart: null as Promise<void> | null,
    releaseColdStart: () => {},
    credentials: null as Promise<void> | null,
    releaseCredentials: () => {},
    failNextCredentials: false,
  }
  function holdColdStart(): void {
    state.coldStart = new Promise<void>((resolve) => { state.releaseColdStart = resolve })
  }
  /** Credentials that take a while to resolve (a token refresh, a slow keychain). */
  function holdCredentials(): void {
    state.credentials = new Promise<void>((resolve) => { state.releaseCredentials = resolve })
  }
  function send(conversationId: string, content: string): void {
    const turn = state.turns.get(conversationId)
    if (turn) {
      turn.inputs.push(content)
      return
    }
    const next: Turn = { inputs: [content], started: false }
    state.turns.set(conversationId, next)
    setTimeout(() => {
      const sink = state.sinks.get(conversationId)
      next.started = true
      sink.onTurnStart()
      const answer = `answer to: ${next.inputs.join(' + ')}`
      sink.onRawMessage({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: answer }] } })
      state.turns.delete(conversationId)
      state.answered.push([...next.inputs])
      sink.onTurnComplete({
        finalContent: answer, hasMeaningfulContent: true, thoughts: [], tokenUsage: null,
        isInterrupted: false, wasAborted: false, hasErrorThought: false, reachedMaxTurns: false,
        firstEventReceived: true, drainTimedOut: false,
      })
    }, 5)
  }
  /** The session goes away (idle cleanup, rebuild, crash): its consumer stops. */
  function stopConsumer(conversationId: string): void {
    state.sinks.get(conversationId)?.onConsumerStopped()
  }
  function reset(): void {
    state.sinks.clear()
    state.turns.clear()
    state.answered.length = 0
    state.coldStart = null
    state.credentials = null
    state.failNextCredentials = false
  }
  return { state, send, stopConsumer, holdColdStart, holdCredentials, reset }
})

vi.mock('../../../../src/main/services/agent/session-manager', () => ({
  v2Sessions: new Map(),
  activeSessions: new Map(),
  closeV2Session: vi.fn(),
  acquireV2Session: vi.fn(async (_spaceId: string, conversationId: string, _options: unknown, _resume: unknown, _workDir: unknown, consumer: { sink: unknown }) => {
    engine.state.sinks.set(conversationId, consumer.sink)
    if (engine.state.coldStart) await engine.state.coldStart
    return {
      session: { send: vi.fn(), setMaxThinkingTokens: vi.fn() },
      isCurrent: true,
      send: async (content: string) => engine.send(conversationId, content),
      release: vi.fn(),
    }
  }),
  getConsumerHandle: (conversationId: string) => {
    const turn = engine.state.turns.get(conversationId)
    return turn?.started ? { isRunning: true, getActiveSessionState: () => ({ thoughts: [] }) } : null
  },
  getRunningConsumerIds: () => [],
  listResidentSessions: () => [],
  isSessionBusy: () => false,
  markTurnDispatched: vi.fn(),
  updateConsumerDisplayModel: vi.fn(),
}))

vi.mock('../../../../src/main/services/agent/control', () => ({
  stopGeneration: vi.fn(async () => {}),
  getSessionState: () => ({ isActive: false, thoughts: [] }),
}))

vi.mock('../../../../src/main/apps/runtime/team', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getActiveTeamRuntime: () => null,
}))
vi.mock('../../../../src/main/apps/team', () => ({ getTeamStore: () => undefined }))

const { buildUserSessionSdkOptions } = vi.hoisted(() => ({
  buildUserSessionSdkOptions: vi.fn((_input: Record<string, unknown>): Record<string, any> => ({})),
}))
vi.mock('../../../../src/main/services/agent/resolved-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/main/services/agent/resolved-sdk')>()),
  getEngineCapabilities: () => ({ features: { permissionRules: true, hooks: true } }),
}))
vi.mock('../../../../src/main/services/agent/sdk-config', () => ({
  resolveCredentialsForSdk: vi.fn(async () => ({
    displayModel: 'test-model', sdkModel: 'test-model', anthropicApiKey: 'key',
    anthropicBaseUrl: 'https://example.invalid', capabilities: {},
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
vi.mock('../../../../src/main/services/agent/permission-handler', () => ({ createCanUseTool: vi.fn(() => vi.fn()) }))
vi.mock('../../../../src/main/services/agent/message-utils', () => ({
  buildMessageContent: (text: string) => text,
  formatCanvasContext: () => '',
}))
vi.mock('../../../../src/main/services/agent/image-attachments', () => ({ prepareNonVisionImageFallback: () => undefined }))
vi.mock('../../../../src/main/services/agent/helpers', () => ({
  getApiCredentials: vi.fn(async () => {
    const failing = engine.state.failNextCredentials
    engine.state.failNextCredentials = false
    if (engine.state.credentials) await engine.state.credentials
    if (failing) throw new Error('No usable credentials')
    return { provider: 'anthropic' }
  }),
  getApiCredentialsForSource: vi.fn(),
  getWorkingDir: vi.fn(),
  getHeadlessElectronPath: vi.fn(() => '/electron'),
  getDbMcpServers: vi.fn(() => null),
}))
vi.mock('../../../../src/main/services/agent/events', () => ({ emitAgentEvent: vi.fn() }))
vi.mock('../../../../src/main/services/analytics/analytics.service', () => ({
  analytics: { track: vi.fn(), trackErrorSurface: vi.fn() },
}))
vi.mock('../../../../src/main/services/analytics/types', () => ({
  AnalyticsEvents: { MESSAGE_RECEIVED: 'message_received', MESSAGE_SENT: 'message_sent' },
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
vi.mock('../../../../src/main/services/ocr', () => ({ createOcrMcpServer: () => ({ _isMcpServer: true, name: 'ocr' }) }))
vi.mock('../../../../src/main/services/api-ref', () => ({
  createApiRefMcpServer: () => ({ _isMcpServer: true, name: 'halo-api-ref' }),
  HALO_API_USAGE_GUIDE: 'Halo API usage',
  HALO_API_TOOLSET_ID: 'halo-api-ref',
}))
vi.mock('../../../../src/main/services/email-mcp', () => ({
  createEmailMcpServer: () => ({ _isMcpServer: true, name: 'halo-email' }),
}))
vi.mock('../../../../src/main/services/official-docs-mcp', () => ({
  createOfficialDocsSession: () => ({ server: { _isMcpServer: true, name: 'halo-docs' }, guideConsulted: () => false }),
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
const { sessions, registry } = vi.hoisted(() => {
  const sessions = new Map<string, ImSessionRecord>()
  return {
    sessions,
    registry: {
      register: (...args: Parameters<ImSessionRegistry['register']>) => {
        const [appId, channel, chatId, chatType, instanceId, opts] = args
        const key = `${appId}:${channel}:${chatId}`
        const existing = sessions.get(key)
        const record: ImSessionRecord = {
          appId, channel, chatId, chatType, source: 'im', proactive: false,
          displayName: opts?.displayName ?? chatId, ...existing,
          instanceId, lastActiveAt: Date.now(), ...opts,
        }
        if (existing) Object.assign(existing, record)
        else sessions.set(key, record)
      },
      findSession: (appId: string, channel: string, chatId: string) => sessions.get(`${appId}:${channel}:${chatId}`),
      getSessionRevision: (appId: string, channel: string, chatId: string) => sessions.get(`${appId}:${channel}:${chatId}`),
      getPushableSessions: (appId: string) => [...sessions.values()].filter(session => session.appId === appId),
      clearPendingResume: vi.fn(),
      resetActivity: vi.fn(),
    },
  }
})
vi.mock('../../../../src/main/apps/runtime/im-session-registry', () => ({ getImSessionRegistry: () => registry }))
vi.mock('../../../../src/main/apps/runtime/session-store', () => ({
  loadChatSessionId: vi.fn(() => undefined),
  saveChatSessionId: vi.fn(),
  deleteChatSessionId: vi.fn(),
  copySessionJsonl: vi.fn(),
  readSessionMessages: () => [],
  resolveTranscriptPath: () => '',
  openSessionWriter: () => ({ writeTrigger: vi.fn(), writeEvent: vi.fn() }),
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
vi.mock('../../../../src/main/foundation/window.service', () => ({ sendToRenderer: vi.fn() }))
vi.mock('../../../../src/main/http/websocket', () => ({ broadcastToAll: vi.fn() }))
vi.mock('../../../../src/main/foundation/product-config', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getImChannelsPermissionDefaults: vi.fn(() => undefined),
}))

const { app, environment, activityStore } = vi.hoisted(() => ({
  app: {
    id: 'app-1', spaceId: 'space-1', specId: 'spec-1', status: 'active',
    permissions: { granted: [], denied: [] }, userConfig: {}, userOverrides: undefined,
    spec: { name: 'Helper', type: 'automation', system_prompt: 'You help.', config_schema: [], permissions: [], requires: { mcps: [] } },
  },
  environment: {
    spaceId: 'space-1', spacePath: '/tmp/halo-test/space', workDir: '/tmp/halo-test/space', memoryDir: '/tmp/halo-test/memory',
  },
  activityStore: { getSessionEnvironment: vi.fn(), deleteSessionEnvironment: vi.fn(), pinSessionEnvironment: vi.fn() },
}))
vi.mock('../../../../src/main/apps/manager', () => ({ getAppManager: () => ({ getApp: () => app }) }))
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
vi.mock('../../../../src/main/services/memory-consolidation', () => ({ requestConsolidation: vi.fn() }))

/** The IM channel the chat lives on: its config and what it pushed to the chat. */
const channel = vi.hoisted(() => ({
  config: { id: 'inst-1', type: 'wecom-bot', enabled: true, appId: 'app-1', config: {} } as ImChannelInstanceConfig,
  pushed: [] as string[],
}))
vi.mock('../../../../src/main/apps/runtime/im-channels', () => ({
  getActiveImChannelManager: () => ({
    getInstanceConfig: () => channel.config,
    getAuthorizationRevision: () => channel.config,
    getInstance: () => ({
      providerType: 'wecom-bot',
      pushToChat: vi.fn(async (_chatId: string, text: string) => { channel.pushed.push(text); return true }),
    }),
  }),
}))
vi.mock('../../../../src/main/apps/runtime/im-channels/owner-claim', () => ({ maybeClaimOwner: vi.fn(async () => false) }))

const relays = vi.hoisted(() => ({
  pending: false,
  openQuestion: false,
  preparation: null as Promise<void> | null,
  release: () => {},
  commit: vi.fn(),
}))
vi.mock('../../../../src/main/apps/runtime/pending-relays', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPendingRelayStore: () => ({
    peek: () => relays.pending ? [{ kind: 'push', id: 'question', at: Date.now(), source: { key: 'run', appId: 'app-1', runId: 'run-1' }, sourceOwner: true, message: 'Which region?', action: { kind: 'answer-question', appId: 'app-1', entryId: 'q-1' } }] : [],
    commit: () => { relays.pending = false; relays.commit() },
    clear: () => { relays.pending = false },
  }),
}))
vi.mock('../../../../src/main/apps/runtime/relay-actions', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../src/main/apps/runtime/relay-actions')>()
  return {
    ...actual,
    hasOpenImQuestion: () => relays.openQuestion,
    prepareRelayActions: async (_events: unknown[], isAuthorized: () => boolean) => {
      if (!isAuthorized()) throw new actual.RelayActionUnauthorizedError()
      if (relays.preparation) await relays.preparation
      if (!isAuthorized()) throw new actual.RelayActionUnauthorizedError()
      return new Map([['question', 'Submit the actual owner answer with the limited grant.']])
    },
  }
})

// ============================================
// Imports (after all mocks)
// ============================================

import { dispatchInboundMessage, releaseSupplementsWhenIdle } from '../../../../src/main/apps/runtime/dispatch-inbound'
import { clearAllImPermissionContexts } from '../../../../src/main/apps/runtime/im-permission-registry'
import { disposeAppChatSink } from '../../../../src/main/apps/runtime/app-chat-sink'
import { beginAppChatTurnStart, isAppChatConversationGenerating } from '../../../../src/main/apps/runtime/app-chat-live-turn'
import { sendAppChatMessage } from '../../../../src/main/apps/runtime/app-chat'
import { clearAllImStreamHandles, getImStreamHandle } from '../../../../src/main/apps/runtime/im-stream-registry'
import type { InboundMessage, ReplyHandle } from '../../../../src/shared/types/inbound-message'

// ============================================
// Helpers
// ============================================

const CHAT = 'app-chat:app-1:wecom-bot:group:g-1'
const DIRECT_CHAT = 'app-chat:app-1:wecom-bot:direct:boss'

function message(body: string, from = 'u1'): InboundMessage {
  return { body, from, fromName: from, channel: 'wecom-bot', chatType: 'group', chatId: 'g-1', timestamp: Date.now() }
}

/** A reply handle that records what the chat was sent. */
function replyTo(): ReplyHandle & { sent: string[] } {
  const sent: string[] = []
  return { sent, channel: 'wecom-bot', chatId: 'g-1', send: vi.fn(async (text: string) => { sent.push(text) }) }
}

/** Let the dispatch run until it is waiting on something outside it. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await new Promise((resolve) => setImmediate(resolve))
}

const isAnswer = (text: string): boolean => text.startsWith('answer to:')

const everythingSent = (...replies: Array<{ sent: string[] }>): string[] => [
  ...replies.flatMap((reply) => reply.sent),
  ...channel.pushed,
]

// The runtime wires this up at start; buffered messages wait on it.
let stopReleasingSupplements: () => void
beforeAll(() => {
  stopReleasingSupplements = releaseSupplementsWhenIdle()
})
afterAll(() => {
  stopReleasingSupplements()
})

beforeEach(() => {
  engine.reset()
  channel.config = { id: 'inst-1', type: 'wecom-bot', enabled: true, appId: 'app-1', config: {} }
  channel.pushed.length = 0
  sessions.clear()
  buildUserSessionSdkOptions.mockClear()
  relays.pending = false
  relays.openQuestion = false
  relays.preparation = null
  relays.commit.mockClear()
})

afterEach(() => {
  disposeAppChatSink(CHAT)
  disposeAppChatSink(DIRECT_CHAT)
  clearAllImPermissionContexts()
  clearAllImStreamHandles()
})

// ============================================
// Tests
// ============================================

describe('a second IM message arriving while the first is still starting', () => {
  it('is answered on its own, and the chat never receives a late error', async () => {
    engine.holdColdStart()
    const first = replyTo()
    const second = replyTo()

    void dispatchInboundMessage(message('[file] report.docx'), first, 'app-1', 'inst-1')
    await settle()
    void dispatchInboundMessage(message('summarize the file'), second, 'app-1', 'inst-1')
    await settle()

    engine.state.releaseColdStart()
    await vi.waitFor(() => expect(first.sent.some(isAnswer)).toBe(true))
    // Every chance for the second message to be answered before the session goes.
    await vi.waitFor(() => expect(second.sent.some(isAnswer)).toBe(true), { timeout: 500 }).catch(() => {})

    // The session goes away later — idle cleanup, a rebuild, a crash.
    engine.stopConsumer(CHAT)
    await settle()

    expect(everythingSent(first, second).filter((text) => text.includes('Error'))).toEqual([])
    expect(engine.state.answered).toEqual([
      [expect.stringContaining('report.docx')],
      [expect.stringContaining('summarize the file')],
    ])
  })

  it('is acknowledged as an addition and answered right after the first', async () => {
    engine.holdColdStart()
    const first = replyTo()
    const second = replyTo()

    void dispatchInboundMessage(message('[file] report.docx'), first, 'app-1', 'inst-1')
    await settle()
    void dispatchInboundMessage(message('summarize the file'), second, 'app-1', 'inst-1')
    await settle()

    expect(channel.pushed.some((text) => text.includes('已收到补充'))).toBe(true)
    expect(engine.state.answered).toHaveLength(0)

    engine.state.releaseColdStart()
    await vi.waitFor(() => expect(second.sent.some(isAnswer)).toBe(true))
  })

  it('runs under its own sender: a guest’s message is not run as the owner who wrote right after', async () => {
    channel.config = { ...channel.config, permissionEnabled: true, owners: ['boss'], guestPolicy: { allowedTools: ['Read'] } }
    engine.holdCredentials()

    void dispatchInboundMessage(message('read my notes', 'stranger'), replyTo(), 'app-1', 'inst-1')
    await settle()
    void dispatchInboundMessage(message('and tidy the repo', 'boss'), replyTo(), 'app-1', 'inst-1')
    await settle()
    engine.state.releaseCredentials()
    await vi.waitFor(() => expect(buildUserSessionSdkOptions).toHaveBeenCalled())

    const guestTurn = buildUserSessionSdkOptions.mock.results[0].value as { disallowedTools?: string[] }
    expect(guestTurn.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'WebFetch']))
  })
})

describe('a message stopped or failing on its way to the engine', () => {
  it('/stop while it is still starting holds it back: the engine never gets it', async () => {
    engine.holdColdStart()
    const first = replyTo()
    const stop = replyTo()

    void dispatchInboundMessage(message('[file] report.docx'), first, 'app-1', 'inst-1')
    await settle()
    void dispatchInboundMessage(message('/stop'), stop, 'app-1', 'inst-1')
    await settle()
    expect(stop.sent).toContain('Generation stopped.')

    engine.state.releaseColdStart()
    await settle()
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(engine.state.answered).toEqual([])
    expect(first.sent.some(isAnswer)).toBe(false)
    expect(first.sent.filter((text) => text.includes('Error'))).toEqual([])
  })

  it('a message sent after the stop is answered once the stopped one has unwound', async () => {
    engine.holdColdStart()
    void dispatchInboundMessage(message('[file] report.docx'), replyTo(), 'app-1', 'inst-1')
    await settle()
    void dispatchInboundMessage(message('/stop'), replyTo(), 'app-1', 'inst-1')
    await settle()
    const next = replyTo()
    void dispatchInboundMessage(message('never mind, just say hi'), next, 'app-1', 'inst-1')
    await settle()

    engine.state.releaseColdStart()
    await vi.waitFor(() => expect(next.sent.some(isAnswer)).toBe(true))
    expect(engine.state.answered).toEqual([[expect.stringContaining('just say hi')]])
  })

  it('a stopped message that then fails setting up sends nothing after "Generation stopped."', async () => {
    engine.holdCredentials()
    engine.state.failNextCredentials = true
    const first = replyTo()
    const stop = replyTo()

    void dispatchInboundMessage(message('[file] report.docx'), first, 'app-1', 'inst-1')
    await settle()
    void dispatchInboundMessage(message('/stop'), stop, 'app-1', 'inst-1')
    await settle()
    expect(stop.sent).toContain('Generation stopped.')

    engine.state.releaseCredentials()
    await settle()
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(everythingSent(first, stop).filter((text) => text.includes('Error'))).toEqual([])
  })

  it('a start that fails lets the message that waited behind it go next', async () => {
    engine.holdCredentials()
    engine.state.failNextCredentials = true
    const first = replyTo()
    const second = replyTo()

    void dispatchInboundMessage(message('[file] report.docx'), first, 'app-1', 'inst-1')
    await settle()
    void dispatchInboundMessage(message('summarize the file'), second, 'app-1', 'inst-1')
    await settle()
    engine.state.releaseCredentials()

    await vi.waitFor(() => expect(second.sent.some(isAnswer)).toBe(true))
    expect(first.sent.some((text) => text.includes('No usable credentials'))).toBe(true)
  })
})

describe('a relay action whose listener is still starting', () => {
  function directMessage(body: string): InboundMessage {
    return { ...message(body, 'boss'), chatType: 'direct', chatId: 'boss' }
  }

  function directReply(): ReplyHandle & { sent: string[] } {
    return { ...replyTo(), chatId: 'boss' }
  }

  beforeEach(() => {
    channel.config = { ...channel.config, permissionEnabled: true, owners: ['boss'] }
    relays.pending = true
    relays.openQuestion = true
    relays.preparation = new Promise(resolve => { relays.release = resolve })
  })

  it('holds the conversation before awaiting so a second message buffers', async () => {
    const first = directReply()
    const second = directReply()
    void dispatchInboundMessage(directMessage('华东吧'), first, 'app-1', 'inst-1')
    await settle()
    expect(isAppChatConversationGenerating(DIRECT_CHAT)).toBe(true)
    void dispatchInboundMessage(directMessage('按刚才说的继续'), second, 'app-1', 'inst-1')
    await settle()
    expect(channel.pushed.some(text => text.includes('已收到补充'))).toBe(true)
    expect(engine.state.answered).toEqual([])
    relays.release()
    await vi.waitFor(() => expect(second.sent.some(isAnswer)).toBe(true))
    expect(engine.state.answered).toHaveLength(2)
    expect(engine.state.answered[0][0]).toContain('华东吧')
    expect(engine.state.answered[1][0]).toContain('按刚才说的继续')
  })

  it.each([
    { command: '/stop', confirmation: 'Generation stopped.', retained: true },
    { command: '/clear', confirmation: 'Context cleared. Starting a fresh conversation.', retained: false },
  ])('honors $command while awaiting and disposes the unanswered stream', async ({ command, confirmation, retained }) => {
    channel.config = { ...channel.config, streaming: true }
    const first = directReply()
    first.streaming = { update: vi.fn(async () => {}), finish: vi.fn(async () => {}), dispose: vi.fn() }
    const control = directReply()
    const dispatch = dispatchInboundMessage(directMessage('华东吧'), first, 'app-1', 'inst-1')
    await settle()
    expect(isAppChatConversationGenerating(DIRECT_CHAT)).toBe(true)
    expect(getImStreamHandle(DIRECT_CHAT)).toBe(first.streaming)

    await dispatchInboundMessage(directMessage(command), control, 'app-1', 'inst-1')
    expect(control.sent).toContain(confirmation)
    relays.release()
    await dispatch

    expect(engine.state.answered).toEqual([])
    expect(relays.commit).not.toHaveBeenCalled()
    expect(relays.pending).toBe(retained)
    expect(first.sent).toEqual([])
    expect(first.streaming.dispose).toHaveBeenCalledOnce()
    expect(first.streaming.finish).not.toHaveBeenCalled()
    expect(getImStreamHandle(DIRECT_CHAT)).toBeUndefined()
    expect(isAppChatConversationGenerating(DIRECT_CHAT)).toBe(false)
  })

  it.each([
    { command: '/stop', confirmation: 'Generation stopped.' },
    { command: '/clear', confirmation: 'Context cleared. Starting a fresh conversation.' },
  ])('accepts the active owner’s private $command after the question was answered elsewhere', async ({ command, confirmation }) => {
    channel.config = { ...channel.config, replyScope: 'group', permissionEnabled: true, owners: ['boss'] }
    engine.holdCredentials()
    const first = directReply()
    const control = directReply()
    const dispatch = dispatchInboundMessage(directMessage('华东吧'), first, 'app-1', 'inst-1')
    relays.release()
    await settle()
    expect(isAppChatConversationGenerating(DIRECT_CHAT)).toBe(true)
    expect(engine.state.answered).toEqual([])
    relays.openQuestion = false

    await dispatchInboundMessage(directMessage(command), control, 'app-1', 'inst-1')
    expect(control.sent).toContain(confirmation)
    engine.state.releaseCredentials()
    await dispatch

    expect(engine.state.answered).toEqual([])
    expect(first.sent).toEqual([])
    expect(relays.commit).not.toHaveBeenCalled()
    expect(isAppChatConversationGenerating(DIRECT_CHAT)).toBe(false)
  })
})

describe('a turn decided before it could start', () => {
  it('keeps the chat busy from the decision; what arrived meanwhile goes right after it', async () => {
    // A teammate's wake to the member fronting this chat waits for a free slot
    // before it starts. An IM message arriving in that wait used to start a turn
    // of its own, and the wake started a second one on the same session.
    const hold = beginAppChatTurnStart(CHAT)
    const waiting = replyTo()
    void dispatchInboundMessage(message('are you there?'), waiting, 'app-1', 'inst-1')
    await settle()
    expect(engine.state.answered).toEqual([])

    await sendAppChatMessage({
      appId: 'app-1', spaceId: 'space-1', message: 'a teammate asks', conversationId: CHAT, turnStart: hold,
    })

    await vi.waitFor(() => expect(waiting.sent.some(isAnswer)).toBe(true))
    expect(engine.state.answered).toEqual([
      [expect.stringContaining('a teammate asks')],
      [expect.stringContaining('are you there?')],
    ])
  })
})
