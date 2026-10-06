/**
 * Unit tests for apps/runtime/execute (executeRun) — decision branches only.
 *
 * executeRun orchestrates a headless automation run end-to-end. The real agent
 * SDK, memory, prompt-building side effects, IM registry and file IO are all
 * mocked; a fake session drives the SDK stream so the tests exercise ONLY the
 * run-lifecycle decisions:
 *
 *   - non-automation app → RunExecutionError (guard)
 *   - report_to_user detected → status ok / outcome useful, run completed
 *   - result.is_error → outcome error
 *   - AI never calls report_to_user → auto-continue loop then outcome error
 *   - abort → loop short-circuits, no auto-continue nagging
 *   - stop of a silent run → engine interrupted, then closed, so the run ends
 *   - stream throws → mapped to error outcome with errorMessage recorded
 *
 * We assert on the returned AppRunResult and on store.completeRun, which is the
 * observable contract of the branch decisions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// ── Agent SDK + electron-touching dependencies (mirrors runtime.test.ts) ──
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  unstable_v2_createSession: vi.fn(),
  tool: vi.fn((opts: any) => ({ ...opts, _isTool: true })),
  createSdkMcpServer: vi.fn((opts: any) => ({ ...opts, _isMcpServer: true })),
}))

vi.mock('../../../../src/main/services/agent/helpers', () => ({
  getApiCredentials: vi.fn().mockResolvedValue({
    baseUrl: 'https://api.test.com',
    apiKey: 'test-key',
    model: 'test-model',
    provider: 'anthropic',
  }),
  getApiCredentialsForSource: vi.fn().mockResolvedValue({
    provider: 'anthropic',
  }),
  getHeadlessElectronPath: vi.fn().mockReturnValue('/usr/bin/electron'),
  getWorkingDir: vi.fn().mockReturnValue('/tmp/test-work'),
  getMcpServersForRequires: vi.fn().mockReturnValue({}),
}))

vi.mock('../../../../src/main/services/agent/sdk-config', () => ({
  resolveCredentialsForSdk: vi.fn().mockResolvedValue({
    anthropicBaseUrl: 'https://api.test.com',
    anthropicApiKey: 'test-key',
    sdkModel: 'test-model',
    displayModel: 'Test Model',
  }),
  // Faithful stand-in for the real env builder's auth-channel rule; the real
  // invariants are pinned in tests/unit/services/agent/delegated-auth.test.ts.
  buildSdkEnv: vi.fn((params: {
    anthropicApiKey: string
    anthropicBaseUrl: string
    delegatedRoutingHeader?: string
  }) => ({
    ANTHROPIC_BASE_URL: params.anthropicBaseUrl,
    ...(params.delegatedRoutingHeader
      ? { ANTHROPIC_CUSTOM_HEADERS: params.delegatedRoutingHeader }
      : { ANTHROPIC_API_KEY: params.anthropicApiKey }),
  })),
  // Echoes back the caller's `mcpServers` (built by execute.ts from declared
  // requires + always-on built-ins) instead of a fixed `{}` — that merge is
  // exactly what the MCP-wiring tests below observe.
  buildUserSessionSdkOptions: vi.fn((opts: { mcpServers?: Record<string, unknown> }) => ({
    model: 'test-model',
    cwd: '/tmp/test',
    maxTurns: 999,
    systemPrompt: '',
    mcpServers: opts.mcpServers ?? {},
  })),
}))

vi.mock('../../../../src/main/foundation/config.service', () => ({
  getConfig: vi.fn().mockReturnValue({ agent: {}, notificationChannels: {} }),
  resolveClaudeConfigDir: vi.fn().mockReturnValue('/tmp/cc-config'),
}))

vi.mock('../../../../src/main/apps/manager', () => ({
  getAppManager: vi.fn(() => ({ getAppWorkDir: () => '/tmp/app-1' })),
}))
vi.mock('../../../../src/main/apps/runtime/execution-environment', () => ({
  resolveExecutionEnvironment: vi.fn(() => ({
    spaceId: 'space-1', spacePath: '/tmp/space-1', workDir: '/tmp/space-1', memoryDir: '/tmp/app-1',
  })),
  validateExecutionEnvironment: vi.fn(),
  validateEnvironmentConnections: vi.fn(),
  missingConnections: vi.fn(() => []),
}))
vi.mock('../../../../src/main/apps/runtime/person-context-tool', () => ({
  createPersonContextMcpServer: vi.fn(() => ({ name: 'halo-person-context' })),
  personContextPrompt: vi.fn(() => ''),
}))

vi.mock('../../../../src/main/services/space.service', () => ({
  getSpace: vi.fn().mockReturnValue({ id: 'space-1', path: '/tmp/space-1' }),
  getSpaceDir: vi.fn().mockReturnValue('/tmp/space-1'),
}))

// The budget is tested on its own (session-budget.test.ts); here only its call matters.
vi.mock('../../../../src/main/apps/runtime/session-budget', () => ({ admitTransientSession: vi.fn() }))
vi.mock('../../../../src/main/services/ai-browser', () => ({
  createAIBrowserMcpServer: vi.fn().mockReturnValue({ name: 'ai-browser', _isMcpServer: true }),
  createScopedBrowserContext: vi.fn(() => ({ destroy: vi.fn() })),
}))

vi.mock('../../../../src/main/services/ai-terminal', () => ({
  createTerminalMcpServer: vi.fn().mockReturnValue({ name: 'ai-terminal', _isMcpServer: true }),
  getGlobalTerminalContext: vi.fn(),
  isTerminalAvailable: vi.fn().mockReturnValue(false),
}))

vi.mock('../../../../src/main/services/web-search', () => ({
  createWebSearchMcpServer: vi.fn().mockReturnValue({ name: 'web-search', _isMcpServer: true }),
}))

vi.mock('../../../../src/main/services/ocr', () => ({
  createOcrMcpServer: vi.fn().mockReturnValue({ name: 'ocr', _isMcpServer: true }),
}))
vi.mock('../../../../src/main/services/official-docs-mcp', () => ({
  createOfficialDocsSession: vi.fn(() => ({
    server: { name: 'halo-docs', _isMcpServer: true },
    guideConsulted: () => false,
  })),
}))

vi.mock('../../../../src/main/services/email-mcp', () => ({
  createEmailMcpServer: vi.fn().mockReturnValue(null),
}))

vi.mock('../../../../src/main/services/agent/session-manager', () => ({
  acquireV2Session: vi.fn(),
  createSessionState: vi.fn((spaceId: string, conversationId: string, abortController: AbortController) => ({
    spaceId, conversationId, abortController, thoughts: [],
  })),
  registerActiveSession: vi.fn(),
  unregisterActiveSession: vi.fn(),
  closeV2Session: vi.fn(),
  getRunningConsumerIds: () => [],
  isSessionBusy: () => false,
}))
vi.mock('../../../../src/main/apps/runtime/app-chat-sink', () => ({
  getConversationsWithActiveRound: () => [],
}))

// Keep the public surface limited to the runtime's references and session lifecycle.
vi.mock('../../../../src/main/services/agent', async () => ({
  formatReferencesBlock: (await vi.importActual<typeof import('../../../../src/main/services/agent/references')>(
    '../../../../src/main/services/agent/references',
  )).formatReferencesBlock,
  ...(await import('../../../../src/main/services/agent/session-manager')),
}))

// The fake session used by createSession — swapped per test via nextSession.
let nextSession: FakeSession
vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({
  createSession: vi.fn(async () => nextSession),
  query: vi.fn(),
  getActiveEngine: () => null,
  getEngineCapabilities: () => ({ features: { interrupt: true } }),
}))

// The memory lifecycle is exercised by its own tests; here only its wiring.
vi.mock('../../../../src/main/apps/runtime/turn/memory-lifecycle', () => ({
  prepareMemoryForTurn: vi.fn().mockResolvedValue({
    snapshot: { exists: false, totalLines: 0, sizeBytes: 0, headers: [] },
    runTimestamp: '2026-08-30-1000',
  }),
  finalizeMemoryAfterTurn: vi.fn().mockResolvedValue(undefined),
  memoryPromptOptions: vi.fn().mockReturnValue({}),
  loadSpaceTopicsForTurn: vi.fn().mockResolvedValue(null),
  appMemoryGuard: vi.fn().mockReturnValue({ writable: [], readOnly: [], label: 'test' }),
  appMemorySettings: vi.fn().mockReturnValue({ enabled: true, autoConsolidate: true, cadence: 'diligent' }),
}))

vi.mock('../../../../src/main/apps/runtime/memory-control', () => ({
  appConsolidationInputs: vi.fn((app: { spec: { name: string } }) => ({ appName: app.spec.name })),
}))

// Captures the escalation callback so a test can raise one mid-stream, the way
// the real tool handler does from inside the turn.
let raiseEscalation: ((entryId: string) => void) | undefined
vi.mock('../../../../src/main/apps/runtime/report-tool', () => ({
  createReportToolServer: vi.fn((_store: unknown, _ctx: unknown, onEscalation?: (id: string) => void) => {
    raiseEscalation = onEscalation
    return { name: 'halo-report', _isMcpServer: true }
  }),
}))

vi.mock('../../../../src/main/apps/runtime/notify-tool', () => ({
  createNotifyToolServer: vi.fn().mockReturnValue({ name: 'halo-notify', _isMcpServer: true }),
}))

// Stubbed so the real helper's transitive notify-channels → logging import
// (which needs a fuller config.service mock) stays out of this orchestration test.
vi.mock('../../../../src/main/apps/runtime/notify-availability', () => ({
  resolveNotifyAvailability: vi.fn().mockReturnValue({
    channelsConfigured: false,
    emailChannelConfigured: false,
    imContactsAvailable: false,
    notifyBotAvailable: false,
    anyNotifyToolAvailable: false,
  }),
}))

vi.mock('../../../../src/main/apps/runtime/file-export-gate', () => ({
  FileExportGate: vi.fn().mockImplementation(() => ({})),
}))

vi.mock('../../../../src/main/apps/runtime/im-session-registry', () => ({
  getImSessionRegistry: vi.fn().mockReturnValue(null),
}))

vi.mock('../../../../src/main/apps/runtime/im-auto-sync', () => ({
  autoSyncRunResult: vi.fn().mockResolvedValue({}),
}))

vi.mock('../../../../src/main/apps/runtime/session-store', () => ({
  openSessionWriter: vi.fn(() => ({
    writeTrigger: vi.fn(),
    writeEvent: vi.fn(),
  })),
}))

vi.mock('../../../../src/main/apps/runtime/active-runs', () => ({
  registerActiveRun: vi.fn(),
  unregisterActiveRun: vi.fn(),
  listActiveRuns: vi.fn(() => []),
}))

// Keep prompt building cheap and side-effect-free.
vi.mock('../../../../src/main/apps/runtime/prompt', () => ({
  buildAppSystemPrompt: vi.fn().mockReturnValue('SYSTEM PROMPT'),
  buildInitialMessage: vi.fn().mockReturnValue('INITIAL MESSAGE'),
  buildEscalationResumeMessage: vi.fn().mockReturnValue('ESCALATION RESUME'),
}))

import { executeRun } from '../../../../src/main/apps/runtime/execute'
import { ENGINE_STOP_GRACE_MS } from '../../../../src/main/apps/runtime/engine-stop'
import { finalizeMemoryAfterTurn, prepareMemoryForTurn, loadSpaceTopicsForTurn, appMemorySettings } from '../../../../src/main/apps/runtime/turn/memory-lifecycle'
import { generatePromptInstructions } from '../../../../src/main/platform/memory'
import { buildAppSystemPrompt, buildInitialMessage } from '../../../../src/main/apps/runtime/prompt'
import { RunExecutionError } from '../../../../src/main/apps/runtime/errors'
import { query as agentSdkQuery, createSession } from '../../../../src/main/services/agent/resolved-sdk'
import { getApiCredentials, getApiCredentialsForSource, getMcpServersForRequires } from '../../../../src/main/services/agent/helpers'
import { resolveCredentialsForSdk, buildUserSessionSdkOptions } from '../../../../src/main/services/agent/sdk-config'
import {
  acquireV2Session,
  createSessionState,
  registerActiveSession,
  unregisterActiveSession,
  closeV2Session,
} from '../../../../src/main/services/agent/session-manager'
import { missingConnections, resolveExecutionEnvironment } from '../../../../src/main/apps/runtime/execution-environment'
import { openSessionWriter } from '../../../../src/main/apps/runtime/session-store'

// ============================================
// Fakes
// ============================================

type SdkMessage = Record<string, unknown>

/** A fake V2 session whose stream() yields a scripted (or throwing) message list. */
class FakeSession {
  send = vi.fn()
  close = vi.fn()
  private readonly script: SdkMessage[]
  private readonly throwOnStream: Error | null
  private readonly onYield: ((message: SdkMessage) => void) | null
  /** How many times stream() has been consumed (each auto-continue re-streams). */
  streamCalls = 0
  /** Messages actually handed to the consumer — a cut turn leaves some unread. */
  yielded: SdkMessage[] = []

