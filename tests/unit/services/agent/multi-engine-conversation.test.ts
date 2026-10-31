/** Production send/warm/manager/consumer/store paths with a deterministic SDK transport. */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { EngineId } from '../../../../src/shared/types/engine'
import { NativeSessionResumeError } from '../../../../src/shared/types/engine-session'

const m = vi.hoisted(() => ({
  defaultEngine: 'halo' as EngineId,
  sessions: [] as any[],
  create: vi.fn(),
  holdNext: false,
  realStoredSession: false,
  pendingHistoryIds: new Map<string, string[]>(),
  pendingHistoryReads: 0,
  resolveCredentials: vi.fn(async (credentials: any, _effort: unknown, engineId: EngineId) => ({ ...credentials, engineId, displayModel: 'test-model', capabilities: {} })),
  events: vi.fn(),
}))
vi.mock('os', async importOriginal => {
  const actual = await importOriginal<typeof import('os')>()
  const homedir = () => globalThis.__HALO_TEST_DIR__
  return { ...actual, homedir, default: { ...actual, homedir } }
})
vi.mock('../../../../src/main/foundation/config.service', () => ({
  getConfig: () => ({ agent: { sdkEngine: m.defaultEngine, legacySdkEngine: 'anthropic' }, permissions: {} }),
  onApiConfigChange: () => () => {}, getCredentialsGeneration: () => 0,
  resolveClaudeConfigDir: () => join(globalThis.__HALO_TEST_DIR__, '.halo', 'claude-config'),
}))
vi.mock('../../../../src/main/services/space.service', () => ({
  getSpace: (id: string) => ({ id, path: join(globalThis.__HALO_TEST_DIR__, id), isTemp: false }), hasSpace: () => true, touchSpaceActivity: () => {},
}))
vi.mock('../../../../src/main/services/tlon', () => ({ getSeedKBIds: () => [], getKBChatContext: () => null, resolveSourcesForReadPaths: () => [] }))
vi.mock('../../../../src/main/services/conversation-interop', () => ({ getPendingConversationInputIds: (id: string) => { m.pendingHistoryReads++; return m.pendingHistoryIds.get(id) ?? [] } }))
vi.mock('../../../../src/main/services/agent/initialization', () => ({ waitForSdkInitialization: async () => {} }))
vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({
  createSession: m.create,
  getActiveEngine: () => m.defaultEngine, getDefaultEngine: () => m.defaultEngine, getStartupEngine: () => 'anthropic',
  resolveDefaultEngine: async () => m.defaultEngine, ensureEngineAvailable: async () => {}, getEngineCapabilities: () => ({}),
}))
vi.mock('../../../../src/main/services/ai-sources', () => {
  const source = { id: 'account', provider: 'openai', authType: 'api-key', apiUrl: 'http://127.0.0.1:1', apiKey: 'local-test', apiType: 'responses', model: 'test-model' }
  return { getAISourceManager: () => ({ ensureInitialized: async () => {}, getSourceConfig: () => source, getCurrentSourceConfig: () => source, getBackendConfigForSource: () => ({ apiType: 'responses' }) }) }
})
vi.mock('../../../../src/main/services/agent/helpers', () => ({
  getHeadlessElectronPath: () => '/test-node', getWorkingDir: (spaceId: string) => join(globalThis.__HALO_TEST_DIR__, spaceId),
  getApiCredentialsForSelection: async () => ({ provider: 'openai', apiType: 'responses', model: 'test-model', sourceId: 'account' }), getDbMcpServers: () => null,
}))
vi.mock('../../../../src/main/services/agent/sdk-config', () => ({
  resolveCredentialsForSdk: m.resolveCredentials,
  buildUserSessionSdkOptions: async (input: any) => ({ engineId: input.engineId, model: 'test-model', cwd: input.workDir, systemPrompt: `system-${input.engineId}`, sourceId: 'account', env: {} }),
  computeCredentialsFingerprint: (options: any) => JSON.stringify([options.model, options.sourceId]),
  computeSessionInputsFingerprint: (options: any) => JSON.stringify([options.systemPrompt, options.permissionMode]),
  getSdkSourceId: (options: any) => options.sourceId,
}))
vi.mock('../../../../src/main/services/agent/toolsets/broker', () => ({ setSessionInvalidator: () => {}, buildCreationTimeServers: () => ({}), openToolset: () => ({ ok: true }) }))
vi.mock('../../../../src/main/services/agent/toolsets/capability-index', () => ({ buildToolsetSection: () => '' }))
vi.mock('../../../../src/main/services/agent/toolsets/state', () => ({ dropConversationState: () => {}, getOpenToolsets: () => new Set() }))
vi.mock('../../../../src/main/services/api-ref', () => ({ HALO_API_TOOLSET_ID: 'api' }))
vi.mock('../../../../src/main/services/agent/mcp-auth-state', () => ({ purgeStaleMcpOAuth: async () => {} }))
vi.mock('../../../../src/main/services/agent/mcp-manager', () => ({ onMcpServerRecovered: () => () => {}, broadcastMcpStatus: () => {} }))
vi.mock('../../../../src/main/services/agent/mcp-probe', () => ({ probeUnhealthyServers: () => {} }))
vi.mock('../../../../src/main/services/agent/knowledge-context', () => ({ resolveConversationKnowledgeBases: () => [], resolveConversationKnowledgeBaseIds: () => [] }))
vi.mock('../../../../src/main/services/agent/space-memory', () => ({ resolveSpaceMemorySession: () => null, buildSpaceMemoryPreamble: async () => '' }))
vi.mock('../../../../src/main/services/agent/image-attachments', () => ({ prepareNonVisionImageFallback: () => null, OCR_TOOLSET_ID: 'ocr' }))
vi.mock('../../../../src/main/services/agent/reasoning-effort', () => ({ applyReasoningEffort: () => 0, applySessionReasoningEffort: () => {}, pickReasoningEffort: () => undefined }))
vi.mock('../../../../src/main/services/agent/goal', () => ({ prepareGoalInput: (value: any) => value, setGoalForTurn: async () => {} }))
vi.mock('../../../../src/main/services/agent/goal/draft', () => ({ getGoalDraft: () => null, applyGoalDraft: () => {} }))
vi.mock('../../../../src/main/services/agent/subagent-handler', () => ({ hasActiveTeamTasks: () => false, isTeamLifecycleThought: () => false, handleSubAgentMessage: () => {}, handleTaskStarted: () => {}, handleTaskProgress: () => {}, handleTaskNotification: () => {} }))
vi.mock('../../../../src/main/services/agent/stored-session', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../src/main/services/agent/stored-session')>()
  return { ...actual, prepareStoredSession: async (options: Parameters<typeof actual.prepareStoredSession>[0]) => m.realStoredSession ? actual.prepareStoredSession(options) : true }
})
vi.mock('../../../../src/main/services/agent/events', () => ({ emitAgentEvent: m.events }))
vi.mock('../../../../src/main/services/health', () => ({ registerProcess: () => {}, unregisterProcess: () => {}, getCurrentInstanceId: () => null, onAgentError: () => {}, runPpidScanAndCleanup: async () => {} }))
vi.mock('../../../../src/main/services/notification.service', () => ({ notifyTaskComplete: () => {} }))
vi.mock('../../../../src/main/services/analytics/analytics.service', () => ({ analytics: { track: async () => {}, trackErrorSurface: () => {} } }))
vi.mock('../../../../src/main/foundation/logging', () => ({ isDeveloperMode: () => false }))
vi.mock('../../../../src/main/services/agent', async () => {
  const manager = await import('../../../../src/main/services/agent/session-manager')
  const helpers = await import('../../../../src/main/services/agent/helpers')
  const compatibility = await import('../../../../src/main/services/agent/source-compatibility')
  const routing = await import('../../../../src/main/services/agent/engine-routing')
  const sender = await import('../../../../src/main/services/agent/send-message')
  return { sendMessage: sender.sendMessage, getWorkingDir: helpers.getWorkingDir, emitAgentEvent: m.events, onAgentEvent: () => ({ dispose: () => {} }), hasPendingSessionInput: manager.hasPendingSessionInput, assertEngineSourceSelection: compatibility.assertEngineSourceSelection, getLegacyEngine: routing.getLegacyEngine, closeV2Session: manager.closeV2Session, resolveDefaultEngine: async () => m.defaultEngine, ensureEngineAvailable: async () => {}, getApiCredentialsForSelection: helpers.getApiCredentialsForSelection, resolveCredentialsForSdk: m.resolveCredentials }
})
vi.mock('../../../../src/main/platform/task-state', () => ({ getTaskStateService: () => ({}) }))

