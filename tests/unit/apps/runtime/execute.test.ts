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

import {
  executeRun,
  providerRequiresFirstPartyClient
} from '../../../../src/main/apps/runtime/execute'
import { RunExecutionError } from '../../../../src/main/apps/runtime/errors'
import { query as agentSdkQuery } from '../../../../src/main/services/agent/resolved-sdk'
import { getApiCredentials } from '../../../../src/main/services/agent/helpers'
import { resolveCredentialsForSdk } from '../../../../src/main/services/agent/sdk-config'

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
    compact: vi.fn().mockResolvedValue({
      archived: 'memory/run/2026-08-30-1000-run.jsonl',
      needsSummary: true,
    }),
    write: vi.fn().mockResolvedValue(undefined),
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
    expect(memory.write).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        mode: 'replace',
        content: expect.not.stringContaining('Compacted by system'),
      }),
    )
    expect(memory.write.mock.calls[0][1].content).toContain('## State | compacted via one-shot query')
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
    expect(memory.write.mock.calls[0][1].content).toContain('## State | compacted via one-shot query')
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
    expect(memory.write.mock.calls[0][1].content).toContain('## State | compacted via one-shot query')
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
    expect(memory.write.mock.calls[0][1].content).toContain('Compacted by system')
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
      expect(memory.write.mock.calls[0][1].content).toContain('## State | compacted via one-shot query')
    },
  )
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
