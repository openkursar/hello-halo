/** Real chat entries, session leases, consumers and sinks; only external SDK and support I/O are stubbed. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import type { AISource } from '../../../../src/shared/types/ai-sources'
import type { InstalledApp } from '../../../../src/shared/apps/app-types'
import type { MemoryLayout, MemorySnapshot } from '../../../../src/main/platform/memory'

const m = vi.hoisted(() => ({
  createSession: vi.fn(),
  buildMemorySnapshot: vi.fn(),
  ensureMemoryFile: vi.fn(),
  writeTrigger: vi.fn(),
  writeEvent: vi.fn(),
  sourceRequests: [] as string[],
  workDir: '',
  memoryEnabled: false,
  app: null as InstalledApp | null,
  conversations: new Map<string, Record<string, any>>(),
}))

vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({
  createSession: m.createSession,
  query: vi.fn(),
  getActiveEngine: () => 'anthropic',
  getEngineCapabilities: () => ({ features: { permissionRules: true, hooks: true, goal: true } }),
}))
vi.mock('../../../../src/main/openai-compat-router', async () => ({
  ...await import('../../../../src/main/openai-compat-router/utils/config'),
  ensureOpenAICompatRouter: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:1', port: 1 })),
}))
// Source authentication is external; the real helpers still capture pins, epochs and routing descriptors.
vi.mock('../../../../src/main/services/ai-sources', async () => {
  const { getConfig } = await import('../../../../src/main/foundation/config.service')
  const getSource = (id: string) => getConfig().aiSources?.sources.find(source => source.id === id) ?? null
  return { getAISourceManager: () => ({
    ensureInitialized: async () => {},
    getCurrentSourceConfig: () => getSource(getConfig().aiSources!.currentId!),
    getSourceConfig: getSource,
    ensureValidToken: async (id: string) => ({ success: !!getSource(id)?.accessToken }),
    getBackendConfigForSource: (id: string, model: string) => {
      const source = getSource(id)
      m.sourceRequests.push(id)
      return source?.accessToken ? {
        sourceId: id, url: `${source.apiUrl}/responses`, key: source.accessToken, model,
        apiType: 'responses',
        headers: { Authorization: `Bearer ${source.accessToken}`, 'ChatGPT-Account-ID': source.accountId! },
      } : null
    },
  }) }
})
vi.mock('../../../../src/main/services/conversation.service', () => ({
  getConversation: (_space: string, id: string) => m.conversations.get(id) ?? null,
  addMessage: vi.fn((_space: string, id: string, message: Record<string, unknown>) => {
    const messages = m.conversations.get(id)!.messages as Array<Record<string, any>>
    const stored = { ...message, id: `message-${messages.length}`, timestamp: 'fixture' }
    messages.push(stored)
    return stored
  }),
  updateMessageById: vi.fn((_space: string, id: string, messageId: string, patch: object) => {
    const message = m.conversations.get(id)!.messages.find((item: any) => item.id === messageId)
    Object.assign(message, patch)
  }),
  updateLastMessage: vi.fn((_space: string, id: string, patch: object) => {
    Object.assign(m.conversations.get(id)!.messages.at(-1), patch)
  }),
  saveSessionId: vi.fn((_space: string, id: string, sessionId: string) => {
    m.conversations.get(id)!.sessionId = sessionId
  }),
}))
vi.mock('../../../../src/main/services/space.service', async () => {
  const { resolveMemoryLayout } = await import('../../../../src/main/platform/memory')
  return {
    getSpace: (id: string) => ({ id, name: 'Fixture space', path: m.workDir }),
    getSpaceDir: () => m.workDir,
    touchSpaceActivity: vi.fn(),
    isSpaceMemoryEnabled: () => m.memoryEnabled,
    getSpaceMemoryLayout: (spaceId: string) => resolveMemoryLayout({ type: 'user', spaceId, spacePath: m.workDir }, 'space'),
  }
})
vi.mock('../../../../src/main/platform/memory', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../src/main/platform/memory')>(),
  buildMemorySnapshot: m.buildMemorySnapshot,
  ensureMemoryFile: m.ensureMemoryFile,
}))
vi.mock('../../../../src/main/services/agent/mcp-auth-state', () => ({ purgeStaleMcpOAuth: vi.fn(async () => {}) }))
vi.mock('../../../../src/main/services/agent/mcp-manager', () => ({
  broadcastMcpStatus: vi.fn(), getCachedMcpStatus: vi.fn(), testMcpConnections: vi.fn(),
  onMcpServerRecovered: vi.fn(() => () => {}),
}))
vi.mock('../../../../src/main/services/agent/mcp-probe', () => ({ probeMcpApp: vi.fn(), probeUnhealthyServers: vi.fn() }))
vi.mock('../../../../src/main/services/agent/toolsets/broker', () => ({
  setSessionInvalidator: vi.fn(), buildCreationTimeServers: () => ({}), openToolset: () => ({ ok: true }),
}))
vi.mock('../../../../src/main/services/agent/toolsets/capability-index', () => ({ buildToolsetSection: () => '' }))
vi.mock('../../../../src/main/services/agent/toolsets/state', () => ({ getOpenToolsets: () => new Set(), dropConversationState: vi.fn() }))
vi.mock('../../../../src/main/services/agent/toolsets', () => ({
  listToolsets: vi.fn(), openToolsetByUser: vi.fn(), closeToolsetByUser: vi.fn(),
  openToolset: vi.fn(), closeToolset: vi.fn(), getToolset: vi.fn(),
}))
vi.mock('../../../../src/main/services/agent/toolsets/base', () => ({ buildBaseToolset: () => ({}) }))
vi.mock('../../../../src/main/services/tlon', () => ({
  getKBChatContext: () => null, getKBReferencesForApp: () => [],
  getKnowledgeBaseReference: () => null, resolveSourcesForReadPaths: () => [],
}))
vi.mock('../../../../src/main/services/agent/knowledge-context', () => ({
  resolveConversationKnowledgeBases: () => [], resolveConversationKnowledgeBaseIds: () => [],
}))
vi.mock('../../../../src/main/services/health', () => ({
  registerProcess: vi.fn(), unregisterProcess: vi.fn(), getCurrentInstanceId: () => null,
  onAgentError: vi.fn(), runPpidScanAndCleanup: vi.fn(async () => {}),
}))
vi.mock('../../../../src/main/services/analytics/analytics.service', () => ({
  analytics: { track: vi.fn(async () => {}), trackErrorSurface: vi.fn() },
}))
vi.mock('../../../../src/main/services/notification.service', () => ({ notifyTaskComplete: vi.fn() }))
vi.mock('../../../../src/main/foundation/logging', () => ({ isDeveloperMode: () => false }))
vi.mock('../../../../src/main/foundation/window.service', () => ({ sendToRenderer: vi.fn() }))
vi.mock('../../../../src/main/http/websocket', () => ({ broadcastToAll: vi.fn() }))

// Digital-human persistence, channel services and tool servers share the same harness as space chat.
vi.mock('../../../../src/main/apps/manager', () => ({ getAppManager: () => ({ getApp: () => m.app }) }))
vi.mock('../../../../src/main/apps/runtime', async () => {
  const { generatePromptInstructions } = await import('../../../../src/main/platform/memory')
  return {
    getActivityStore: () => ({}),
    getAppMemoryService: () => ({ getPromptInstructions: generatePromptInstructions }),
  }
})
vi.mock('../../../../src/main/apps/runtime/execution-environment', () => ({
  resolveChatEnvironment: () => ({
    spaceId: 'space', spacePath: m.workDir, workDir: m.workDir,
    memoryDir: join(m.workDir, '.halo', 'apps', 'handoff-app'),
  }),
  validateEnvironmentConnections: vi.fn(),
  appChatRunId: () => 'chat',
  resolveExecutionEnvironment: vi.fn(), validateExecutionEnvironment: vi.fn(), legacySessionEnvironmentKey: vi.fn(),
}))
vi.mock('../../../../src/main/apps/runtime/session-store', () => ({
  openSessionWriter: () => ({ writeTrigger: m.writeTrigger, writeEvent: m.writeEvent }),
  loadChatSessionId: () => undefined, saveChatSessionId: vi.fn(), deleteChatSessionId: vi.fn(),
  copySessionJsonl: vi.fn(), readSessionMessages: () => [], readSessionTranscript: vi.fn(), readSessionMessageThoughts: vi.fn(),
}))
vi.mock('../../../../src/main/apps/runtime/team', () => ({ getActiveTeamRuntime: () => null }))
vi.mock('../../../../src/main/apps/runtime/team/team-tools', () => ({ createTeamMcpServer: vi.fn() }))
vi.mock('../../../../src/main/apps/team', () => ({ getTeamStore: () => null }))
vi.mock('../../../../src/main/apps/runtime/im-session-registry', () => ({ getImSessionRegistry: () => null }))
vi.mock('../../../../src/main/apps/runtime/im-channels', () => ({ getActiveImChannelManager: () => null }))
vi.mock('../../../../src/main/apps/runtime/im-channels/file-send-mcp', () => ({ createFileSendMcpServer: vi.fn() }))
vi.mock('../../../../src/main/apps/runtime/dispatch-inbound', () => ({ clearSupplementBuffer: vi.fn() }))
vi.mock('../../../../src/main/apps/runtime/conversation-collab', () => ({ resolveConversationCollab: () => null, createConversationCollabMcpServer: vi.fn() }))
vi.mock('../../../../src/main/apps/runtime/notify-tool', () => ({ createNotifyToolServer: () => ({}) }))
vi.mock('../../../../src/main/apps/runtime/reminders/tool', () => ({ createRemindersMcpServer: () => ({}) }))
vi.mock('../../../../src/main/apps/runtime/person-context-tool', () => ({ createPersonContextMcpServer: () => ({}), personContextPrompt: () => '' }))
vi.mock('../../../../src/main/apps/runtime/report-tool', () => ({ createReportToolServer: vi.fn() }))
vi.mock('../../../../src/main/services/notify-channels', () => ({ getEnabledChannels: () => [] }))
vi.mock('../../../../src/main/services/memory-consolidation', () => ({ requestConsolidation: vi.fn() }))
vi.mock('../../../../src/main/platform/task-state', () => ({ getTaskStateService: () => null }))
vi.mock('../../../../src/main/services/ai-browser', () => ({
  AI_BROWSER_SYSTEM_PROMPT: '', createAIBrowserMcpServer: vi.fn(), createScopedBrowserContext: vi.fn(),
}))
vi.mock('../../../../src/main/services/ai-terminal', () => ({
  AI_TERMINAL_SYSTEM_PROMPT: '', isTerminalAvailable: () => false, createTerminalMcpServer: vi.fn(), getGlobalTerminalContext: vi.fn(),
}))
vi.mock('../../../../src/main/services/ocr', () => ({ createOcrMcpServer: () => ({}) }))
vi.mock('../../../../src/main/services/email-mcp', () => ({ createEmailMcpServer: vi.fn() }))
vi.mock('../../../../src/main/services/api-ref', () => ({
  HALO_API_TOOLSET_ID: 'halo-api-ref', HALO_API_USAGE_GUIDE: '', createApiRefMcpServer: vi.fn(),
}))

import { getConfig, getCredentialsGeneration, saveConfig } from '../../../../src/main/foundation/config.service'
import { decodeBackendConfig } from '../../../../src/main/openai-compat-router'
import { sendMessage } from '../../../../src/main/services/agent/send-message'
import { onAgentEvent } from '../../../../src/main/services/agent/events'
import { sendAppChatMessage } from '../../../../src/main/apps/runtime/app-chat'
import { disposeAppChatSink, hasActiveAppChatRound } from '../../../../src/main/apps/runtime/app-chat-sink'
import { setImStreamHandle, getImStreamHandle, clearAllImStreamHandles } from '../../../../src/main/apps/runtime/im-stream-registry'
import { convertEventsToMessages } from '../../../../src/main/apps/runtime/session-transcript'
import {
  closeAllV2Sessions, closeV2Session, ensureSessionWarm, evictIdleSession,
  getConsumerHandle, isSessionBusy, stopSessionCleanup, v2Sessions,
} from '../../../../src/main/services/agent/session-manager'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve))

function fakeSession(label: string) {
  type Frame = Record<string, any>
  let ready = true
  let waiter: ((frames: Frame[] | Error) => void) | undefined
  let exitListener: ((error?: Error) => void) | undefined
  const turns: Array<Frame[] | Error> = []
  const enqueue = (frames: Frame[] | Error) => {
    if (waiter) {
      const current = waiter
      waiter = undefined
      current(frames)
    } else turns.push(frames)
  }
  return {
    label,
    options: {} as Record<string, any>,
    query: { transport: {
      isReady: () => ready,
      onExit: (listener: (error?: Error) => void) => {
        exitListener = listener
        return () => { exitListener = undefined }
      },
    } },
    send: vi.fn((_message: unknown): void | Promise<void> => {
      if (!ready) throw new Error('Fixture SDK process is closed')
      return Promise.resolve()
    }),
    close: vi.fn(() => { ready = false; enqueue(new Error('Fixture process exited')) }),
    setMaxThinkingTokens: vi.fn(async (_tokens: number | null) => {}),
    getGoal: () => null,
    setGoal: vi.fn((input: object) => ({ ...input, status: 'active', updatedBy: 'user', updatedAt: 'fixture' })),
    async *stream() {
      const frames = turns.length > 0
        ? turns.shift()!
        : await new Promise<Frame[] | Error>(resolve => { waiter = resolve })
      if (frames instanceof Error) throw frames
      for (const frame of frames) yield frame
    },
    emit: enqueue,
    interrupt: vi.fn(async () => {}),
    loseTransport() { ready = false },
    exit() { ready = false; exitListener?.(new Error('Fixture process exited')) },
    reply() {
      enqueue([
        { type: 'system', subtype: 'init', session_id: `sdk-${label}`, model: 'gpt-test', tools: [], mcp_servers: [] },
        { type: 'assistant', message: { id: `reply-${label}`, role: 'assistant', content: [{ type: 'text', text: 'Fixture reply' }] } },
        { type: 'result', subtype: 'success', session_id: `sdk-${label}`, is_error: false, result: 'Fixture reply', num_turns: 1 },
      ])
    },
  }
}

type FakeSession = ReturnType<typeof fakeSession>
const created: FakeSession[] = []

function queueSession(session: FakeSession, creation?: ReturnType<typeof deferred<void>>) {
  m.createSession.mockImplementationOnce(async (options: Record<string, any>) => {
    session.options = options
    created.push(session)
    if (creation) await creation.promise
    return session
  })
}

function thinkingGate(session: FakeSession) {
  const entered = deferred<void>()
  const done = deferred<void>()
  session.setMaxThinkingTokens.mockImplementationOnce(async () => { entered.resolve(); await done.promise })
  return { entered: entered.promise, done }
}

function memorySnapshot(layout: MemoryLayout): MemorySnapshot {
  return {
    layout, exists: true, blank: false, totalLines: 5, sizeBytes: 40, nowBytes: 30,
    firstSection: '# now\n\n## State\nfixture memory', fullContent: '# now\n\n## State\nfixture memory\n\n# History', headers: [],
    topics: { root: layout.topicsDir, children: [], topicCount: 0, totalBytes: 0, truncated: false },
    runTotalCount: 0, archiveCount: 0,
  }
}

function account(id: string): AISource {
  return {
    id, name: id, provider: 'chatgpt', authType: 'oauth', apiUrl: 'https://example.invalid',
    accountId: `workspace-${id}`, accessToken: `fixture-token-${id}`, tokenExpires: Number.MAX_SAFE_INTEGER,
    model: 'gpt-test', availableModels: [{ id: 'gpt-test', name: 'Fixture model' }],
    createdAt: '2026-01-01', updatedAt: '2026-01-01',
  }
}

async function updateAccountA(changes: Partial<AISource>) {
  const sources = getConfig().aiSources!
  saveConfig({ aiSources: {
    ...sources, sources: sources.sources.map(source => source.id === 'account-a' ? { ...source, ...changes } : source),
  } })
  // saveConfig publishes invalidation on a timer, after synchronously advancing the epoch.
  await new Promise<void>(resolve => setTimeout(resolve, 0))
}

/** A change sessions must follow; the ChatGPT route ignores apiUrl, so routing stays comparable. */
const reconfigureAccount = () => updateAccountA({ apiUrl: 'https://reconfigured.invalid' })