  constructor(opts: {
    script?: SdkMessage[]
    throwOnStream?: Error | null
    /** Runs after each message is yielded, for side effects a tool would have. */
    onYield?: (message: SdkMessage) => void
  } = {}) {
    this.script = opts.script ?? []
    this.throwOnStream = opts.throwOnStream ?? null
    this.onYield = opts.onYield ?? null
  }

  stream(): AsyncGenerator<SdkMessage> {
    this.streamCalls++
    const script = this.streamCalls === 1 ? this.script : []
    const throwOnStream = this.throwOnStream
    const onYield = this.onYield
    const yielded = this.yielded
    return (async function* () {
      if (throwOnStream) throw throwOnStream
      for (const m of script) {
        yielded.push(m)
        yield m
        onYield?.(m)
      }
    })()
  }
}

const closeManagedSession = vi.fn()
const releaseManagedSession = vi.fn()

function managedLease(session: FakeSession) {
  closeManagedSession.mockImplementation(() => session.close())
  return { session, isCurrent: true, send: session.send, close: closeManagedSession, release: releaseManagedSession }
}

function makeApp(overrides: Record<string, unknown> = {}) {
  return {
    id: 'app-1',
    spaceId: 'space-1',
    spec: {
      type: 'automation',
      name: 'Test App',
      config_schema: [],
      permissions: [],
      requires: {},
    },
    permissions: { granted: [], denied: [] },
    userConfig: {},
    userOverrides: {},
    ...overrides,
  } as any
}

