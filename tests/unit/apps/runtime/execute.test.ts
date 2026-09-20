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
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// The raw compaction path dynamic-imports @anthropic-ai/sdk; mock it so the
// API-key-path test can observe which client was (not) constructed.
const anthropicCreateMock = vi.fn()
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: anthropicCreateMock }
  },
}))

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
  buildBaseSdkOptions: vi.fn((opts: { mcpServers?: Record<string, unknown> }) => ({
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
}))
vi.mock('../../../../src/main/apps/runtime/person-context-tool', () => ({
  createPersonContextMcpServer: vi.fn(() => ({ name: 'halo-person-context' })),
  personContextPrompt: vi.fn(() => ''),
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
  getOrCreateV2Session: vi.fn(),
}))

// The fake session used by createSession — swapped per test via nextSession.
let nextSession: FakeSession
vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({
  createSession: vi.fn(async () => nextSession),
  query: vi.fn(),
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

vi.mock('../../../../src/main/apps/runtime/live-instances', () => ({
  describeSelfInstance: vi.fn(() => ({ id: 'aaaabbbb', kind: 'run', origin: 'schedule', startedAt: 0 })),
  listLiveInstances: vi.fn(() => []),
  formatInstanceTag: vi.fn(() => 'schedule#aaaa'),
}))

// Keep prompt building cheap and side-effect-free.
vi.mock('../../../../src/main/apps/runtime/prompt', () => ({
  buildAppSystemPrompt: vi.fn().mockReturnValue('SYSTEM PROMPT'),
  buildInitialMessage: vi.fn().mockReturnValue('INITIAL MESSAGE'),
  buildEscalationResumeMessage: vi.fn().mockReturnValue('ESCALATION RESUME'),
}))

import { executeRun } from '../../../../src/main/apps/runtime/execute'
import { providerRequiresFirstPartyClient } from '../../../../src/main/apps/runtime/turn/memory-lifecycle'
import { RunExecutionError } from '../../../../src/main/apps/runtime/errors'
import { query as agentSdkQuery, createSession } from '../../../../src/main/services/agent/resolved-sdk'
import { getApiCredentials, getMcpServersForRequires } from '../../../../src/main/services/agent/helpers'
import { resolveCredentialsForSdk } from '../../../../src/main/services/agent/sdk-config'
import { getOrCreateV2Session } from '../../../../src/main/services/agent/session-manager'
import { resolveExecutionEnvironment } from '../../../../src/main/apps/runtime/execution-environment'
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

/** Compaction output shape that passes isValidCompaction. */
const LLM_COMPACTED_SUMMARY =
  '# now\n\n## State | compacted via one-shot query\n\n# History\n\n## 2026-08-30-1100 | compacted\n'

/** Memory fake with needsCompaction=true so a successful run reaches the compaction fork. */
function makeCompactionMemory() {
  return {
    getPromptInstructions: vi.fn().mockReturnValue(''),
    saveSessionSummary: vi.fn().mockResolvedValue(undefined),
    needsCompaction: vi.fn().mockResolvedValue(true),
    read: vi.fn().mockResolvedValue(
      '# now\n\n## State | large memory\n\n# History\n\n## 2026-08-29-0900 | older entry\n',
    ),
    compact: vi.fn().mockResolvedValue('memory/2026-08-30-1000.md'),
  } as any
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

describe('executeRun — compaction provider routing (#121)', () => {
  // Only Claude locks its OAuth tokens to first-party clients (api.anthropic.com
  // 403s bare @anthropic-ai/sdk calls), so ONLY Claude OAuth takes the agent-SDK
  // subprocess fork. Copilot/智谱 OAuth are safe on the raw SDK path because
  // generateCompactionViaRawSdk → resolveCredentialsForSdk routes provider!=='anthropic'
  // through the local OpenAI-compat router with an encoded BackendConfig — the
  // exact same session-assembly path their normal chat turns use (session
  // config / mcp-manager / codex options). Their endpoints (GitHub Copilot,
  // open.bigmodel.cn) have no first-party lock. Delegated sources join the
  // Claude OAuth fork: they hold no key, so the CLI subprocess is their only
  // credential carrier.

  beforeEach(() => {
    vi.mocked(getApiCredentials).mockReset()
    vi.mocked(getApiCredentials).mockResolvedValue({
      baseUrl: 'https://api.test.com',
      apiKey: 'test-key',
      model: 'test-model',
      provider: 'anthropic',
    } as any)
    vi.mocked(resolveCredentialsForSdk).mockReset()
    vi.mocked(resolveCredentialsForSdk).mockResolvedValue({
      anthropicBaseUrl: 'https://api.test.com',
      anthropicApiKey: 'test-key',
      sdkModel: 'test-model',
      displayModel: 'Test Model',
    })
    vi.mocked(agentSdkQuery).mockReset()
    anthropicCreateMock.mockReset()
  })

  it('routes Claude OAuth through a one-shot agent SDK query', async () => {
    vi.mocked(getApiCredentials).mockResolvedValue({
      provider: 'oauth',
      oauthProvider: 'claude',
      apiKey: '',
      baseUrl: '',
      model: 'claude-oauth-model',
    } as any)
    vi.mocked(agentSdkQuery).mockImplementationOnce((() =>
      (async function* () {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: LLM_COMPACTED_SUMMARY }] },
        }
        yield { type: 'result', result: LLM_COMPACTED_SUMMARY }
      })()) as any)

    nextSession = new FakeSession({ script: [assistantReport()] })
    const memory = makeCompactionMemory()
    await executeRun({
      app: makeApp(),
      trigger: baseTrigger,
      store: makeStore(),
      memory,
    })

    // Fork taken: one-shot query, never the raw @anthropic-ai/sdk client.
    expect(agentSdkQuery).toHaveBeenCalledTimes(1)
    expect(anthropicCreateMock).not.toHaveBeenCalled()

    const arg = vi.mocked(agentSdkQuery).mock.calls[0][0] as any
    expect(arg.options.maxTurns).toBe(1)
    expect(arg.options.model).toBe('test-model')
    // Credentials ride in env (same as session assembly), not options.apiKey.
    expect(arg.options.apiKey).toBeUndefined()
    expect(arg.options.env.ANTHROPIC_API_KEY).toBe('test-key')
    expect(arg.options.anthropicBaseUrl).toBe('https://api.test.com')
    expect(arg.prompt).toContain('compacting the memory file')

    // LLM summary written as the new memory.md, not the system fallback.
    expect(memory.compact).toHaveBeenCalledWith(
      expect.anything(),
      'app',
      expect.not.stringContaining('Compacted by system'),
    )
    expect(memory.compact.mock.calls[0][2]).toContain('## State | compacted via one-shot query')
  })

  it('routes delegated sources through the agent SDK query with the routing header', async () => {
    vi.mocked(getApiCredentials).mockResolvedValue({
      provider: 'oauth',
      delegatedAuth: true,
      apiKey: '',
      baseUrl: '',
      model: 'claude-cli-model',
    } as any)
    vi.mocked(resolveCredentialsForSdk).mockResolvedValue({
      anthropicBaseUrl: 'http://127.0.0.1:60098',
      anthropicApiKey: '',
      sdkModel: 'test-model',
      displayModel: 'Test Model',
      delegatedRoutingHeader: 'x-halo-backend: encoded-config',
    } as any)
    vi.mocked(agentSdkQuery).mockImplementationOnce((() =>
      (async function* () {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: LLM_COMPACTED_SUMMARY }] },
        }
        yield { type: 'result', result: LLM_COMPACTED_SUMMARY }
      })()) as any)

    nextSession = new FakeSession({ script: [assistantReport()] })
    const memory = makeCompactionMemory()
    await executeRun({
      app: makeApp(),
      trigger: baseTrigger,
      store: makeStore(),
      memory,
    })

    // Fork taken for delegated: never the keyless raw SDK client.
    expect(agentSdkQuery).toHaveBeenCalledTimes(1)
    expect(anthropicCreateMock).not.toHaveBeenCalled()

    const arg = vi.mocked(agentSdkQuery).mock.calls[0][0] as any
    // buildSdkEnv auth-channel rule (stubbed here; real invariants pinned in
    // delegated-auth.test.ts): backend identity on the custom header, no API
    // key near the subprocess.
    expect(arg.options.env.ANTHROPIC_CUSTOM_HEADERS).toBe('x-halo-backend: encoded-config')
    expect(arg.options.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(memory.compact.mock.calls[0][2]).toContain('## State | compacted via one-shot query')
  })

  it('keeps API-key providers on the raw @anthropic-ai/sdk path', async () => {
    anthropicCreateMock.mockResolvedValue({
      content: [{ type: 'text', text: LLM_COMPACTED_SUMMARY }],
    })

    nextSession = new FakeSession({ script: [assistantReport()] })
    const memory = makeCompactionMemory()
    await executeRun({
      app: makeApp(),
      trigger: baseTrigger,
      store: makeStore(),
      memory,
    })

    expect(agentSdkQuery).not.toHaveBeenCalled()
    expect(anthropicCreateMock).toHaveBeenCalledTimes(1)
    expect(memory.compact.mock.calls[0][2]).toContain('## State | compacted via one-shot query')
  })

  it('falls back to the system summary when the agent SDK query yields nothing', async () => {
    vi.mocked(getApiCredentials).mockResolvedValue({
      provider: 'oauth',
      oauthProvider: 'claude',
    } as any)
    vi.mocked(agentSdkQuery).mockImplementationOnce((() =>
      (async function* () {
        // Stream ends with no assistant text and no result.
      })()) as any)

    nextSession = new FakeSession({ script: [assistantReport()] })
    const memory = makeCompactionMemory()
    await executeRun({
      app: makeApp(),
      trigger: baseTrigger,
      store: makeStore(),
      memory,
    })

    expect(agentSdkQuery).toHaveBeenCalledTimes(1)
    expect(memory.compact.mock.calls[0][2]).toContain('Compacted by system')
  })

  it.each([
    ['github-copilot', 'copilot-oauth-model'],
    ['zhipu-coding-oauth', 'zhipu-oauth-model'],
  ] as const)(
    'keeps %s OAuth on the raw @anthropic-ai/sdk path (router, not subprocess)',
    async (oauthProvider, model) => {
      // Raw SDK here is NOT a bare upstream call: resolveCredentialsForSdk sees
      // provider!=='anthropic' and routes through the local OpenAI-compat
      // router (encoded BackendConfig) — the same path as normal chat turns.
      anthropicCreateMock.mockResolvedValue({
        content: [{ type: 'text', text: LLM_COMPACTED_SUMMARY }],
      })

      vi.mocked(getApiCredentials).mockResolvedValue({
        provider: 'oauth',
        oauthProvider,
        apiKey: 'oauth-token',
        baseUrl: 'https://api.test.com',
        model,
      } as any)

      nextSession = new FakeSession({ script: [assistantReport()] })
      const memory = makeCompactionMemory()
      await executeRun({
        app: makeApp(),
        trigger: baseTrigger,
        store: makeStore(),
        memory,
      })

      expect(agentSdkQuery).not.toHaveBeenCalled()
      expect(anthropicCreateMock).toHaveBeenCalledTimes(1)
      expect(memory.compact.mock.calls[0][2]).toContain('## State | compacted via one-shot query')
    },
  )
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

  it('still wires the built-in report/notify/memory MCP tools when the app declares no MCP requirement', async () => {
    nextSession = new FakeSession({ script: [assistantReport()] })
    await executeRun({
      app: makeApp(),
      trigger: baseTrigger,
      store: makeStore(),
      memory: makeMemory(),
    })

    const sdkOptions = vi.mocked(createSession).mock.calls[0][0] as { mcpServers: Record<string, unknown> }
    expect(Object.keys(sdkOptions.mcpServers)).toEqual(
      expect.arrayContaining(['halo-memory', 'halo-report', 'halo-notify', 'web-search', 'ocr'])
    )
  })
})