const entries = [
  {
    name: 'space chat', id: 'conv-handoff',
    send: (message = 'Original message', failure?: Error, session?: FakeSession) => {
      if (failure) session!.setGoal.mockImplementationOnce(() => { throw failure })
      return sendMessage({
        spaceId: 'space', conversationId: 'conv-handoff', message, thinkingEnabled: true,
        ...(failure ? { goal: { objective: 'Fixture objective' } } : {}),
      })
    },
    pin: (sourceId: string) => { m.conversations.get('conv-handoff')!.modelSourceId = sourceId },
    error: () => m.conversations.get('conv-handoff')!.messages.findLast((message: any) => message.error)?.error,
  },
  {
    name: 'digital-human chat', id: 'app-chat:handoff-app',
    send: (message = 'Original message', failure?: Error, _session?: FakeSession) => {
      if (failure) m.writeTrigger.mockImplementationOnce(() => { throw failure })
      return sendAppChatMessage({ spaceId: 'space', appId: 'handoff-app', message, thinkingEnabled: true })
    },
    pin: (sourceId: string) => { m.app!.userOverrides!.modelSourceId = sourceId },
    error: () => undefined,
  },
]
type Entry = typeof entries[number]

function expectRoute(session: FakeSession, sourceId: string, token = `fixture-token-${sourceId}`) {
  expect(session.options.env.HALO_AI_SOURCE_ID).toBe(sourceId)
  expect(session.options.apiCredentials.sourceId).toBe(sourceId)
  expect(decodeBackendConfig(session.options.env.ANTHROPIC_API_KEY)).toMatchObject({
    sourceId, key: token, model: 'gpt-test', apiType: 'responses',
    headers: { Authorization: `Bearer ${token}`, 'ChatGPT-Account-ID': `workspace-${sourceId}` },
  })
}