function makeStore() {
  return {
    getRun: vi.fn(),
    pinRunEnvironment: vi.fn(),
    insertRun: vi.fn(),
    completeRun: vi.fn(),
    updateRunSessionId: vi.fn(),
    insertEntry: vi.fn(),
  } as any
}

function makeMemory() {
  return {
    getPromptInstructions: vi.fn(generatePromptInstructions),
    saveSessionSummary: vi.fn().mockResolvedValue(undefined),
  } as any
}

function assistantReport(): SdkMessage {
  return {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'All done.' },
        { type: 'tool_use', name: 'mcp__halo-report__report_to_user', input: {} },
      ],
    },
  }
}

function systemInit(sessionId = 'cc-session-xyz'): SdkMessage {
  return { type: 'system', subtype: 'init', session_id: sessionId }
}

const baseTrigger = {
  type: 'schedule' as const,
  description: 'scheduled tick',
}

// ============================================
// Tests
// ============================================

describe('executeRun — guards', () => {
  beforeEach(() => {
    nextSession = new FakeSession()
  })

  it('records an unavailable pinned account as a run failure without resolving global credentials', async () => {
    vi.mocked(getApiCredentials).mockClear()
    vi.mocked(createSession).mockClear()
    vi.mocked(getApiCredentialsForSource).mockRejectedValueOnce(new Error('AI source is unavailable. Please select an available source.'))
    const store = makeStore()
    const result = await executeRun({
      app: makeApp({ userOverrides: { modelSourceId: 'removed', modelId: 'old-model' } }),
      trigger: baseTrigger, store, memory: makeMemory(),
    })
    expect(result.outcome).toBe('error')
    expect(result.errorMessage).toContain('unavailable')
    expect(getApiCredentialsForSource).toHaveBeenCalledWith('removed', 'old-model')
    expect(getApiCredentials).not.toHaveBeenCalled()
    expect(createSession).not.toHaveBeenCalled()
    expect(store.completeRun).toHaveBeenCalledWith(result.runId, expect.objectContaining({ status: 'error' }))
  })

  it('throws RunExecutionError for a non-automation app', async () => {
    const app = makeApp({ spec: { type: 'mcp', name: 'x' } })
    await expect(
      executeRun({ app, trigger: baseTrigger, store: makeStore(), memory: makeMemory() }),
    ).rejects.toBeInstanceOf(RunExecutionError)
  })
})