describe('providerRequiresFirstPartyClient', () => {
  it('sends delegated sources to the first-party bucket regardless of provider id', () => {
    expect(providerRequiresFirstPartyClient('oauth', undefined, true)).toBe(true)
    expect(providerRequiresFirstPartyClient('oauth', 'claude-cli', true)).toBe(true)
  })

  it('keeps the Claude OAuth lock and the raw-SDK default for the rest', () => {
    expect(providerRequiresFirstPartyClient('oauth', 'claude')).toBe(true)
    expect(providerRequiresFirstPartyClient('oauth', 'github-copilot')).toBe(false)
    expect(providerRequiresFirstPartyClient('anthropic')).toBe(false)
    expect(providerRequiresFirstPartyClient('openai')).toBe(false)
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
    vi.mocked(getOrCreateV2Session).mockClear()
    const store = makeStore()
    store.getRun.mockReturnValue({ environment: { spaceId: 'space-1', spacePath: '/tmp/space-1', workDir: '/tmp/space-1', memoryDir: '/tmp/app-1' } })
    const result = await executeRun({
      app: makeApp(), store, memory: makeMemory(), existingRunId: 'old-run', existingSessionKey: 'old-thread',
      trigger: { type: 'continue_followup', description: 'Continue interrupted work', continue: {} },
    })
    expect(result.outcome).toBe('error')
    expect(result.errorMessage).toContain('original execution context is unavailable')
    expect(createSession).not.toHaveBeenCalled()
    expect(getOrCreateV2Session).not.toHaveBeenCalled()
    expect(store.insertRun).not.toHaveBeenCalled()
  })

  it('restores the original engine session and storage despite a changed default space', async () => {
    vi.mocked(createSession).mockClear()
    vi.mocked(getOrCreateV2Session).mockClear()
    vi.mocked(resolveExecutionEnvironment).mockClear()
    vi.mocked(openSessionWriter).mockClear()
    nextSession = new FakeSession({ script: [assistantReport()] })
    vi.mocked(getOrCreateV2Session).mockResolvedValueOnce(nextSession as any)
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
    expect(getOrCreateV2Session).toHaveBeenCalledWith('old-space', 'old-thread', expect.any(Object), 'old-engine', environment.workDir)
    expect(createSession).not.toHaveBeenCalled()
    expect(resolveExecutionEnvironment).not.toHaveBeenCalled()
    expect(store.insertRun).not.toHaveBeenCalled()
    expect(openSessionWriter).toHaveBeenCalledWith(environment.spacePath, 'app-1', 'old-run')
    rmSync(directory, { recursive: true, force: true })
  })
})