import { sendMessage } from '../../../../src/main/services/agent/send-message'
import { closeAllV2Sessions, closeV2Session, ensureSessionWarm, getSessionEngineId, isSessionBusy, stopSessionCleanup } from '../../../../src/main/services/agent/session-manager'
import { addMessage, createConversation, getConversation, getConversationEngineState, saveConversationEngineBinding, saveSessionId, updateConversation } from '../../../../src/main/services/conversation.service'
import { createChatConversationSource } from '../../../../src/main/services/conversation-interop/chat-source'
import { updateConversation as updateThroughController } from '../../../../src/main/controllers/conversation.controller'

function fakeSession(options: any) {
  const sessionId = options.resume ?? `${options.engineId}-${m.sessions.length + 1}`
  const frames: any[] = []
  const waiters: Array<() => void> = []
  const pending: Array<{ text: unknown; hold: boolean }> = []
  let active = false
  let closed = false
  const wake = () => { for (const resolve of waiters.splice(0)) resolve() }
  const queue = (frame: any) => { frames.push(frame); wake() }
  const start = () => {
    if (active || closed || !pending.length) return
    active = true
    const input = pending.shift()!
    queue({ type: 'system', subtype: 'init', session_id: sessionId, model: 'test-model', tools: [] })
    if (!input.hold) queueMicrotask(() => session.finish(`reply-${options.engineId}-${session.sent.length}`))
  }
  const session = {
    sessionId, options, sent: [] as unknown[],
    query: { transport: { isReady: () => !closed, onExit: () => () => {} }, supportedCommands: async () => [] },
    send: vi.fn(async (text: unknown) => {
      session.sent.push(text)
      pending.push({ text, hold: m.holdNext }); m.holdNext = false
      start()
    }),
    finish(text: string) {
      queue({ type: 'assistant', uuid: `assistant-${session.sent.length}`, session_id: sessionId, message: { id: `msg-${session.sent.length}`, role: 'assistant', content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: 10 } } })
      queue({ type: 'result', subtype: 'success', session_id: sessionId, result: text, is_error: false, usage: { input_tokens: 10, output_tokens: 10 }, num_turns: 1 })
      active = false
      queueMicrotask(start)
    },
    async *stream() {
      while (!closed) {
        if (!frames.length) { await new Promise<void>(resolve => waiters.push(resolve)); continue }
        const frame = frames.shift()
        yield frame
        if (frame.type === 'result') return
      }
    },
    hasPendingInput: () => pending.length > 0,
    setMaxThinkingTokens: async () => {},
    close: vi.fn(() => { closed = true; wake() }),
  }
  m.sessions.push(session)
  return session
}