describe('executeRun — completion branches', () => {
  it('completes ok/useful when report_to_user is called', async () => {
    nextSession = new FakeSession({ script: [systemInit(), assistantReport()] })
    const store = makeStore()
    const result = await executeRun({
      app: makeApp(),
      trigger: baseTrigger,
      store,
      memory: makeMemory(),
    })

    expect(result.outcome).toBe('useful')
    expect(result.finalText).toContain('All done.')
    expect(store.completeRun).toHaveBeenCalledWith(
      result.runId,
      expect.objectContaining({ status: 'ok' }),
    )
    // CC session id captured from system init → persisted for resume.
    expect(store.updateRunSessionId).toHaveBeenCalledWith(result.runId, 'cc-session-xyz')
    expect(nextSession.close).toHaveBeenCalledTimes(1)
  })

  it('maps a result.is_error message to outcome error', async () => {
    nextSession = new FakeSession({
      script: [assistantReport(), { type: 'result', is_error: true, result: 'model rate-limited' }],
    })
    const store = makeStore()
    const result = await executeRun({
      app: makeApp(),
      trigger: baseTrigger,
      store,
      memory: makeMemory(),
    })
    expect(result.outcome).toBe('error')
    // The SDK result text flows into both the DB completion and the returned
    // result, so downstream surfaces (updateLastRun, RunFinishedEvent) get it.
    expect(result.errorMessage).toBe('model rate-limited')
    expect(store.completeRun).toHaveBeenCalledWith(
      result.runId,
      expect.objectContaining({ status: 'error', errorMessage: 'model rate-limited' }),
    )
  })

  it('adds up what the model processed over the run, cache included, beside the input and output total', async () => {
    const usage = (input: number, output: number, cacheRead: number, cacheWrite: number) => ({
      type: 'result',
      usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite },
    })
    nextSession = new FakeSession()
    let cycle = 0
    vi.spyOn(nextSession, 'stream').mockImplementation(async function* () {
      cycle++
      // The first turn ends without a report, so the run auto-continues once.
      if (cycle === 1) yield usage(100, 50, 4000, 300)
      else { yield assistantReport(); yield usage(20, 30, 5000, 0) }
    })

    const result = await executeRun({ app: makeApp(), trigger: baseTrigger, store: makeStore(), memory: makeMemory() })

    expect(result.outcome).toBe('useful')
    expect(result.tokenUsage).toEqual({ inputTokens: 120, outputTokens: 80, cacheReadTokens: 9000, cacheCreationTokens: 300 })
    // The stored figure keeps its meaning: input and output only.
    expect(result.tokensUsed).toBe(200)
  })

  it('leaves a failure entry with the reason when the engine fails after the run reported', async () => {
    nextSession = new FakeSession({
      script: [assistantReport(), { type: 'result', is_error: true, result: 'model rate-limited' }],
    })
    const emitEntry = vi.fn()

    const result = await executeRun({ app: makeApp(), trigger: baseTrigger, store: makeStore(), memory: makeMemory(), emitEntry })

    expect(result.outcome).toBe('error')
    // The report alone would read as success; the timeline also says it failed, and why.
    expect(emitEntry).toHaveBeenCalledWith(expect.objectContaining({
      type: 'run_error',
      content: expect.objectContaining({
        summary: 'This run finally ended with an error: model rate-limited',
        error: 'model rate-limited',
        status: 'error',
      }),
    }))
  })

  it('auto-continues then errors when report_to_user is never called', async () => {
    // Empty stream on every cycle → the auto-continue loop runs to its cap.
    nextSession = new FakeSession({ script: [] })
    const store = makeStore()
    const emitEntry = vi.fn()
    const result = await executeRun({
      app: makeApp(),
      trigger: baseTrigger,
      store,
      memory: makeMemory(),
      emitEntry,
    })

    expect(result.outcome).toBe('error')
    // The no-report reason names the retry cap instead of degrading to a bare
    // "failed" status — lastError surfaces this text to the app state UI.
    expect(result.errorMessage).toBe(
      'AI ended without reporting results after 10 auto-continue attempt(s)'
    )
    // 1 initial stream + MAX_AUTO_CONTINUES (10) retries = 11 stream cycles.
    expect(nextSession.streamCalls).toBe(11)
    // A run_error activity entry is surfaced for the no-report case.
    expect(emitEntry).toHaveBeenCalled()
  })
})

describe('executeRun — a run that asks the user', () => {
  /**
   * The run used to be asked, in the tool result, to stop after escalating —
   * and routinely kept working, acting on the very decision it had just said it
   * could not make alone. The stop is now the runtime's, and it lands only once
   * the question's tool call has its result: cutting earlier would leave a call
   * unanswered in the transcript the user's reply has to resume against.
   */
  it('ends the run at the escalation instead of letting the model carry on', async () => {
    const askUser: SdkMessage = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'call-1', name: 'mcp__halo-report__report_to_user' }] },
    }
    const askResult: SdkMessage = {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'call-1' }] },
    }
    const afterwards: SdkMessage = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'carrying on anyway' }] },
    }

    raiseEscalation = undefined
    nextSession = new FakeSession({
      script: [systemInit(), askUser, askResult, afterwards],
      // The real tool handler fires this from inside the turn, between the
      // call and its result reaching the consumer.
      onYield: message => { if (message === askUser) raiseEscalation?.('entry-1') },
    })

    const store = makeStore()
    const result = await executeRun({
      app: makeApp(),
      trigger: baseTrigger,
      store,
      memory: makeMemory(),
    })

    expect(store.completeRun).toHaveBeenCalledWith(
      result.runId,
      expect.objectContaining({ status: 'waiting_user' }),
    )
    expect(result.outcome).toBe('useful')
    // Whatever the model said after asking is discarded, not reported.
    expect(nextSession.yielded).not.toContain(afterwards)
    expect(result.finalText ?? '').not.toContain('carrying on anyway')
    // The question counts as having reported, so nothing nags the run onward.
    expect(nextSession.streamCalls).toBe(1)
  })
})