async function completeSend(entry: Entry, session: FakeSession, pending: Promise<void>, message: string) {
  await vi.waitFor(() => expect(session.send).toHaveBeenCalledTimes(1))
  expect(session.close).not.toHaveBeenCalled()
  expect(evictIdleSession(entry.id, 'fixture awaiting-init eviction')).toBe(false)
  expect(session.send.mock.calls[0][0]).toEqual(expect.stringContaining(message))
  const completed = deferred<void>()
  const listener = onAgentEvent(event => {
    if (event.conversationId === entry.id && event.channel === 'agent:complete') completed.resolve()
  })
  try {
    session.reply()
    await Promise.all([pending, completed.promise])
    await vi.waitFor(() => {
      expect(isSessionBusy(entry.id)).toBe(false)
      expect(hasActiveAppChatRound(entry.id)).toBe(false)
    })
  } finally {
    listener.dispose()
  }
}

beforeEach(async () => {
  m.workDir = globalThis.__HALO_TEST_DIR__
  m.memoryEnabled = false
  m.sourceRequests.length = 0
  created.length = 0
  m.conversations.clear()
  m.conversations.set('conv-handoff', { id: 'conv-handoff', modelSourceId: 'account-a', messages: [] })
  m.app = {
    id: 'handoff-app', specId: 'handoff-app', spaceId: 'space', status: 'active',
    installedAt: 0, upgradeStrategy: 'manual', knowledgeSeeded: true,
    spec: {
      type: 'automation', spec_version: '1', name: 'Fixture app', version: '1.0.0', author: 'Test',
      description: 'Session handoff fixture', system_prompt: 'Fixture instructions', subscriptions: [],
    },
    userConfig: {}, userOverrides: { modelSourceId: 'account-a', memory: { enabled: false } },
    permissions: { granted: [], denied: ['ai-browser', 'ai-terminal', 'email', 'im-push', 'halo-api-ref'] },
  }
  m.createSession.mockReset()
  m.writeTrigger.mockReset()
  m.writeEvent.mockReset()
  m.buildMemorySnapshot.mockReset().mockImplementation(async (layout: MemoryLayout) => memorySnapshot(layout))
  m.ensureMemoryFile.mockReset().mockResolvedValue(false)
  saveConfig({ aiSources: { version: 2, currentId: 'account-b', sources: [account('account-a'), account('account-b')] } })
  await new Promise<void>(resolve => setTimeout(resolve, 0))
})

afterEach(async () => {
  const consumers = [...v2Sessions.keys()].map(id => getConsumerHandle(id))
  closeAllV2Sessions()
  stopSessionCleanup()
  await vi.waitFor(() => {
    expect(consumers.every(consumer => !consumer?.isRunning)).toBe(true)
    expect(created.every(session => !session.query.transport.isReady())).toBe(true)
  })
  disposeAppChatSink('app-chat:handoff-app')
  disposeAppChatSink('app-chat:handoff-app:local:direct:handoff')
  clearAllImStreamHandles()
})