async function settled(conversationId: string) {
  await vi.waitFor(() => { expect(isSessionBusy(conversationId)).toBe(false) }, { timeout: 2000, interval: 5 })
}
const send = (id: string, message: string) => sendMessage({ spaceId: 'space', conversationId: id, message })
function seeded(engineId: EngineId = 'anthropic') {
  const conversation = createConversation('space', 'Test', undefined, { engineId })
  addMessage('space', conversation.id, { role: 'user', content: 'ORIGINAL_USER_DECISION' })
  addMessage('space', conversation.id, { role: 'assistant', content: 'ORIGINAL_ASSISTANT_DECISION' })
  saveConversationEngineBinding('space', conversation.id, { version: 1, engineId, sessionId: `stored-${engineId}` }, {})
  return conversation.id
}

beforeEach(() => {
  m.defaultEngine = 'halo'; m.sessions.length = 0; m.holdNext = false; m.realStoredSession = false
  m.pendingHistoryIds.clear(); m.pendingHistoryReads = 0
  m.create.mockReset().mockImplementation(async options => fakeSession(options))
  m.resolveCredentials.mockClear(); m.events.mockClear()
  const dir = join(globalThis.__HALO_TEST_DIR__, 'space/.halo/conversations')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.json'), JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), conversations: [] }))
})
afterEach(async () => { closeAllV2Sessions(); await new Promise(resolve => setTimeout(resolve, 0)) })
afterAll(() => stopSessionCleanup())