describe('executeRun — abort handling', () => {
  it('sends nothing and does not auto-continue when stopped before its first turn', async () => {
    const controller = new AbortController()
    controller.abort()
    nextSession = new FakeSession({ script: [] })
    const result = await executeRun({
      app: makeApp(),
      trigger: baseTrigger,
      store: makeStore(),
      memory: makeMemory(),
      abortSignal: controller.signal,
    })

    // Stopped while the engine was starting: no turn is sent, so none is paid
    // for, and the auto-continue loop never iterates (its guard checks aborted).
    expect(nextSession.send).not.toHaveBeenCalled()
    expect(nextSession.streamCalls).toBe(0)
    expect(result.outcome).toBe('error')
    expect(result.errorMessage).toBe('Stopped before reporting results')
  })
})

/** An engine gone silent: nothing arrives until it is closed, and interrupting it does nothing. */
class SilentSession {
  send = vi.fn()
  interrupt = vi.fn(async () => {})
  close = vi.fn(() => this.end())
  private end!: () => void
  private readonly closed = new Promise<void>(resolve => { this.end = resolve })

  stream(): AsyncGenerator<SdkMessage> {
    const closed = this.closed
    return (async function* () {
      await closed
    })()
  }
}

describe('executeRun — stopping a run', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('ends a silent run: the engine is interrupted, then closed after the grace period', async () => {
    const session = new SilentSession()
    nextSession = session as unknown as FakeSession
    const controller = new AbortController()
    const emitEntry = vi.fn()
    const running = executeRun({
      app: makeApp(),
      trigger: baseTrigger,
      store: makeStore(),
      memory: makeMemory(),
      abortSignal: controller.signal,
      emitEntry,
    })
    await vi.waitFor(() => expect(session.send).toHaveBeenCalled())
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    controller.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(session.interrupt).toHaveBeenCalledTimes(1)
    expect(session.close).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(ENGINE_STOP_GRACE_MS)
    const result = await running

    expect(session.close).toHaveBeenCalled()
    expect(result.outcome).toBe('error')
    expect(result.errorMessage).toBe('Stopped before reporting results')
    // The stop, not the model, is why nothing was reported.
    const entry = emitEntry.mock.calls.at(-1)?.[0]
    expect(entry).toMatchObject({ type: 'run_error', content: { summary: 'Stopped before it reported results.' } })
    expect(entry.content.error).toBeUndefined()
  })

  it('leaves the engine alone once the run has ended', async () => {
    nextSession = new FakeSession({ script: [systemInit(), assistantReport()] })
    const interrupt = vi.fn()
    Object.assign(nextSession, { interrupt })
    const controller = new AbortController()
    const result = await executeRun({
      app: makeApp(),
      trigger: baseTrigger,
      store: makeStore(),
      memory: makeMemory(),
      abortSignal: controller.signal,
    })

    controller.abort()

    expect(result.outcome).toBe('useful')
    expect(interrupt).not.toHaveBeenCalled()
    // Closed once, by the run itself.
    expect(nextSession.close).toHaveBeenCalledTimes(1)
  })
})

describe('executeRun — a declared connection is unusable', () => {
  it('does not start: no model call, a failed run whose entry names what to install or turn on', async () => {
    const missing = [{ id: 'docs', name: 'Team Docs', state: 'not_installed' as const }]
    vi.mocked(missingConnections).mockReturnValueOnce(missing)
    vi.mocked(createSession).mockClear()
    vi.mocked(getApiCredentials).mockClear()
    nextSession = new FakeSession({ script: [assistantReport()] })
    const store = makeStore()
    const emitEntry = vi.fn()

    const result = await executeRun({ app: makeApp(), trigger: baseTrigger, store, memory: makeMemory(), emitEntry })

    expect(getApiCredentials).not.toHaveBeenCalled()
    expect(createSession).not.toHaveBeenCalled()
    expect(nextSession.send).not.toHaveBeenCalled()
    expect(result.outcome).toBe('error')
    expect(result.errorMessage).toContain('"Team Docs" (not installed)')
    expect(store.completeRun).toHaveBeenCalledWith(result.runId, expect.objectContaining({ status: 'error' }))
    const entry = emitEntry.mock.calls.at(-1)?.[0]
    expect(entry).toMatchObject({ type: 'run_error', content: { missingConnections: missing, status: 'error' } })
    expect(entry.content.error).toBeUndefined()
  })
})

describe('executeRun — stream failure mapping', () => {
  it('records an error outcome when the stream throws', async () => {
    nextSession = new FakeSession({ throwOnStream: new Error('transport exploded') })
    const store = makeStore()
    const emitEntry = vi.fn()
    const result = await executeRun({
      app: makeApp(),
      trigger: baseTrigger,
      store,
      memory: makeMemory(),
      emitEntry,
    })

    expect(result.outcome).toBe('error')
    expect(result.errorMessage).toContain('transport exploded')
    expect(store.completeRun).toHaveBeenCalledWith(
      result.runId,
      expect.objectContaining({ status: 'error' }),
    )
    // Session still closed in finally.
    expect(nextSession.close).toHaveBeenCalledTimes(1)
  })
})

describe('executeRun — onRunStarted lifecycle hook', () => {
  it('fires onRunStarted once and swallows its errors', async () => {
    nextSession = new FakeSession({ script: [assistantReport()] })
    const onRunStarted = vi.fn(() => {
      throw new Error('subscriber blew up')
    })
    await expect(
      executeRun({
        app: makeApp(),
        trigger: baseTrigger,
        store: makeStore(),
        memory: makeMemory(),
        onRunStarted,
      }),
    ).resolves.toBeDefined()
    expect(onRunStarted).toHaveBeenCalledTimes(1)
  })
})

