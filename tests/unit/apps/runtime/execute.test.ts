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
 *   - stream throws → mapped to error outcome with errorMessage recorded
 *
 * We assert on the returned AppRunResult and on store.completeRun, which is the
 * observable contract of the branch decisions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

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
  buildBaseSdkOptions: vi.fn().mockReturnValue({
    model: 'test-model',
    cwd: '/tmp/test',
    maxTurns: 999,
    systemPrompt: '',
    mcpServers: {},
  }),
}))

vi.mock('../../../../src/main/foundation/config.service', () => ({
  getConfig: vi.fn().mockReturnValue({ agent: {}, notificationChannels: {} }),
  resolveClaudeConfigDir: vi.fn().mockReturnValue('/tmp/cc-config'),
}))

vi.mock('../../../../src/main/services/space.service', () => ({
  getSpace: vi.fn().mockReturnValue({ id: 'space-1', path: '/tmp/space-1' }),
  getSpaceDir: vi.fn().mockReturnValue('/tmp/space-1'),
}))

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

vi.mock('../../../../src/main/services/email-mcp', () => ({
  createEmailMcpServer: vi.fn().mockReturnValue(null),
}))

vi.mock('../../../../src/main/services/agent/session-manager', () => ({
  getOrCreateV2Session: vi.fn(),
}))

// The fake session used by createSession — swapped per test via nextSession.
let nextSession: FakeSession
vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({
  createSession: vi.fn(async () => nextSession),
}))

vi.mock('../../../../src/main/platform/memory/snapshot', () => ({
  buildMemorySnapshot: vi.fn().mockResolvedValue({
    exists: false,
    totalLines: 0,
    sizeBytes: 0,
    headers: [],
    archiveTotalCount: 0,
    memoryFilePath: '/tmp/space-1/memory.md',
    rawContent: null,
  }),
  createMemoryStatusMcpServer: vi.fn().mockReturnValue({ name: 'halo-memory', _isMcpServer: true }),
}))

vi.mock('../../../../src/main/apps/runtime/report-tool', () => ({
  createReportToolServer: vi.fn().mockReturnValue({ name: 'halo-report', _isMcpServer: true }),
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
}))

// Keep prompt building cheap and side-effect-free.
vi.mock('../../../../src/main/apps/runtime/prompt', () => ({
  buildAppSystemPrompt: vi.fn().mockReturnValue('SYSTEM PROMPT'),
  buildInitialMessage: vi.fn().mockReturnValue('INITIAL MESSAGE'),
  buildEscalationResumeMessage: vi.fn().mockReturnValue('ESCALATION RESUME'),
}))

import { executeRun } from '../../../../src/main/apps/runtime/execute'
import { RunExecutionError } from '../../../../src/main/apps/runtime/errors'

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
  /** How many times stream() has been consumed (each auto-continue re-streams). */
  streamCalls = 0

  constructor(opts: { script?: SdkMessage[]; throwOnStream?: Error | null } = {}) {
    this.script = opts.script ?? []
    this.throwOnStream = opts.throwOnStream ?? null
  }

  stream(): AsyncGenerator<SdkMessage> {
    this.streamCalls++
    const script = this.streamCalls === 1 ? this.script : []
    const throwOnStream = this.throwOnStream
    return (async function* () {
      if (throwOnStream) throw throwOnStream
      for (const m of script) yield m
    })()
  }
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
    insertRun: vi.fn(),
    completeRun: vi.fn(),
    updateRunSessionId: vi.fn(),
    insertEntry: vi.fn(),
  } as any
}

function makeMemory() {
  return {
    getPromptInstructions: vi.fn().mockReturnValue(''),
    saveSessionSummary: vi.fn().mockResolvedValue(undefined),
    needsCompaction: vi.fn().mockResolvedValue(false),
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
      script: [assistantReport(), { type: 'result', is_error: true }],
    })
    const store = makeStore()
    const result = await executeRun({
      app: makeApp(),
      trigger: baseTrigger,
      store,
      memory: makeMemory(),
    })
    expect(result.outcome).toBe('error')
    expect(store.completeRun).toHaveBeenCalledWith(
      result.runId,
      expect.objectContaining({ status: 'error' }),
    )
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
    // 1 initial stream + MAX_AUTO_CONTINUES (10) retries = 11 stream cycles.
    expect(nextSession.streamCalls).toBe(11)
    // A run_error activity entry is surfaced for the no-report case.
    expect(emitEntry).toHaveBeenCalled()
  })
})

describe('executeRun — abort handling', () => {
  it('short-circuits the auto-continue loop when aborted', async () => {
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

    // Aborted before dispatch: the stream loop breaks immediately and the
    // auto-continue while-loop never iterates (its guard checks aborted).
    expect(nextSession.streamCalls).toBe(1)
    expect(result.outcome).toBe('error')
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