describe('production conversation engine continuation', () => {
  it('shares warm-up with the first send and injects history exactly once', async () => {
    const id = seeded()
    expect((await updateThroughController('space', id, { engineOverride: 'halo' })).success).toBe(true)
    await ensureSessionWarm('space', id)
    expect(m.create).toHaveBeenCalledOnce()
    expect(m.sessions[0].sent).toHaveLength(0)
    await send(id, 'FIRST_NEW_INPUT'); await settled(id)
    expect(String(m.sessions[0].sent[0])).toContain('ORIGINAL_USER_DECISION')
    expect(String(m.sessions[0].sent[0])).toContain('FIRST_NEW_INPUT')
    await send(id, 'SECOND_NEW_INPUT'); await settled(id)
    expect(m.create).toHaveBeenCalledOnce()
    expect(m.sessions[0].sent[1]).toBe('SECOND_NEW_INPUT')
    expect(getConversationEngineState('space', id)?.binding?.engineId).toBe('halo')
  })

  it('includes records added after warm-up in the first actual handoff', async () => {
    const id = seeded()
    updateConversation('space', id, { engineOverride: 'halo' })
    await ensureSessionWarm('space', id)
    addMessage('space', id, { role: 'user', content: 'LATE_USER_DECISION_AFTER_WARM' })
    addMessage('space', id, { role: 'assistant', content: 'LATE_ASSISTANT_DECISION_AFTER_WARM' })
    await send(id, 'CONTINUE'); await settled(id)
    expect(String(m.sessions[0].sent[0])).toContain('LATE_USER_DECISION_AFTER_WARM')
    expect(String(m.sessions[0].sent[0])).toContain('LATE_ASSISTANT_DECISION_AFTER_WARM')
  })

  it('does not duplicate the first input when two sends share an in-flight warm-up', async () => {
    const id = seeded()
    updateConversation('space', id, { engineOverride: 'halo' })
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    m.create.mockImplementationOnce(async options => { await barrier; return fakeSession(options) })
    const warm = ensureSessionWarm('space', id)
    await vi.waitFor(() => expect(m.create).toHaveBeenCalledOnce())
    const first = send(id, 'CONCURRENT_FIRST_INPUT')
    await vi.waitFor(() => expect(getConversation('space', id)?.messages.some(message => message.content === 'CONCURRENT_FIRST_INPUT')).toBe(true))
    const second = send(id, 'CONCURRENT_SECOND_INPUT')
    await vi.waitFor(() => expect(getConversation('space', id)?.messages.some(message => message.content === 'CONCURRENT_SECOND_INPUT')).toBe(true))
    release()
    await Promise.all([warm, first, second]); await settled(id)
    expect(m.create).toHaveBeenCalledOnce()
    const sent = m.sessions[0].sent.map(String).join('\n')
    expect(sent.match(/CONCURRENT_FIRST_INPUT/g)).toHaveLength(1)
    expect(sent.match(/CONCURRENT_SECOND_INPUT/g)).toHaveLength(1)
    expect(sent.match(/Historical conversation context follows/g)).toHaveLength(1)
  })

  it('A → B → A carries B-period decisions and creates a new A binding', async () => {
    const id = seeded('halo')
    expect((await updateThroughController('space', id, { engineOverride: 'codex' })).success).toBe(true)
    await send(id, 'DECISION_WHILE_USING_B'); await settled(id)
    const b = m.sessions[0]
    expect(getConversationEngineState('space', id)?.binding?.engineId).toBe('codex')
    expect((await updateThroughController('space', id, { engineOverride: 'halo' })).success).toBe(true)
    await ensureSessionWarm('space', id)
    await send(id, 'BACK_TO_A'); await settled(id)
    const a = m.sessions[1]
    expect(a.options.resume).toBeUndefined()
    expect(String(a.sent[0])).toContain('DECISION_WHILE_USING_B')
    expect(String(a.sent[0])).toContain('reply-codex-1')
    expect(getConversationEngineState('space', id)?.binding?.sessionId).toBe(a.sessionId)
    expect(b.close).toHaveBeenCalledOnce()
  })

  it('rebuilds a failed strict native resume from neutral history only on that failure', async () => {
    const id = seeded('codex')
    m.create.mockImplementationOnce(async options => { throw new NativeSessionResumeError('codex', options.resume) })
    await send(id, 'RECOVER_AND_CONTINUE'); await settled(id)
    expect(m.create).toHaveBeenCalledTimes(2)
    expect(m.create.mock.calls[0][0]).toMatchObject({ resume: 'stored-codex', strictNativeResume: true })
    expect(m.create.mock.calls[1][0].resume).toBeUndefined()
    expect(String(m.sessions[0].sent[0])).toContain('ORIGINAL_ASSISTANT_DECISION')
    expect(getConversationEngineState('space', id)?.binding?.sessionId).toBe(m.sessions[0].sessionId)
  })

  it('refreshes a warm native-recovery snapshot before the first actual send', async () => {
    const id = seeded('codex')
    m.create.mockImplementationOnce(async options => { throw new NativeSessionResumeError('codex', options.resume) })
    await ensureSessionWarm('space', id)
    expect(m.create).toHaveBeenCalledTimes(2)
    addMessage('space', id, { role: 'user', content: 'NEW_DECISION_AFTER_RECOVERY_WARM' })
    addMessage('space', id, { role: 'assistant', content: 'NEW_RESULT_AFTER_RECOVERY_WARM' })
    await send(id, 'USE_THE_LATEST_RECORD'); await settled(id)
    expect(m.create).toHaveBeenCalledTimes(2)
    expect(String(m.sessions[0].sent[0])).toContain('NEW_DECISION_AFTER_RECOVERY_WARM')
    expect(String(m.sessions[0].sent[0])).toContain('NEW_RESULT_AFTER_RECOVERY_WARM')
  })

  it('does not restore a stale legacy copy when a known native binding has lost its current file', async () => {
    const id = seeded('halo')
    addMessage('space', id, { role: 'user', content: 'NEW_DECISION_NOT_IN_LEGACY_NATIVE' })
    addMessage('space', id, { role: 'assistant', content: 'NEW_RESULT_NOT_IN_LEGACY_NATIVE' })
    const workDir = join(globalThis.__HALO_TEST_DIR__, 'space')
    const legacy = join(globalThis.__HALO_TEST_DIR__, '.claude', 'projects', workDir.replace(/[^a-zA-Z0-9]/g, '-'))
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'stored-halo.jsonl'), JSON.stringify({ type: 'user', message: { role: 'user', content: 'LEGACY_STALE_CONTEXT' } }) + '\n')
    m.realStoredSession = true
    await send(id, 'RECOVER_LATEST_CONTEXT'); await settled(id)
    expect(m.sessions[0].options.resume).toBeUndefined()
    expect(String(m.sessions[0].sent[0])).toContain('NEW_DECISION_NOT_IN_LEGACY_NATIVE')
    expect(String(m.sessions[0].sent[0])).toContain('NEW_RESULT_NOT_IN_LEGACY_NATIVE')
  })

  it('keeps the binding after SDK creation failure and can return to the old engine', async () => {
    const id = seeded('codex')
    const original = getConversationEngineState('space', id)
    expect((await updateThroughController('space', id, { engineOverride: 'halo' })).success).toBe(true)
    m.create.mockRejectedValueOnce(new Error('SDK creation failed'))
    await send(id, 'FAILED_SWITCH')
    expect(getConversationEngineState('space', id)).toEqual(original)
    expect(getConversation('space', id)?.messages.some(message => message.content === 'ORIGINAL_USER_DECISION')).toBe(true)
    expect((await updateThroughController('space', id, { engineOverride: 'codex' })).success).toBe(true)
    await send(id, 'BACK_TO_ORIGINAL'); await settled(id)
    expect(m.sessions[0].options.resume).toBe('stored-codex')
    expect(getSessionEngineId(id)).toBe('codex')
  })

  it('keeps the busy engine and its configuration until accepted work finishes', async () => {
    const conversation = createConversation('space')
    m.holdNext = true
    await send(conversation.id, 'LONG_RUNNING_TASK')
    await vi.waitFor(() => expect(isSessionBusy(conversation.id)).toBe(true))
    expect((await updateThroughController('space', conversation.id, { engineOverride: 'codex' })).success).toBe(true)
    await ensureSessionWarm('space', conversation.id)
    await send(conversation.id, 'FOLLOWUP_FOR_RUNNING_TASK')
    expect(m.create).toHaveBeenCalledOnce()
    expect(getSessionEngineId(conversation.id)).toBe('halo')
    expect(m.resolveCredentials.mock.calls.at(-1)?.[2]).toBe('halo')
    expect(m.sessions[0].sent).toEqual(['LONG_RUNNING_TASK', 'FOLLOWUP_FOR_RUNNING_TASK'])
    m.sessions[0].finish('Finished the original work')
    await settled(conversation.id)
    await send(conversation.id, 'NEXT_IDLE_TURN'); await settled(conversation.id)
    expect(getSessionEngineId(conversation.id)).toBe('codex')
  })

  it('retries a new conversation on its chosen default after a creation failure', async () => {
    m.defaultEngine = 'codex'
    const conversation = createConversation('space', 'New', undefined, { engineId: 'codex' })
    m.create.mockRejectedValueOnce(new Error('Transient SDK startup failure'))
    await send(conversation.id, 'FIRST_ATTEMPT')
    expect(getConversationEngineState('space', conversation.id)?.binding).toBeUndefined()
    await send(conversation.id, 'RETRY_THE_TASK'); await settled(conversation.id)
    expect(m.create.mock.calls.map(call => call[0].engineId)).toEqual(['codex', 'codex'])
    expect(getSessionEngineId(conversation.id)).toBe('codex')
    expect(String(m.sessions[0].sent[0])).toContain('FIRST_ATTEMPT')
  })

  it('records an interop batch through the actual async send callback before handoff reads it', async () => {
    const id = seeded('anthropic')
    expect((await updateThroughController('space', id, { engineOverride: 'halo' })).success).toBe(true)
    const source = createChatConversationSource()
    const outcomes = await source.dispatchBatch!('space', id, [
      { turnInput: 'WIRE_FIRST', record: { content: 'Readable first', source: 'cross-conversation', metadata: {} } },
      { turnInput: 'WIRE_SECOND', record: { content: 'Readable second', source: 'cross-conversation', metadata: {} } },
    ])
    await settled(id)
    const records = getConversation('space', id)!.messages
    expect(outcomes.every(outcome => outcome.messageId)).toBe(true)
    expect(records.find(record => record.id === outcomes[0].messageId)).toMatchObject({ role: 'system', source: 'cross-conversation', content: 'Readable first' })
    expect(records.find(record => record.id === outcomes[1].messageId)).toMatchObject({ role: 'system', source: 'cross-conversation', content: 'Readable second' })
    expect(records.some(record => record.content === 'WIRE_FIRST\n\nWIRE_SECOND')).toBe(false)
    const sent = String(m.sessions[0].sent[0])
    expect(sent).toContain('ORIGINAL_USER_DECISION')
    expect(sent.match(/WIRE_FIRST/g)).toHaveLength(1)
    expect(sent.match(/WIRE_SECOND/g)).toHaveLength(1)
    expect(sent).not.toContain('Readable first')
    expect(sent).not.toContain('Readable second')
  })

  it('excludes pending interop records from a new engine, then redelivers them exactly once by ID', async () => {
    const id = seeded('anthropic')
    const held = addMessage('space', id, { role: 'system', content: 'SPACE_HELD_REQUEST', source: 'cross-conversation' })
    m.pendingHistoryIds.set(id, [held.id])
    expect((await updateThroughController('space', id, { engineOverride: 'halo' })).success).toBe(true)
    await ensureSessionWarm('space', id)
    await send(id, 'OWNER_STARTS_NEW_ENGINE'); await settled(id)
    expect(String(m.sessions[0].sent[0])).not.toContain('SPACE_HELD_REQUEST')
    m.pendingHistoryIds.delete(id)
    expect((await updateThroughController('space', id, { engineOverride: 'codex' })).success).toBe(true)
    await createChatConversationSource().dispatchBatch!('space', id, [
      { turnInput: 'SPACE_HELD_REQUEST', record: { content: 'SPACE_HELD_REQUEST', source: 'cross-conversation', metadata: {} }, inputRecorded: true, recordedInputIds: [held.id] },
      { turnInput: 'NEW_DELIVERY', record: { content: 'NEW_DELIVERY', source: 'cross-conversation', metadata: {} } },
    ])
    await settled(id)
    expect(String(m.sessions[1].sent[0]).match(/SPACE_HELD_REQUEST/g)).toHaveLength(1)
    expect(String(m.sessions[1].sent[0])).toContain('reply-halo-1')
    expect(getConversation('space', id)!.messages.filter(message => message.content === 'SPACE_HELD_REQUEST')).toHaveLength(1)
  })

  it('does not read pending interop history on healthy native resume', async () => {
    const id = seeded('halo')
    await send(id, 'NORMAL_FIRST'); await settled(id)
    await send(id, 'NORMAL_SECOND'); await settled(id)
    expect(m.pendingHistoryReads).toBe(0)
  })

  it('keeps legacy sessions on their original engine after changing the global default', async () => {
    const conversation = createConversation('space')
    delete conversation.engineRoutingVersion
    addMessage('space', conversation.id, { role: 'user', content: 'Legacy history' })
    saveSessionId('space', conversation.id, 'legacy-native-id')
    m.defaultEngine = 'codex'
    await send(conversation.id, 'CONTINUE_LEGACY'); await settled(conversation.id)
    expect(m.sessions[0].options.engineId).toBe('anthropic')
    expect(m.sessions[0].options.resume).toBe('legacy-native-id')
    expect(m.sessions[0].sent[0]).toBe('CONTINUE_LEGACY')
  })
})