describe('executeRun — MCP wiring', () => {
  beforeEach(() => {
    // File-wide default (see the sdk-config mock above); reasserted here so
    // this block's own override in the first test cannot leak into others.
    vi.mocked(getMcpServersForRequires).mockReturnValue({})
  })

  it('passes an app-declared MCP dependency through to the SDK session', async () => {
    const fakeMcpServer = { name: 'weather-mcp', _isMcpServer: true }
    vi.mocked(getMcpServersForRequires).mockReturnValue({ 'weather-mcp': fakeMcpServer })

    nextSession = new FakeSession({ script: [assistantReport()] })
    await executeRun({
      app: makeApp({
        spec: {
          type: 'automation',
          name: 'Test App',
          config_schema: [],
          permissions: [],
          requires: { mcps: ['weather-mcp'] },
        },
      }),
      trigger: baseTrigger,
      store: makeStore(),
      memory: makeMemory(),
    })

    expect(getMcpServersForRequires).toHaveBeenCalledWith(['weather-mcp'], 'space-1')
    const sdkOptions = vi.mocked(createSession).mock.calls[0][0] as { mcpServers: Record<string, unknown> }
    expect(sdkOptions.mcpServers).toEqual(expect.objectContaining({ 'weather-mcp': fakeMcpServer }))
  })

  it('still wires the built-in report and notification tools when the app declares no MCP requirement', async () => {
    nextSession = new FakeSession({ script: [assistantReport()] })
    await executeRun({
      app: makeApp(),
      trigger: baseTrigger,
      store: makeStore(),
      memory: makeMemory(),
    })

    const sdkOptions = vi.mocked(createSession).mock.calls[0][0] as { mcpServers: Record<string, unknown> }
    expect(Object.keys(sdkOptions.mcpServers)).toEqual(
      expect.arrayContaining(['halo-report', 'halo-notify', 'web-search', 'ocr'])
    )
  })
})

describe('executeRun — memory', () => {
  beforeEach(() => {
    vi.mocked(prepareMemoryForTurn).mockClear()
    vi.mocked(loadSpaceTopicsForTurn).mockClear()
    vi.mocked(appMemorySettings).mockReturnValue({ enabled: true, autoConsolidate: true, cadence: 'diligent' })
  })

  it('opens a fresh run with one signed heading and puts paths and authorship in the standing prompt', async () => {
    nextSession = new FakeSession({ script: [assistantReport()] })
    const memory = makeMemory()
    const result = await executeRun({ app: makeApp(), trigger: baseTrigger, store: makeStore(), memory })
    const authorTag = `schedule#${result.runId.replace(/-/g, '').slice(0, 4)}`
    expect(prepareMemoryForTurn).toHaveBeenCalledTimes(1)
    expect(prepareMemoryForTurn).toHaveBeenCalledWith(expect.any(Object), { byLabel: authorTag })
    expect(memory.getPromptInstructions).toHaveBeenCalledWith('run', expect.objectContaining({ authorTag, layout: expect.any(Object) }))
    expect(vi.mocked(buildAppSystemPrompt).mock.calls.at(-1)?.[0].memoryInstructions).toContain(authorTag)
    expect(vi.mocked(buildInitialMessage).mock.calls.at(-1)?.[0]).not.toHaveProperty('liveInstances')
    expect(vi.mocked(buildUserSessionSdkOptions).mock.calls.at(-1)?.[0].mcpServers).not.toHaveProperty('halo-memory')
  })

  it.each(['continue_followup', 'escalation_followup'] as const)('%s keeps the original run author and does not insert another heading', async type => {
    nextSession = new FakeSession({ script: [assistantReport()] })
    vi.mocked(acquireV2Session).mockResolvedValueOnce(managedLease(nextSession))
    const store = makeStore()
    store.getRun.mockReturnValue({
      triggerType: 'schedule', environment: { spaceId: 'space-1', spacePath: '/tmp/space-1', workDir: '/tmp/space-1', memoryDir: '/tmp/app-1' },
    })
    const memory = makeMemory()
    const trigger = type === 'continue_followup'
      ? { type, description: 'Continue', continue: { sessionId: 'saved-sdk-session', userMessage: 'continue' } }
      : { type, description: 'Answer', escalation: { sessionId: 'saved-sdk-session', originalQuestion: 'Proceed?', userResponse: { ts: 1, text: 'yes' } } }
    const result = await executeRun({ app: makeApp(), trigger, store, memory, existingRunId: 'a1b2c3d4-0000-0000-0000-000000000000', existingSessionKey: 'original-thread' })
    expect(result.outcome).toBe('useful')
    expect(memory.getPromptInstructions).toHaveBeenCalledWith('run', expect.objectContaining({ authorTag: 'schedule#a1b2' }))
    expect(prepareMemoryForTurn).not.toHaveBeenCalled()
    expect(loadSpaceTopicsForTurn).not.toHaveBeenCalled()
    expect(nextSession.send.mock.calls.at(-1)?.[0]).not.toContain('## Memory')
  })

  it('with memory off builds no instructions, heading or snapshot', async () => {
    vi.mocked(appMemorySettings).mockReturnValueOnce({ enabled: false, autoConsolidate: true, cadence: 'diligent' })
    nextSession = new FakeSession({ script: [assistantReport()] })
    const memory = makeMemory()
    await executeRun({ app: makeApp(), trigger: baseTrigger, store: makeStore(), memory })
    expect(memory.getPromptInstructions).not.toHaveBeenCalled()
    expect(prepareMemoryForTurn).not.toHaveBeenCalled()
    expect(vi.mocked(buildInitialMessage).mock.calls.at(-1)?.[0].memorySnapshot).toBeNull()
    expect(vi.mocked(buildUserSessionSdkOptions).mock.calls.at(-1)?.[0].mcpServers).not.toHaveProperty('halo-memory')
  })

  it('records the run and requests consolidation after it, but never consolidates on the error path', async () => {
    vi.mocked(finalizeMemoryAfterTurn).mockClear()
    nextSession = new FakeSession({ script: [assistantReport()] })
    await executeRun({ app: makeApp(), trigger: baseTrigger, store: makeStore(), memory: makeMemory() })
    expect(finalizeMemoryAfterTurn).toHaveBeenCalledTimes(1)
    const [, , , inputs, opts] = vi.mocked(finalizeMemoryAfterTurn).mock.calls[0]
    expect(inputs.appName).toBe('Test App')
    expect(opts).toBeUndefined()

    vi.mocked(finalizeMemoryAfterTurn).mockClear()
    nextSession = new FakeSession({ throwOnStream: new Error('boom') } as any)
    await executeRun({ app: makeApp(), trigger: baseTrigger, store: makeStore(), memory: makeMemory() })
    const errorCall = vi.mocked(finalizeMemoryAfterTurn).mock.calls.at(-1)
    expect(errorCall?.[4]).toEqual({ saveSessionSummary: true, consolidate: false })
  })

  it('holds the run\'s file tools to its memory boundaries', async () => {
    nextSession = new FakeSession({ script: [assistantReport()] })
    vi.mocked(buildUserSessionSdkOptions).mockClear()
    await executeRun({ app: makeApp(), trigger: baseTrigger, store: makeStore(), memory: makeMemory() })
    const params = vi.mocked(buildUserSessionSdkOptions).mock.calls[0][0] as unknown as Record<string, unknown>
    expect(params.memoryGuard).toEqual({ writable: [], readOnly: [], label: 'test' })
  })
})