describe('session handoff through real chat entries', () => {
  describe.each(entries)('$name engine exit before init', entry => {
    it.each(['thinking', 'memory', 'accepting', 'accepted'] as const)('settles a pending message once when the engine exits during %s', async stage => {
      const original = fakeSession('pre-init-exit')
      queueSession(original)
      const acceptance = stage === 'accepting' ? deferred<void>() : undefined
      if (acceptance) original.send.mockReturnValueOnce(acceptance.promise)
      const preparation = stage === 'thinking' ? thinkingGate(original) : undefined
      const memoryEntered = deferred<MemoryLayout>()
      const snapshot = deferred<MemorySnapshot>()
      if (stage === 'memory') {
        m.memoryEnabled = true
        m.app!.userOverrides!.memory = { enabled: true }
        m.buildMemorySnapshot.mockImplementationOnce(layout => { memoryEntered.resolve(layout); return snapshot.promise })
      }
      const events: string[] = []
      const listener = onAgentEvent(event => {
        if (event.conversationId === entry.id) events.push(event.channel)
      })
      const pending = entry.send().catch(() => {})
      let layout: MemoryLayout | undefined
      try {
        if (preparation) await preparation.entered
        else if (stage === 'memory') layout = await memoryEntered.promise
        else await vi.waitFor(() => expect(original.send).toHaveBeenCalledTimes(1))
        expect(getConsumerHandle(entry.id)?.getActiveSessionState()).toBeNull()
        original.exit()
        expect(events.filter(channel => channel === 'agent:error')).toHaveLength(1)
        expect(events.filter(channel => channel === 'agent:complete')).toHaveLength(1)
        if (entry.name === 'space chat') expect(entry.error()).toMatch(/session ended|process exited/i)
        else expect(m.writeEvent.mock.calls.some(([event]) => event.type === 'turn_snapshot' && event.error)).toBe(true)
        preparation?.done.resolve()
        acceptance?.reject(new Error('Delayed dispatch rejection'))
        if (layout) snapshot.resolve(memorySnapshot(layout))
        await pending
        await flush()
        expect(events.filter(channel => channel === 'agent:error')).toHaveLength(1)
        expect(events.filter(channel => channel === 'agent:complete')).toHaveLength(1)
        expect(original.send).toHaveBeenCalledTimes(stage === 'accepted' || stage === 'accepting' ? 1 : 0)
        expect(hasActiveAppChatRound(entry.id)).toBe(false)
      } finally {
        preparation?.done.resolve()
        acceptance?.resolve()
        if (layout) snapshot.resolve(memorySnapshot(layout))
        listener.dispose()
      }
    })
  })

  it.each(entries)('$name settles a stream-first pre-init failure without publishing it again on process exit', async entry => {
    const original = fakeSession('stream-first-exit')
    queueSession(original)
    const pending = entry.send().catch(() => {})
    await vi.waitFor(() => expect(original.send).toHaveBeenCalledTimes(1))
    const events: string[] = []
    const listener = onAgentEvent(event => { if (event.conversationId === entry.id) events.push(event.channel) })
    try {
      original.emit(new Error('Fixture process exited before init'))
      await vi.waitFor(() => expect(events.filter(channel => channel === 'agent:complete')).toHaveLength(1))
      await pending
      original.exit()
      await flush()
      expect(events.filter(channel => channel === 'agent:error')).toHaveLength(1)
      expect(events.filter(channel => channel === 'agent:complete')).toHaveLength(1)
    } finally { listener.dispose() }
  })

  describe.each(entries)('$name background work during an account change', entry => {
    it.each(['idle', 'mid-turn'] as const)('keeps receiving all background completions after an account change while %s', async timing => {
      const original = fakeSession('background-receiver')
      const replacement = fakeSession('after-background')
      const reachedTasks = deferred<void>()
      const finishTurn = deferred<void>()
      const stream = original.stream
      original.stream = async function* () {
        for await (const frame of stream()) {
          yield frame
          if (timing === 'mid-turn' && frame.subtype === 'task_started' && frame.task_id === 'bg-b') {
            reachedTasks.resolve()
            await finishTurn.promise
          }
        }
      }
      queueSession(original)
      queueSession(replacement)
      const pending = entry.send()
      await vi.waitFor(() => expect(original.send).toHaveBeenCalledTimes(1))
      original.emit([
        { type: 'system', subtype: 'init', session_id: 'background-sdk', tools: [], mcp_servers: [] },
        { type: 'system', subtype: 'task_started', task_id: 'bg-a' },
        { type: 'system', subtype: 'task_started', task_id: 'bg-b' },
        { type: 'assistant', message: { id: 'started', content: [{ type: 'text', text: 'Background work started' }] } },
        { type: 'result', subtype: 'success', is_error: false, result: 'Background work started' },
      ])
      if (timing === 'mid-turn') await reachedTasks.promise
      else await vi.waitFor(() => expect(getConsumerHandle(entry.id)?.getActiveSessionState()).toBeNull())
      try {
        await reconfigureAccount()
        expect(original.close).not.toHaveBeenCalled()
        finishTurn.resolve()
        await pending
        await vi.waitFor(() => expect(getConsumerHandle(entry.id)?.getActiveSessionState()).toBeNull())
        expect(getConsumerHandle(entry.id)?.isRunning).toBe(true)
        expect(getConsumerHandle(entry.id)?.hasRunningTasks()).toBe(true)
        expect(evictIdleSession(entry.id, 'fixture background receiver')).toBe(false)
        for (const taskId of ['bg-a', 'bg-b']) {
          const complete = deferred<void>()
          const listener = onAgentEvent(event => {
            if (event.conversationId === entry.id && event.channel === 'agent:complete') complete.resolve()
          })
          try {
            original.emit([
              { type: 'system', subtype: 'init', session_id: 'background-sdk', tools: [], mcp_servers: [] },
              { type: 'system', subtype: 'task_notification', task_id: taskId, status: 'completed' },
              { type: 'assistant', message: { id: taskId, content: [{ type: 'text', text: `${taskId} completed` }] } },
              { type: 'result', subtype: 'success', is_error: false, result: `${taskId} completed` },
            ])
            await complete.promise
            if (taskId === 'bg-a') {
              expect(getConsumerHandle(entry.id)?.isRunning).toBe(true)
              expect(original.close).not.toHaveBeenCalled()
            }
          } finally { listener.dispose() }
        }
        await vi.waitFor(() => expect(getConsumerHandle(entry.id)?.isRunning).toBe(false))
        const next = entry.send('After background completion')
        await completeSend(entry, replacement, next, 'After background completion')
        expectRoute(replacement, 'account-a')
      } finally { finishTurn.resolve() }
    })
  })

  it.each(entries)('$name refuses a removed pinned account and recovers only after explicit reselection', async entry => {
    const config = getConfig().aiSources!
    saveConfig({ aiSources: { ...config, sources: config.sources.filter(source => source.id !== 'account-a') } })
    await flush()
    const failure = await entry.send('Must not use B').then(() => null, error => error as Error)
    expect(m.createSession).not.toHaveBeenCalled()
    expect(m.sourceRequests).not.toContain('account-b')
    if (entry.name === 'space chat') expect(entry.error()).toContain('unavailable')
    else expect(failure?.message).toContain('unavailable')
    entry.pin('account-b')
    const replacement = fakeSession('selected-b')
    queueSession(replacement)
    await completeSend(entry, replacement, entry.send('Selected B'), 'Selected B')
    expectRoute(replacement, 'account-b')
  })

  it.each(entries)('$name keeps its acquired sender alive when its account changes during awaited thinking', async entry => {
    const original = fakeSession('original')
    const replacement = fakeSession('replacement')
    const preparation = thinkingGate(original)
    queueSession(original)
    queueSession(replacement)
    const pending = entry.send()
    await preparation.entered
    expectRoute(original, 'account-a')
    expect(getConsumerHandle(entry.id)?.getActiveSessionState()).toBeNull()
    expect(isSessionBusy(entry.id)).toBe(true)
    expect(evictIdleSession(entry.id, 'fixture eviction')).toBe(false)

    const generation = original.options.credentialsGeneration
    await reconfigureAccount()
    expect(getCredentialsGeneration('account-a')).not.toBe(generation)
    expect(original.close).not.toHaveBeenCalled()
    expect(original.send).not.toHaveBeenCalled()
    expect(m.createSession).toHaveBeenCalledTimes(1)

    preparation.done.resolve()
    await completeSend(entry, original, pending, 'Original message')
    expect(original.close).not.toHaveBeenCalled()
    const next = entry.send('After the change')
    await completeSend(entry, replacement, next, 'After the change')
    expect(original.close).toHaveBeenCalledTimes(1)
    expectRoute(replacement, 'account-a')
  })

  it.each(entries)('$name keeps its session across a token rotation; only the router sees the new token', async entry => {
    const original = fakeSession('rotation')
    const preparation = thinkingGate(original)
    queueSession(original)
    const pending = entry.send()
    await preparation.entered
    const generation = getCredentialsGeneration('account-a')
    await updateAccountA({ accessToken: 'fixture-rotated-a', refreshToken: 'fixture-rotated-refresh-a' })
    expect(getCredentialsGeneration('account-a')).toBe(generation)
    preparation.done.resolve()
    await completeSend(entry, original, pending, 'Original message')
    const next = entry.send('After rotation')
    await vi.waitFor(() => expect(original.send).toHaveBeenCalledTimes(2))
    expect(original.send.mock.calls[1][0]).toEqual(expect.stringContaining('After rotation'))
    original.reply()
    await next
    expect(original.close).not.toHaveBeenCalled()
    expect(m.createSession).toHaveBeenCalledTimes(1)
  })

  it.each(entries)('$name keeps its acquired sender alive when its account changes during first-turn memory loading', async entry => {
    m.memoryEnabled = true
    m.app!.userOverrides!.memory = { enabled: true }
    const original = fakeSession('memory')
    const entered = deferred<MemoryLayout>()
    const snapshot = deferred<MemorySnapshot>()
    m.buildMemorySnapshot.mockImplementationOnce((layout: MemoryLayout) => { entered.resolve(layout); return snapshot.promise })
    queueSession(original)
    const pending = entry.send()
    const layout = await entered.promise
    expectRoute(original, 'account-a')
    expect(getConsumerHandle(entry.id)?.getActiveSessionState()).toBeNull()
    expect(isSessionBusy(entry.id)).toBe(true)

    await reconfigureAccount()
    expect(original.close).not.toHaveBeenCalled()
    expect(original.send).not.toHaveBeenCalled()
    snapshot.resolve(memorySnapshot(layout))
    await completeSend(entry, original, pending, 'Original message')
    expect(original.send.mock.calls[0][0]).toEqual(expect.stringContaining('fixture memory'))
    expect(original.close).not.toHaveBeenCalled()
  })

  it.each(entries)('$name refuses a different-source latecomer before creation is handed off', async entry => {
    const creation = deferred<void>()
    const original = fakeSession('creation')
    const preparation = thinkingGate(original)
    queueSession(original, creation)
    const first = entry.send()
    await vi.waitFor(() => expect(m.createSession).toHaveBeenCalledTimes(1))
    entry.pin('account-b')
    const late = entry.send('Wrong account').then(() => null, error => error as Error)
    await vi.waitFor(() => expect(m.sourceRequests).toContain('account-b'))
    await flush()
    expect(m.createSession).toHaveBeenCalledTimes(1)
    expect(v2Sessions.has(entry.id)).toBe(false)

    creation.resolve()
    await preparation.entered
    const lateError = await late
    if (entry.name === 'space chat') expect(entry.error()).toContain('still busy on its previous account')
    else expect(lateError?.name).toBe('SessionOptionsStaleError')
    expect(original.close).not.toHaveBeenCalled()
    expect(original.send).not.toHaveBeenCalled()
    expectRoute(original, 'account-a')
    expect(m.createSession).toHaveBeenCalledTimes(1)
    preparation.done.resolve()
    await completeSend(entry, original, first, 'Original message')
    expect(original.send.mock.calls[0][0]).not.toEqual(expect.stringContaining('Wrong account'))
  })

  it('protects a real sender sharing warm-up creation before a different-source waiter re-enters', async () => {
    const entry = entries[0]
    const creation = deferred<void>()
    const original = fakeSession('warm')
    const preparation = thinkingGate(original)
    queueSession(original, creation)
    const warm = ensureSessionWarm('space', entry.id)
    await vi.waitFor(() => expect(m.createSession).toHaveBeenCalledTimes(1))
    const pending = entry.send()
    await vi.waitFor(() => expect(m.sourceRequests.filter(id => id === 'account-a')).toHaveLength(2))
    await flush()
    entry.pin('account-b')
    const late = entry.send('Wrong account')
    await vi.waitFor(() => expect(m.sourceRequests).toContain('account-b'))
    await flush()

    creation.resolve()
    await warm
    await preparation.entered
    await late
    expect(entry.error()).toContain('still busy on its previous account')
    expect(original.close).not.toHaveBeenCalled()
    expect(m.createSession).toHaveBeenCalledTimes(1)
    expectRoute(original, 'account-a')
    preparation.done.resolve()
    await completeSend(entry, original, pending, 'Original message')
  })

  describe.each(entries)('$name abandoned preparation', entry => {
    it.each(['AbortError', 'Error'])('releases protection after %s and allows a new account to send', async name => {
      const original = fakeSession('failed-preparation')
      const replacement = fakeSession('after-failure')
      const preparation = thinkingGate(original)
      const error = Object.assign(new Error('Fixture preparation failed'), { name })
      queueSession(original)
      queueSession(replacement)
      const pending = entry.send('Never dispatched', error, original).then(() => null, failure => failure as Error)
      await preparation.entered
      await reconfigureAccount()
      expect(original.close).not.toHaveBeenCalled()
      expect(isSessionBusy(entry.id)).toBe(true)
      preparation.done.resolve()
      const failure = await pending
      if (entry.name === 'digital-human chat') expect(failure).toBe(error)
      else if (name !== 'AbortError') expect(entry.error()).toBe(error.message)
      expect(original.send).not.toHaveBeenCalled()
      expect(original.close).toHaveBeenCalledTimes(1)
      expect(v2Sessions.has(entry.id)).toBe(false)
      expect(isSessionBusy(entry.id)).toBe(false)
      expect(hasActiveAppChatRound(entry.id)).toBe(false)

      entry.pin('account-b')
      const next = entry.send('Retry on B')
      await completeSend(entry, replacement, next, 'Retry on B')
      expectRoute(replacement, 'account-b')
    })
  })

  describe.each(entries)('$name stale sender cleanup', entry => {
    it.each(['dead transport', 'process exit', 'explicit close'])('does not close a successor after %s', async reason => {
      const original = fakeSession('predecessor')
      const replacement = fakeSession('successor')
      const preparation = thinkingGate(original)
      queueSession(original)
      queueSession(replacement)
      const pending = entry.send().then(() => null, error => error as Error)
      await preparation.entered
      if (reason === 'dead transport') original.loseTransport()
      else if (reason === 'process exit') original.exit()
      else closeV2Session(entry.id)
      await flush()
      entry.pin('account-b')
      const next = entry.send('Successor message')
      await completeSend(entry, replacement, next, 'Successor message')
      expect(original.close).toHaveBeenCalledTimes(1)
      expect(v2Sessions.get(entry.id)?.session).toBe(replacement)
      expectRoute(replacement, 'account-b')
      const messages = m.conversations.get('conv-handoff')!.messages.length
      const writes = m.writeEvent.mock.calls.length
      const events: string[] = []
      const listener = onAgentEvent(event => { if (event.conversationId === entry.id) events.push(event.channel) })
      preparation.done.resolve()
      const failure = await pending
      await flush()
      listener.dispose()
      expect(events).toEqual([])
      expect(m.conversations.get('conv-handoff')!.messages).toHaveLength(messages)
      expect(m.writeEvent.mock.calls).toHaveLength(writes)
      if (entry.name === 'space chat') {
        if (reason === 'explicit close') expect(entry.error()).toBeUndefined()
        else expect(entry.error()).toMatch(/session ended|process exited/i)
        expect(m.conversations.get('conv-handoff')!.messages.at(-1).content).toBe('Fixture reply')
      } else expect(failure?.message).toBe('The acquired session is no longer available')
      expect(original.send).not.toHaveBeenCalled()
      expect(replacement.send).toHaveBeenCalledTimes(1)
      expect(replacement.close).not.toHaveBeenCalled()
      expect(v2Sessions.get(entry.id)?.session).toBe(replacement)
      expect(isSessionBusy(entry.id)).toBe(false)
      expect(hasActiveAppChatRound(entry.id)).toBe(false)
    })
  })

  describe.each(entries)('$name consumer retirement', entry => {
    it('settles a started turn for every event listener synchronously, once before successor dispatch', async () => {
      const original = fakeSession('retirement-completion')
      const dispatched = deferred<void>()
      const entered = deferred<void>()
      const stopped = deferred<void>()
      original.send.mockImplementationOnce(() => { dispatched.resolve() })
      original.stream = async function* () {
        await dispatched.promise
        yield { type: 'system', subtype: 'init', session_id: 'old-sdk', tools: [], mcp_servers: [] }
        entered.resolve()
        await stopped.promise
      }
      queueSession(original)
      const pending = entry.send().catch(() => {})
      await entered.promise
      await vi.waitFor(() => expect(original.send).toHaveBeenCalledTimes(1))
      const predecessor = getConsumerHandle(entry.id)!
      const completions: string[] = []
      const listener = onAgentEvent(event => {
        if (event.conversationId === entry.id && event.channel === 'agent:complete') completions.push(event.channel)
      })
      try {
        closeV2Session(entry.id)
        expect(completions).toEqual(['agent:complete'])
        expect(predecessor.isRunning).toBe(true)
        predecessor.stop()
        expect(completions).toHaveLength(1)
        await pending
        stopped.resolve()
        await vi.waitFor(() => expect(predecessor.isRunning).toBe(false))
        expect(completions).toHaveLength(1)
      } finally {
        stopped.resolve()
        listener.dispose()
      }
    })

    it.each(['late init', 'late result', 'empty exit'])('does not publish %s into a successor and settles old rounds before stream exit', async outcome => {
      const original = fakeSession('retired-output')
      const replacement = fakeSession('successor-output')
      const entered = deferred<void>()
      const stopped = deferred<void>()
      original.stream = async function* () {
        if (outcome === 'late result') {
          yield { type: 'system', subtype: 'init', session_id: 'old-sdk', tools: [], mcp_servers: [] }
          yield { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 2, retry_delay_ms: 1000, error: 'server_error' }
        }
        entered.resolve()
        await stopped.promise
        if (outcome === 'late init') {
          yield { type: 'system', subtype: 'init', session_id: 'old-sdk', tools: [], mcp_servers: [] }
        }
        if (outcome !== 'empty exit') {
          yield { type: 'assistant', message: { id: 'old-reply', content: [{ type: 'text', text: 'Obsolete reply' }] } }
          yield { type: 'result', subtype: 'success', session_id: 'old-sdk', is_error: false, result: 'Obsolete reply' }
        }
      }
      queueSession(original)
      queueSession(replacement)
      let oldSettled = false
      const pending = entry.send().catch(() => {}).finally(() => { oldSettled = true })
      await entered.promise
      await vi.waitFor(() => expect(original.send).toHaveBeenCalledTimes(1))
      const predecessor = getConsumerHandle(entry.id)!
      closeV2Session(entry.id)
      await pending
      expect(oldSettled).toBe(true)
      expect(hasActiveAppChatRound(entry.id)).toBe(false)
      expect(predecessor.isRunning).toBe(true)

      entry.pin('account-b')
      let successorFailure: Error | undefined
      const next = entry.send('Successor on B').catch(error => { successorFailure = error })
      await vi.waitFor(() => expect(replacement.send).toHaveBeenCalledTimes(1))
      const events: string[] = []
      const listener = onAgentEvent(event => {
        if (event.conversationId === entry.id) events.push(event.channel)
      })
      const writes = m.writeEvent.mock.calls.length
      const messages = m.conversations.get('conv-handoff')!.messages.length
      try {
        stopped.resolve()
        await vi.waitFor(() => expect(predecessor.isRunning).toBe(false))
        expect(events).toEqual([])
        expect(m.writeEvent.mock.calls).toHaveLength(writes)
        expect(m.conversations.get('conv-handoff')!.messages).toHaveLength(messages)
        expect(evictIdleSession(entry.id, 'fixture retired init')).toBe(false)
        if (entry.name === 'digital-human chat') expect(hasActiveAppChatRound(entry.id)).toBe(true)
        await completeSend(entry, replacement, next, 'Successor on B')
        expect(successorFailure).toBeUndefined()
        expectRoute(replacement, 'account-b')
      } finally {
        stopped.resolve()
        listener.dispose()
      }
    })
  })

  describe.each(entries)('$name partial reply persistence', entry => {
    it.each(['aggregate', 'streaming', 'streaming-and-aggregate', 'nonstream-fallback', 'nonstream-fallback-after-tool'] as const)('persists %s output before process-exit retirement and ignores late predecessor output', async mode => {
      const original = fakeSession('partial-predecessor')
      const replacement = fakeSession('partial-successor')
      const stopped = deferred<void>()
      const partial = 'Partial before process exit'
      const fallback = mode === 'nonstream-fallback' || mode === 'nonstream-fallback-after-tool'
      const frames: Array<Record<string, any>> = mode === 'aggregate'
        ? [{ type: 'assistant', message: { id: 'partial-message', content: [{ type: 'text', text: partial }] } }]
        : [
            { type: 'stream_event', event: { type: 'message_start', message: { id: 'partial-message' } } },
            { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } },
            { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Partial reasoning' } } },
            { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } },
            { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: fallback ? 'Half of failed response' : partial } } },
          ]
      if (mode === 'nonstream-fallback-after-tool') frames.unshift(
        { type: 'stream_event', event: { type: 'message_start', message: { id: 'before-tool' } } },
        { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
        { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Earlier transitional text' } } },
        { type: 'assistant', message: { id: 'before-tool', content: [{ type: 'text', text: 'Earlier transitional text' }] } },
        { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
        { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'completed-tool', name: 'Bash' } } },
        { type: 'stream_event', event: { type: 'content_block_stop', index: 1 } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'completed-tool', content: 'Done' }] } },
      )
      if (fallback) frames.push(
        { type: 'assistant', message: { id: 'fallback-message', content: [{ type: 'text', text: partial }] } },
      )
      if (mode === 'streaming-and-aggregate') frames.push(
        { type: 'stream_event', event: { type: 'content_block_stop', index: 1 } },
        { type: 'assistant', message: { id: 'partial-message', content: [{ type: 'text', text: partial }] } },
      )
      original.send.mockImplementationOnce(() => {
        original.emit([{ type: 'system', subtype: 'init', session_id: 'partial-sdk', tools: [], mcp_servers: [] }, ...frames])
        return Promise.resolve()
      })
      const stream = original.stream
      original.stream = async function* () {
        yield* stream()
        await stopped.promise
        yield { type: 'assistant', message: { id: 'obsolete-message', content: [{ type: 'text', text: 'Obsolete late reply' }] } }
        yield { type: 'result', subtype: 'success', result: 'Obsolete late reply', session_id: 'partial-sdk' }
      }
      queueSession(original)
      queueSession(replacement)
      const events: Array<{ channel: string; data: any }> = []
      const listener = onAgentEvent(event => {
        if (event.conversationId === entry.id) events.push(event)
      })
      const pending = entry.send().catch(() => {})
      try {
        await vi.waitFor(() => expect(events.some(event => fallback
          ? event.channel === 'agent:thought' && event.data.thought?.type === 'text' && event.data.thought.content === partial
          : event.channel === 'agent:message' && (event.data.content === partial || event.data.delta === partial))).toBe(true))
        const predecessor = getConsumerHandle(entry.id)!
        if (mode === 'streaming-and-aggregate' || fallback) await vi.waitFor(() => expect(
          predecessor.getActiveSessionState()?.thoughts.some(thought => thought.type === 'text' && thought.content === partial),
        ).toBe(true))
        original.exit()
        expect(events.filter(event => event.channel === 'agent:complete')).toHaveLength(1)
        const stored = entry.name === 'space chat'
          ? m.conversations.get(entry.id)!.messages.at(-1)
          : convertEventsToMessages(m.writeEvent.mock.calls.map(([frame], index) => ({ _ts: `fixture-${index}`, ...frame }))).at(-1)
        expect(stored.content).toBe(partial)
        if (mode !== 'aggregate') {
          expect(stored.thoughts).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'thinking', content: 'Partial reasoning', isStreaming: false }),
          ]))
        }
        if (entry.name === 'space chat') expect(m.conversations.get(entry.id)!.sessionId).toBe('partial-sdk')
        else {
          expect(m.writeEvent.mock.calls.filter(([frame]) => frame.type === 'turn_snapshot')).toHaveLength(1)
          expect(m.writeEvent.mock.calls.some(([frame]) => frame.type === 'stream_event')).toBe(false)
        }
        await pending
        entry.pin('account-b')
        const next = entry.send('Successor on B')
        await vi.waitFor(() => expect(replacement.send).toHaveBeenCalledTimes(1))
        events.length = 0
        const writes = m.writeEvent.mock.calls.length
        const persisted = JSON.stringify(stored)
        stopped.resolve()
        await vi.waitFor(() => expect(predecessor.isRunning).toBe(false))
        expect(events).toEqual([])
        expect(m.writeEvent.mock.calls).toHaveLength(writes)
        expect(JSON.stringify(stored)).toBe(persisted)
        expect(v2Sessions.get(entry.id)?.session).toBe(replacement)
        await completeSend(entry, replacement, next, 'Successor on B')
      } finally {
        stopped.resolve()
        listener.dispose()
      }
    })

    it('preserves received text when the stream throws without process-exit retirement', async () => {
      const session = fakeSession('stream-error')
      const partial = 'Partial before stream error'
      const error = new Error('Fixture process exited during streaming')
      session.send.mockImplementationOnce(() => {
        session.emit([
          { type: 'system', subtype: 'init', session_id: 'stream-error-sdk', tools: [], mcp_servers: [] },
          { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
          { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: partial } } },
        ])
        return Promise.resolve()
      })
      const stream = session.stream
      session.stream = async function* () { yield* stream(); throw error }
      queueSession(session)
      const events: string[] = []
      const listener = onAgentEvent(event => {
        if (event.conversationId === entry.id) events.push(event.channel)
      })
      try {
        const pending = entry.send().then(() => null, failure => failure as Error)
        await vi.waitFor(() => expect(events).toContain('agent:complete'))
        const failure = await pending
        if (entry.name === 'digital-human chat') expect(failure).toBe(error)
        const stored = entry.name === 'space chat'
          ? m.conversations.get(entry.id)!.messages.at(-1)
          : convertEventsToMessages(m.writeEvent.mock.calls.map(([frame], index) => ({ _ts: `fixture-${index}`, ...frame }))).at(-1)
        expect(stored.content).toBe(partial)
        expect(stored.error).toBe(error.message)
        expect(events.filter(channel => channel === 'agent:complete')).toHaveLength(1)
      } finally { listener.dispose() }
    })
  })

  it('retains a completed digital-human reply before an autonomous turn retires', async () => {
    const entry = entries[1]
    const session = fakeSession('autonomous-checkpoint')
    const stopped = deferred<void>()
    const stream = session.stream
    let turn = 0
    session.stream = async function* () {
      yield* stream()
      if (turn++ > 0) await stopped.promise
    }
    queueSession(session)
    let receivedText = false
    const listener = onAgentEvent(event => {
      if (event.conversationId === entry.id && event.channel === 'agent:message' &&
          (event.data as { delta?: string }).delta === 'Background partial') receivedText = true
    })
    try {
      await completeSend(entry, session, entry.send(), 'Original message')
      const events = () => m.writeEvent.mock.calls.map(([frame], index) => ({ _ts: `fixture-${index}`, ...frame }))
      const completed = convertEventsToMessages(events())[0]
      expect(completed.content).toBe('Fixture reply')
      session.emit([
        { type: 'system', subtype: 'init', session_id: 'autonomous-sdk', tools: [], mcp_servers: [] },
        { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
        { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Background partial' } } },
      ])
      await vi.waitFor(() => expect(receivedText).toBe(true))
      const consumer = getConsumerHandle(entry.id)!
      session.exit()
      const reloaded = convertEventsToMessages(events())
      expect(reloaded.map(message => message.content)).toEqual(['Fixture reply', 'Background partial'])
      expect(reloaded[0]).toEqual(completed)
      expect(reloaded[1].id).not.toBe(completed.id)
      expect(reloaded[1].error).toMatch(/session ended/i)
      expect(m.writeEvent.mock.calls.filter(([frame]) => frame.type === 'turn_snapshot')).toHaveLength(1)
      const persisted = JSON.stringify(events())
      stopped.resolve()
      await vi.waitFor(() => expect(consumer.isRunning).toBe(false))
      expect(JSON.stringify(events())).toBe(persisted)
    } finally {
      stopped.resolve()
      listener.dispose()
    }
  })

  it.each(['process-exit', 'stream-error'] as const)('stores a partial space reply and separated thoughts on disk after %s', async termination => {
    const store = await vi.importActual<typeof import('../../../../src/main/services/conversation.service')>('../../../../src/main/services/conversation.service')
    const mockedStore = await import('../../../../src/main/services/conversation.service')
    const patched = ['addMessage', 'updateMessageById', 'updateLastMessage', 'saveSessionId'] as const
    const originals = patched.map(name => vi.mocked(mockedStore[name]).getMockImplementation())
    const conversationId = 'conv-handoff'
    const directory = join(m.workDir, '.halo', 'conversations')
    const file = join(directory, `${conversationId}.json`)
    const timestamp = '2026-01-01T00:00:00Z'
    mkdirSync(directory, { recursive: true })
    writeFileSync(file, JSON.stringify({
      ...m.conversations.get(conversationId), spaceId: 'space', title: 'Partial persistence fixture',
      version: 2, createdAt: timestamp, updatedAt: timestamp, messageCount: 0,
    }))
    writeFileSync(join(directory, 'index.json'), JSON.stringify({ version: 1, updatedAt: timestamp, conversations: [] }))
    for (const name of patched) vi.mocked(mockedStore[name]).mockImplementation(store[name] as any)

    const session = fakeSession('durable-partial')
    const stopped = deferred<void>()
    const partial = 'Received reply before the stream ended'
    const error = new Error('Fixture process exited during streaming')
    session.send.mockImplementationOnce(() => {
      session.emit([
        { type: 'system', subtype: 'init', session_id: 'durable-partial-sdk', tools: [], mcp_servers: [] },
        { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } },
        { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Received reasoning before the stream ended' } } },
        { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } },
        { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: partial } } },
      ])
      return Promise.resolve()
    })
    const stream = session.stream
    session.stream = async function* () {
      yield* stream()
      await stopped.promise
      throw error
    }
    queueSession(session)
    const events: string[] = []
    let receivedText = false
    const listener = onAgentEvent(event => {
      if (event.conversationId !== conversationId) return
      events.push(event.channel)
      if (event.channel === 'agent:message' && (event.data as { delta?: string }).delta === partial) receivedText = true
    })
    try {
      await entries[0].send()
      const consumer = getConsumerHandle(conversationId)!
      await vi.waitFor(() => expect(receivedText).toBe(true))
      if (termination === 'process-exit') session.exit()
      else stopped.resolve()
      await vi.waitFor(() => expect(events.filter(channel => channel === 'agent:complete')).toHaveLength(1))

      const persisted = JSON.parse(readFileSync(file, 'utf8'))
      const message = persisted.messages.at(-1)
      expect(persisted.sessionId).toBe('durable-partial-sdk')
      expect(message).toMatchObject({
        role: 'assistant', content: partial, thoughts: null,
        error: termination === 'process-exit' ? 'Chat session ended before the reply completed.' : error.message,
      })
      const thoughtsFile = JSON.parse(readFileSync(join(directory, `${conversationId}.thoughts.json`), 'utf8'))
      expect(thoughtsFile.messages[message.id]).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'thinking', content: 'Received reasoning before the stream ended', isStreaming: false }),
      ]))
      expect(store.getMessageThoughts('space', conversationId, message.id)).toEqual(thoughtsFile.messages[message.id])
      const beforeExit = readFileSync(file, 'utf8')
      stopped.resolve()
      await vi.waitFor(() => expect(consumer.isRunning).toBe(false))
      expect(readFileSync(file, 'utf8')).toBe(beforeExit)
      expect(events.filter(channel => channel === 'agent:complete')).toHaveLength(1)
    } finally {
      stopped.resolve()
      closeV2Session(conversationId)
      listener.dispose()
      store.deleteConversation('space', conversationId)
      store.flushAllPendingIndexWrites()
      patched.forEach((name, index) => vi.mocked(mockedStore[name]).mockImplementation(originals[index] as any))
    }
  })

  it('does not clear a successor transport handle when a retired app chat send rejects', async () => {
    const conversationId = 'app-chat:handoff-app:local:direct:handoff'
    const original = fakeSession('old-transport')
    const replacement = fakeSession('new-transport')
    const acceptance = deferred<void>()
    const error = new Error('Fixture obsolete transport rejection')
    original.send.mockReturnValueOnce(acceptance.promise)
    queueSession(original)
    queueSession(replacement)
    const oldHandle = { update: vi.fn(async () => {}), finish: vi.fn(async () => {}), dispose: vi.fn(async () => {}) }
    const nextHandle = { update: vi.fn(async () => {}), finish: vi.fn(async () => {}), dispose: vi.fn(async () => {}) }
    setImStreamHandle(conversationId, oldHandle)
    const pending = sendAppChatMessage({ spaceId: 'space', appId: 'handoff-app', conversationId, message: 'Old message' })
      .then(() => null, failure => failure as Error)
    await vi.waitFor(() => expect(original.send).toHaveBeenCalledTimes(1))
    closeV2Session(conversationId)
    await flush()
    entries[1].pin('account-b')
    setImStreamHandle(conversationId, nextHandle)
    const next = sendAppChatMessage({ spaceId: 'space', appId: 'handoff-app', conversationId, message: 'Successor on B' })
    await vi.waitFor(() => expect(replacement.send).toHaveBeenCalledTimes(1))
    try {
      acceptance.reject(error)
      expect(await pending).toBe(error)
      expect(getImStreamHandle(conversationId)).toBe(nextHandle)
      expect(hasActiveAppChatRound(conversationId)).toBe(true)
      replacement.reply()
      await next
      expect(getImStreamHandle(conversationId)).toBeUndefined()
      expectRoute(replacement, 'account-b')
    } finally {
      replacement.reply()
      await next
    }
  })

  it.each(entries)('$name closes only its acquired instance when the actual SDK send throws', async entry => {
    const original = fakeSession('send-failure')
    const error = new Error('Fixture SDK send failed')
    original.send.mockImplementationOnce(() => { throw error })
    queueSession(original)
    const events: string[] = []
    const listener = onAgentEvent(event => {
      if (event.conversationId === entry.id) events.push(event.channel)
    })
    let failure: Error | null
    try {
      failure = await entry.send().then(() => null, failure => failure as Error)
    } finally {
      listener.dispose()
    }
    if (entry.name === 'space chat') expect(entry.error()).toBe(error.message)
    else expect(failure).toBe(error)
    expect(events.filter(channel => channel === 'agent:error')).toHaveLength(1)
    expect(events.filter(channel => channel === 'agent:complete')).toHaveLength(1)
    expect(original.send).toHaveBeenCalledTimes(1)
    expect(original.close).toHaveBeenCalledTimes(1)
    expect(v2Sessions.has(entry.id)).toBe(false)
    expect(isSessionBusy(entry.id)).toBe(false)
    expect(hasActiveAppChatRound(entry.id)).toBe(false)
  })

  it.each(entries)('$name keeps the dispatch lease until asynchronous SDK acceptance settles', async entry => {
    const original = fakeSession('pending-acceptance')
    const acceptance = deferred<void>()
    original.send.mockReturnValueOnce(acceptance.promise)
    queueSession(original)
    let settled = false
    const pending = entry.send().finally(() => { settled = true })
    await vi.waitFor(() => expect(original.send).toHaveBeenCalledTimes(1))
    await reconfigureAccount()
    expect(settled).toBe(false)
    expect(original.close).not.toHaveBeenCalled()
    expect(evictIdleSession(entry.id, 'fixture pending acceptance')).toBe(false)

    const completed = deferred<void>()
    const listener = onAgentEvent(event => {
      if (event.conversationId === entry.id && event.channel === 'agent:complete') completed.resolve()
    })
    try {
      original.reply()
      await completed.promise
      await flush()
      expect(settled).toBe(false)
      expect(isSessionBusy(entry.id)).toBe(true)
      expect(original.close).not.toHaveBeenCalled()
      acceptance.resolve()
      await pending
      expect(original.close).toHaveBeenCalledTimes(1)
      expect(v2Sessions.has(entry.id)).toBe(false)
      expect(isSessionBusy(entry.id)).toBe(false)
      expect(hasActiveAppChatRound(entry.id)).toBe(false)
    } finally {
      listener.dispose()
    }
  })

  describe.each(entries)('$name asynchronous dispatch failure', entry => {
    it.each(['Error', 'AbortError'])('cleans up a rejected %s without leaving a turn reservation', async name => {
      const original = fakeSession('rejected-send')
      const replacement = fakeSession('retry-after-rejection')
      const error = Object.assign(new Error('Fixture SDK rejected send'), { name })
      original.send.mockImplementationOnce(() => Promise.reject(error))
      queueSession(original)
      queueSession(replacement)
      const failure = await entry.send().then(() => null, failure => failure as Error)
      if (entry.name === 'digital-human chat') expect(failure).toBe(error)
      else expect(entry.error()).toBe(name === 'AbortError' ? undefined : error.message)
      expect(original.send).toHaveBeenCalledTimes(1)
      expect(original.close).toHaveBeenCalledTimes(1)
      expect(v2Sessions.has(entry.id)).toBe(false)
      expect(isSessionBusy(entry.id)).toBe(false)
      expect(hasActiveAppChatRound(entry.id)).toBe(false)
      await flush()

      entry.pin('account-b')
      const next = entry.send('Retry on B')
      await completeSend(entry, replacement, next, 'Retry on B')
      expectRoute(replacement, 'account-b')
    })

    it.each(['Error', 'AbortError'])('does not let delayed consumer shutdown reject a successor round after %s', async name => {
      const original = fakeSession('delayed-consumer-stop')
      const replacement = fakeSession('retry-before-consumer-exit')
      const stopped = deferred<void>()
      const stream = original.stream
      original.stream = async function* () {
        try { yield* stream() }
        catch (error) { await stopped.promise; throw error }
      }
      const acceptance = deferred<void>()
      original.send.mockReturnValueOnce(acceptance.promise)
      queueSession(original)
      queueSession(replacement)
      const pending = entry.send().catch(() => undefined)
      await vi.waitFor(() => expect(original.send).toHaveBeenCalledTimes(1))
      const predecessor = getConsumerHandle(entry.id)
      acceptance.reject(Object.assign(new Error('Fixture SDK rejected send'), { name }))
      await pending
      expect(original.close).toHaveBeenCalledTimes(1)
      entry.pin('account-b')
      let successorFailure: Error | undefined
      const next = entry.send('Retry on B').catch(error => { successorFailure = error })
      await vi.waitFor(() => expect(replacement.send).toHaveBeenCalledTimes(1))
      try {
        stopped.resolve()
        await flush()
        expect(evictIdleSession(entry.id, 'fixture successor awaiting init')).toBe(false)
        if (entry.name === 'digital-human chat') expect(hasActiveAppChatRound(entry.id)).toBe(true)
        await completeSend(entry, replacement, next, 'Retry on B')
        expect(successorFailure).toBeUndefined()
        expect(v2Sessions.get(entry.id)?.session).toBe(replacement)
        expectRoute(replacement, 'account-b')
      } finally {
        stopped.resolve()
        await flush()
        expect(predecessor?.isRunning).not.toBe(true)
      }
    })

    it('does not publish a retired send failure into a streaming successor or its transcript', async () => {
      const original = fakeSession('obsolete-dispatch')
      const replacement = fakeSession('streaming-successor')
      const acceptance = deferred<void>()
      const streamed = deferred<void>()
      const finish = deferred<void>()
      const error = new Error('Fixture obsolete dispatch rejection')
      original.send.mockReturnValueOnce(acceptance.promise)
      const stream = replacement.stream
      replacement.send.mockImplementationOnce(() => { replacement.reply(); return Promise.resolve() })
      replacement.stream = async function* () {
        for await (const frame of stream()) {
          yield frame
          if (frame.type === 'assistant') {
            streamed.resolve()
            await finish.promise
          }
        }
      }
      queueSession(original)
      queueSession(replacement)
      const pending = entry.send().then(() => null, failure => failure as Error)
      await vi.waitFor(() => expect(original.send).toHaveBeenCalledTimes(1))
      closeV2Session(entry.id)
      await flush()
      entry.pin('account-b')
      const next = entry.send('Successor on B')
      await streamed.promise
      expect(isSessionBusy(entry.id)).toBe(true)
      const messages = m.conversations.get('conv-handoff')!.messages
      const messageCount = messages.length
      const writes = m.writeEvent.mock.calls.length
      const events: string[] = []
      const listener = onAgentEvent(event => {
        if (event.conversationId === entry.id) events.push(event.channel)
      })
      try {
        acceptance.reject(error)
        const failure = await pending
        if (entry.name === 'digital-human chat') expect(failure).toBe(error)
        await flush()
        expect(events).toEqual([])
        expect(messages).toHaveLength(messageCount)
        expect(messages.some((message: any) => message.error === error.message)).toBe(false)
        expect(m.writeEvent.mock.calls).toHaveLength(writes)
        expect(v2Sessions.get(entry.id)?.session).toBe(replacement)
        expect(replacement.close).not.toHaveBeenCalled()
        expect(isSessionBusy(entry.id)).toBe(true)
        if (entry.name === 'digital-human chat') expect(hasActiveAppChatRound(entry.id)).toBe(true)

        finish.resolve()
        await next
        await vi.waitFor(() => expect(isSessionBusy(entry.id)).toBe(false))
        expect(events.filter(channel => channel === 'agent:complete')).toHaveLength(1)
        expect(events).not.toContain('agent:error')
        if (entry.name === 'space chat') expect(messages.at(-1).content).toBe('Fixture reply')
        expectRoute(replacement, 'account-b')
      } finally {
        finish.resolve()
        listener.dispose()
        await next
      }
    })

    it.each(['Error', 'AbortError'])('does not close or release a successor when an old send rejects with %s', async name => {
      const original = fakeSession('pending-rejected-send')
      const replacement = fakeSession('successor-during-send')
      const acceptance = deferred<void>()
      const preparation = thinkingGate(replacement)
      const error = Object.assign(new Error('Fixture delayed SDK rejection'), { name })
      original.send.mockReturnValueOnce(acceptance.promise)
      queueSession(original)
      queueSession(replacement)
      const pending = entry.send().then(() => null, failure => failure as Error)
      await vi.waitFor(() => expect(original.send).toHaveBeenCalledTimes(1))
      closeV2Session(entry.id)
      await flush()
      entry.pin('account-b')
      const next = entry.send('Successor on B')
      await preparation.entered

      acceptance.reject(error)
      const failure = await pending
      if (entry.name === 'digital-human chat') expect(failure).toBe(error)
      else expect(entry.error()).toBeUndefined()
      expect(original.close).toHaveBeenCalledTimes(1)
      expect(replacement.close).not.toHaveBeenCalled()
      expect(v2Sessions.get(entry.id)?.session).toBe(replacement)
      expect(isSessionBusy(entry.id)).toBe(true)
      expect(evictIdleSession(entry.id, 'fixture stale send cleanup')).toBe(false)
      expect(hasActiveAppChatRound(entry.id)).toBe(false)
      preparation.done.resolve()
      await completeSend(entry, replacement, next, 'Successor on B')
      expectRoute(replacement, 'account-b')
    })
  })
})