describe('executeRun — managed follow-up lifecycle', () => {
  beforeEach(() => {
    vi.mocked(createSessionState).mockClear()
    vi.mocked(registerActiveSession).mockClear()
    vi.mocked(unregisterActiveSession).mockClear()
    vi.mocked(closeV2Session).mockClear()
    closeManagedSession.mockClear()
    releaseManagedSession.mockClear()
  })

  it.each(['continue_followup', 'escalation_followup'] as const)(
    '%s stays active through streaming and auto-continue, then releases through the manager',
    async type => {
      let release!: () => void
      const held = new Promise<void>(resolve => { release = resolve })
      nextSession = new FakeSession()
      let cycle = 0
      vi.spyOn(nextSession, 'stream').mockImplementation(async function* () {
        cycle++
        expect(registerActiveSession).toHaveBeenCalledTimes(1)
        expect(unregisterActiveSession).not.toHaveBeenCalled()
        expect(releaseManagedSession).not.toHaveBeenCalled()
        expect(nextSession.close).not.toHaveBeenCalled()
        if (cycle === 1) await held
        else yield assistantReport()
      })
      vi.mocked(acquireV2Session).mockResolvedValueOnce(managedLease(nextSession))
      const store = makeStore()
      store.getRun.mockReturnValue({ environment: {
        spaceId: 'space-1', spacePath: '/tmp/space-1', workDir: '/tmp/space-1', memoryDir: '/tmp/app-1',
      } })
      const trigger = type === 'continue_followup'
        ? { type, description: 'Continue', continue: { sessionId: 'saved-session' } }
        : { type, description: 'Answer', escalation: {
            sessionId: 'saved-session', originalQuestion: 'Proceed?', userResponse: { ts: 1, text: 'yes' },
          } }
      const pending = executeRun({
        app: makeApp(), trigger, store, memory: makeMemory(),
        existingRunId: 'old-run', existingSessionKey: 'old-thread',
      })
      await vi.waitFor(() => expect(nextSession.send).toHaveBeenCalledTimes(1))
      expect(createSessionState).toHaveBeenCalledWith('space-1', 'old-thread', expect.any(AbortController))
      expect(registerActiveSession).toHaveBeenCalledWith('old-thread', expect.objectContaining({
        spaceId: 'space-1', conversationId: 'old-thread', abortController: expect.any(AbortController),
      }))
      expect(nextSession.close).not.toHaveBeenCalled()
      release()
      expect((await pending).outcome).toBe('useful')
      expect(cycle).toBe(2)
      expect(closeManagedSession).toHaveBeenCalledTimes(1)
      expect(releaseManagedSession).toHaveBeenCalledTimes(1)
      expect(closeV2Session).not.toHaveBeenCalled()
      expect(unregisterActiveSession).toHaveBeenCalledTimes(1)
      expect(unregisterActiveSession).toHaveBeenCalledWith('old-thread')
      expect(nextSession.close).toHaveBeenCalledTimes(1)
      expect(closeManagedSession.mock.invocationCallOrder[0]).toBeLessThan(
        releaseManagedSession.mock.invocationCallOrder[0],
      )
      expect(releaseManagedSession.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(unregisterActiveSession).mock.invocationCallOrder[0],
      )
    },
  )

  it.each(['stream-error', 'abort'] as const)('releases an active follow-up after %s', async outcome => {
    const abort = new AbortController()
    nextSession = new FakeSession({
      throwOnStream: outcome === 'stream-error' ? new Error('stream failed') : undefined,
      script: [assistantReport()],
    })
    vi.mocked(acquireV2Session).mockResolvedValueOnce(managedLease(nextSession))
    if (outcome === 'abort') abort.abort()
    const store = makeStore()
    store.getRun.mockReturnValue({ environment: {
      spaceId: 'space-1', spacePath: '/tmp/space-1', workDir: '/tmp/space-1', memoryDir: '/tmp/app-1',
    } })
    await executeRun({
      app: makeApp(), trigger: { type: 'continue_followup', description: 'Continue', continue: { sessionId: 'saved-session' } },
      store, memory: makeMemory(), abortSignal: abort.signal,
      existingRunId: 'old-run', existingSessionKey: 'old-thread',
    })
    expect(registerActiveSession).toHaveBeenCalledTimes(1)
    expect(closeManagedSession).toHaveBeenCalledTimes(1)
    expect(releaseManagedSession).toHaveBeenCalledTimes(1)
    expect(closeV2Session).not.toHaveBeenCalled()
    expect(unregisterActiveSession).toHaveBeenCalledTimes(1)
    expect(unregisterActiveSession).toHaveBeenCalledWith('old-thread')
    expect(nextSession.close).toHaveBeenCalledTimes(1)
  })

  it('stops a continued run through its lease and records it as stopped', async () => {
    const session = new SilentSession()
    nextSession = session as unknown as FakeSession
    vi.mocked(acquireV2Session).mockResolvedValueOnce(managedLease(nextSession))
    const store = makeStore()
    store.getRun.mockReturnValue({ environment: {
      spaceId: 'space-1', spacePath: '/tmp/space-1', workDir: '/tmp/space-1', memoryDir: '/tmp/app-1',
    } })
    const controller = new AbortController()
    const running = executeRun({
      app: makeApp(), trigger: { type: 'continue_followup', description: 'Continue', continue: { sessionId: 'saved-session' } },
      store, memory: makeMemory(), abortSignal: controller.signal,
      existingRunId: 'old-run', existingSessionKey: 'old-thread',
    })
    await vi.waitFor(() => expect(session.send).toHaveBeenCalled())
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    try {
      controller.abort()
      await vi.advanceTimersByTimeAsync(ENGINE_STOP_GRACE_MS)
      const result = await running

      expect(session.interrupt).toHaveBeenCalledTimes(1)
      // Closed once, through the manager, never behind its back.
      expect(closeManagedSession).toHaveBeenCalledTimes(1)
      expect(session.close).toHaveBeenCalledTimes(1)
      expect(releaseManagedSession).toHaveBeenCalledTimes(1)
      expect(unregisterActiveSession).toHaveBeenCalledWith('old-thread')
      expect(result.errorMessage).toBe('Stopped before reporting results')
      expect(store.completeRun).toHaveBeenCalledWith('old-run', expect.objectContaining({
        status: 'error', errorMessage: 'Stopped before reporting results',
      }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps fresh transient runs outside the managed-session registry', async () => {
    nextSession = new FakeSession({ script: [assistantReport()] })
    await executeRun({ app: makeApp(), trigger: baseTrigger, store: makeStore(), memory: makeMemory() })
    expect(registerActiveSession).not.toHaveBeenCalled()
    expect(unregisterActiveSession).not.toHaveBeenCalled()
    expect(closeV2Session).not.toHaveBeenCalled()
    expect(closeManagedSession).not.toHaveBeenCalled()
    expect(releaseManagedSession).not.toHaveBeenCalled()
    expect(nextSession.close).toHaveBeenCalledTimes(1)
  })
})

describe('executeRun — original continuation context', () => {
  it('refuses to infer an unpinned old execution environment from the current default', async () => {
    vi.mocked(resolveExecutionEnvironment).mockClear()
    vi.mocked(createSession).mockClear()
    await expect(executeRun({
      app: makeApp({ spaceId: 'new-space' }), store: makeStore(), memory: makeMemory(),
      existingRunId: 'old-run', existingSessionKey: 'old-thread',
      trigger: { type: 'continue_followup', description: 'Continue', continue: { sessionId: 'old-engine' } },
    })).rejects.toThrow('original execution environment is unavailable')
    expect(resolveExecutionEnvironment).not.toHaveBeenCalled()
    expect(createSession).not.toHaveBeenCalled()
  })

  it('fails a continuation without an original engine session instead of starting fresh', async () => {
    vi.mocked(createSession).mockClear()
    vi.mocked(acquireV2Session).mockClear()
    const store = makeStore()
    store.getRun.mockReturnValue({ environment: { spaceId: 'space-1', spacePath: '/tmp/space-1', workDir: '/tmp/space-1', memoryDir: '/tmp/app-1' } })
    const result = await executeRun({
      app: makeApp(), store, memory: makeMemory(), existingRunId: 'old-run', existingSessionKey: 'old-thread',
      trigger: { type: 'continue_followup', description: 'Continue interrupted work', continue: {} },
    })
    expect(result.outcome).toBe('error')
    expect(result.errorMessage).toContain('original execution context is unavailable')
    expect(createSession).not.toHaveBeenCalled()
    expect(acquireV2Session).not.toHaveBeenCalled()
    expect(store.insertRun).not.toHaveBeenCalled()
  })

  it('restores the original engine session and storage despite a changed default space', async () => {
    vi.mocked(createSession).mockClear()
    vi.mocked(acquireV2Session).mockClear()
    vi.mocked(resolveExecutionEnvironment).mockClear()
    vi.mocked(openSessionWriter).mockClear()
    nextSession = new FakeSession({ script: [assistantReport()] })
    vi.mocked(acquireV2Session).mockResolvedValueOnce(managedLease(nextSession))
    const store = makeStore()
    const directory = mkdtempSync(join(tmpdir(), 'halo-execute-context-'))
    const environment = { spaceId: 'old-space', spacePath: join(directory, 'storage'), workDir: join(directory, 'work'), memoryDir: join(directory, 'memory') }
    store.getRun.mockReturnValue({ runId: 'old-run', sessionKey: 'old-thread', sessionId: 'old-engine', environment })
    const result = await executeRun({
      app: makeApp({ spaceId: 'new-space' }), store, memory: makeMemory(),
      existingRunId: 'old-run', existingSessionKey: 'old-thread',
      trigger: { type: 'escalation_followup', description: 'Answer received', escalation: {
        sessionId: 'old-engine', originalQuestion: 'Proceed?', userResponse: { ts: 1, text: 'Approved' },
      } },
    })
    expect(result.outcome).toBe('useful')
    expect(result.runId).toBe('old-run')
    expect(result.sessionKey).toBe('old-thread')
    expect(acquireV2Session).toHaveBeenCalledWith('old-space', 'old-thread', expect.any(Object), 'old-engine', environment.workDir)
    expect(createSession).not.toHaveBeenCalled()
    expect(resolveExecutionEnvironment).not.toHaveBeenCalled()
    expect(store.insertRun).not.toHaveBeenCalled()
    expect(openSessionWriter).toHaveBeenCalledWith(environment.spacePath, 'app-1', 'old-run')
    rmSync(directory, { recursive: true, force: true })
  })
})
