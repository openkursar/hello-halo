/**
 * handleMessagesRequest tests. Covers the three-way dispatch (anthropic
 * passthrough / kiro / OpenAI conversion), the interceptor short-circuit,
 * systemNormalized flag propagation into raw-body reuse, the Anthropic
 * upstream header merge (anthropic-beta union+dedupe, content-type single
 * value, x-api-key skipped when Authorization is present), and upstream
 * error mapping (getUpstreamError formats + status mapping via sendError).
 *
 * Every leaf the handler dispatches to is mocked (kiro adapter, converters,
 * streams, interceptors, provider adapters, proxyFetch) so a single call
 * exercises exactly one path deterministically.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Response as ExpressResponse } from 'express'
import { CLAUDE_CODE_USER_AGENT } from '../../../src/main/openai-compat-router/utils/claude-code-identity'

const runInterceptors = vi.fn()
vi.mock('../../../src/main/openai-compat-router/interceptors', () => ({
  runInterceptors: (...a: unknown[]) => runInterceptors(...a),
}))

const handleKiroRequest = vi.fn()
vi.mock('../../../src/main/openai-compat-router/adapters/kiro.adapter', () => ({
  handleKiroRequest: (...a: unknown[]) => handleKiroRequest(...a),
}))

const convertAnthropicToOpenAIChat = vi.fn()
const convertAnthropicToOpenAIResponses = vi.fn()
const convertOpenAIChatToAnthropic = vi.fn()
const convertOpenAIResponsesToAnthropic = vi.fn()
const normalizeAnthropicReasoning = vi.fn((...[request]: unknown[]) => ({ request, modified: false }))
vi.mock('../../../src/main/openai-compat-router/converters', () => ({
  convertAnthropicToOpenAIChat: (...a: unknown[]) => convertAnthropicToOpenAIChat(...a),
  convertAnthropicToOpenAIResponses: (...a: unknown[]) => convertAnthropicToOpenAIResponses(...a),
  convertOpenAIChatToAnthropic: (...a: unknown[]) => convertOpenAIChatToAnthropic(...a),
  convertOpenAIResponsesToAnthropic: (...a: unknown[]) => convertOpenAIResponsesToAnthropic(...a),
}))

const streamOpenAIChatToAnthropic = vi.fn()
const streamOpenAIResponsesToAnthropic = vi.fn()
const streamAnthropicPassthrough = vi.fn()
const pipeAnthropicPassthrough = vi.fn()
vi.mock('../../../src/main/openai-compat-router/stream', async (importOriginal) => ({
  collectAnthropicMessage: (await importOriginal<typeof import('../../../src/main/openai-compat-router/stream')>()).collectAnthropicMessage,
  streamOpenAIChatToAnthropic: (...a: unknown[]) => streamOpenAIChatToAnthropic(...a),
  streamOpenAIResponsesToAnthropic: (...a: unknown[]) => streamOpenAIResponsesToAnthropic(...a),
  streamAnthropicPassthrough: (...a: unknown[]) => streamAnthropicPassthrough(...a),
  pipeAnthropicPassthrough: (...a: unknown[]) => pipeAnthropicPassthrough(...a),
}))

const proxyFetch = vi.fn()
vi.mock('../../../src/main/services/proxy-fetch', () => ({
  proxyFetch: (...a: unknown[]) => proxyFetch(...a),
}))

const applyProviderAdapter = vi.fn((..._args: unknown[]) => null)
vi.mock('../../../src/main/openai-compat-router/server/provider-adapters', () => ({
  applyProviderAdapter: (...a: unknown[]) => applyProviderAdapter(...a),
}))

// Run the queued fn inline so conversion-path assertions stay synchronous.
// api-type: real-ish behavior driven per test via mockReturnValue.
const getApiTypeFromUrl = vi.fn((..._args: unknown[]) => 'chat_completions')
const isValidEndpointUrl = vi.fn((..._args: unknown[]) => true)
const getEndpointUrlError = vi.fn((..._args: unknown[]) => 'bad url')
const shouldForceStream = vi.fn((..._args: unknown[]) => false)
vi.mock('../../../src/main/openai-compat-router/server/api-type', () => ({
  getApiTypeFromUrl: (...a: unknown[]) => getApiTypeFromUrl(...a),
  isValidEndpointUrl: (...a: unknown[]) => isValidEndpointUrl(...a),
  getEndpointUrlError: (...a: unknown[]) => getEndpointUrlError(...a),
  shouldForceStream: (...a: unknown[]) => shouldForceStream(...a),
}))

const isNativeAnthropicHost = vi.fn((..._args: unknown[]) => false)
const normalizeSystemPrompt = vi.fn((request: unknown, ..._args: unknown[]) => ({ request, modified: false }))
vi.mock('../../../src/main/openai-compat-router/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/openai-compat-router/utils')>()
  return {
    ...actual,
    isNativeAnthropicHost: (...a: unknown[]) => isNativeAnthropicHost(...a),
    normalizeSystemPrompt: (request: unknown, ...args: unknown[]) => normalizeSystemPrompt(request, ...args),
    normalizeAnthropicReasoning: (...a: unknown[]) => normalizeAnthropicReasoning(...a),
  }
})

vi.mock('../../../src/main/openai-compat-router/utils/token-counter', () => ({
  countTokens: vi.fn(() => 7),
}))

const fillResponseUsageFallback = vi.fn()
vi.mock('../../../src/main/openai-compat-router/utils/usage-estimator', () => ({
  deferInputTokensEstimate: vi.fn(() => async () => 0),
  fillResponseUsageFallback: (...a: unknown[]) => fillResponseUsageFallback(...a),
}))

import { handleMessagesRequest } from '../../../src/main/openai-compat-router/server/request-handler'

interface CapturedRes {
  statusCode: number
  headers: Record<string, string>
  jsonBody: unknown
  ended: string | undefined
  status: (n: number) => CapturedRes
  setHeader: (k: string, v: string) => void
  getHeader: (k: string) => string | undefined
  json: (b: unknown) => void
  end: (b?: string) => void
  on: (event: string, cb: () => void) => void
  emit: (event: string) => void
}

function makeRes(): CapturedRes {
  const listeners: Record<string, Array<() => void>> = {}
  const res: CapturedRes = {
    statusCode: 200,
    headers: {},
    jsonBody: undefined,
    ended: undefined,
    status(n) {
      this.statusCode = n
      return this
    },
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v
    },
    getHeader(k) {
      return this.headers[k.toLowerCase()]
    },
    json(b) {
      this.jsonBody = b
    },
    end(b) {
      this.ended = b
    },
    on(event, cb) {
      ;(listeners[event] ??= []).push(cb)
    },
    emit(event) {
      for (const cb of listeners[event] ?? []) cb()
    },
  }
  return res
}

/**
 * Minimal stand-in for a fetch Response. `headers` is a Map so both
 * forEach(value,key) and get() match the undici surface the handler uses.
 */
function fakeResponse(opts: {
  ok?: boolean
  status?: number
  headers?: Record<string, string>
  text?: string
  json?: unknown
  body?: unknown
}): globalThis.Response {
  const h = new Map(Object.entries(opts.headers ?? {}))
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    headers: {
      forEach: (cb: (v: string, k: string) => void) => h.forEach((v, k) => cb(v, k)),
      get: (k: string) => h.get(k.toLowerCase()) ?? null,
    },
    text: async () => opts.text ?? '',
    json: async () => opts.json ?? {},
    body: opts.body ?? null,
  } as unknown as globalThis.Response
}

function baseConfig(over: Record<string, unknown> = {}) {
  return {
    url: 'https://upstream.example/v1/chat/completions',
    key: 'sk-test',
    ...over,
  } as never
}

function anthReq(over: Record<string, unknown> = {}) {
  return {
    model: 'claude-3-opus',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hi' }],
    stream: false,
    ...over,
  } as never
}

beforeEach(() => {
  vi.clearAllMocks()
  runInterceptors.mockResolvedValue({ intercepted: false, request: anthReq() })
  normalizeSystemPrompt.mockImplementation((request: unknown) => ({ request, modified: false }))
  isValidEndpointUrl.mockReturnValue(true)
  getApiTypeFromUrl.mockReturnValue('chat_completions')
  shouldForceStream.mockReturnValue(false)
  isNativeAnthropicHost.mockReturnValue(false)
  applyProviderAdapter.mockReturnValue(null)
  convertAnthropicToOpenAIChat.mockReturnValue({ request: { model: 'x', messages: [] } })
  convertOpenAIChatToAnthropic.mockReturnValue({ type: 'message', content: [] })
})

describe('handleMessagesRequest dispatch', () => {
  it('routes anthropic_passthrough to the passthrough handler (proxyFetch, no conversion)', async () => {
    const req = anthReq()
    runInterceptors.mockResolvedValue({ intercepted: false, request: req })
    proxyFetch.mockResolvedValue(fakeResponse({ ok: true, text: '{"ok":true}' }))
    const res = makeRes()

    await handleMessagesRequest(
      req,
      baseConfig({ apiType: 'anthropic_passthrough', url: 'https://third-party/v1/messages' }),
      res as unknown as ExpressResponse,
    )

    expect(proxyFetch).toHaveBeenCalledTimes(1)
    expect(handleKiroRequest).not.toHaveBeenCalled()
    expect(convertAnthropicToOpenAIChat).not.toHaveBeenCalled()
  })

  it('routes kiro to the kiro adapter', async () => {
    const req = anthReq()
    runInterceptors.mockResolvedValue({ intercepted: false, request: req })
    const res = makeRes()

    await handleMessagesRequest(
      req,
      baseConfig({ apiType: 'kiro' }),
      res as unknown as ExpressResponse,
    )

    expect(handleKiroRequest).toHaveBeenCalledTimes(1)
    expect(proxyFetch).not.toHaveBeenCalled()
    expect(convertAnthropicToOpenAIChat).not.toHaveBeenCalled()
  })

  it('routes everything else through the OpenAI conversion pipeline', async () => {
    const req = anthReq()
    runInterceptors.mockResolvedValue({ intercepted: false, request: req })
    proxyFetch.mockResolvedValue(fakeResponse({ ok: true, json: { id: 'x' } }))
    const res = makeRes()

    await handleMessagesRequest(
      req,
      baseConfig({ apiType: 'chat_completions' }),
      res as unknown as ExpressResponse,
    )

    expect(convertAnthropicToOpenAIChat).toHaveBeenCalledTimes(1)
    expect(convertOpenAIChatToAnthropic).toHaveBeenCalledTimes(1)
    expect(handleKiroRequest).not.toHaveBeenCalled()
  })

  it('keeps account-scoped capabilities attached to both an initial Responses request and its retry', async () => {
    const capabilities = { reasoningSummary: false, responsesLite: true, reasoningLevels: ['low'] }
    convertAnthropicToOpenAIResponses.mockReturnValue({ request: { model: 'shared', input: [] } })
    proxyFetch.mockResolvedValueOnce(fakeResponse({ ok: false, status: 400, text: 'stream must be set to true' }))
      .mockResolvedValueOnce(fakeResponse({ ok: true, body: {} }))
    await handleMessagesRequest(anthReq(), baseConfig({
      apiType: 'responses', adapterId: 'openai-codex', codexModelCapabilities: capabilities
    }), makeRes() as unknown as ExpressResponse)
    expect(applyProviderAdapter).toHaveBeenCalledTimes(2)
    expect(applyProviderAdapter.mock.calls[0][4]).toMatchObject({ codexModelCapabilities: capabilities })
    expect(applyProviderAdapter.mock.calls[1][4]).toBe(applyProviderAdapter.mock.calls[0][4])
  })

  it('short-circuits when an interceptor already responded', async () => {
    runInterceptors.mockResolvedValue({ intercepted: true, responded: true })
    const res = makeRes()

    await handleMessagesRequest(
      anthReq(),
      baseConfig({ apiType: 'chat_completions' }),
      res as unknown as ExpressResponse,
    )

    expect(proxyFetch).not.toHaveBeenCalled()
    expect(handleKiroRequest).not.toHaveBeenCalled()
    expect(convertAnthropicToOpenAIChat).not.toHaveBeenCalled()
    expect(normalizeSystemPrompt).not.toHaveBeenCalled()
  })

  it('propagates systemNormalized: a normalized request cannot reuse rawBody', async () => {
    const req = anthReq()
    const normalized = anthReq({ system: 'clean' })
    runInterceptors.mockResolvedValue({ intercepted: false, request: req })
    normalizeSystemPrompt.mockReturnValue({ request: normalized, modified: true })
    proxyFetch.mockResolvedValue(fakeResponse({ ok: true, text: '{}' }))
    const res = makeRes()

    await handleMessagesRequest(
      req,
      baseConfig({ apiType: 'anthropic_passthrough', url: 'https://third-party/v1/messages' }),
      res as unknown as ExpressResponse,
      { rawBody: Buffer.from('RAW-BYTES') },
    )

    // requestModified=true forces JSON serialization of the normalized object
    // instead of forwarding the raw buffer byte-for-byte.
    const body = proxyFetch.mock.calls[0][1].body
    expect(Buffer.isBuffer(body)).toBe(false)
    expect(body).toBe(JSON.stringify(normalized))
  })

  it('forwards the reasoning-normalized request instead of the raw body', async () => {
    const req = anthReq()
    const reasoned = anthReq({ thinking: { type: 'adaptive' }, output_config: { effort: 'max' } })
    runInterceptors.mockResolvedValue({ intercepted: false, request: req })
    normalizeAnthropicReasoning.mockReturnValueOnce({ request: reasoned, modified: true })
    proxyFetch.mockResolvedValue(fakeResponse({ ok: true, text: '{}' }))
    const config = baseConfig({
      apiType: 'anthropic_passthrough',
      url: 'https://third-party/v1/messages',
      pickedReasoningEffort: 'max',
    })

    await handleMessagesRequest(req, config, makeRes() as unknown as ExpressResponse, { rawBody: Buffer.from('RAW-BYTES') })

    expect(normalizeAnthropicReasoning).toHaveBeenCalledWith(req, config)
    expect(proxyFetch.mock.calls[0][1].body).toBe(JSON.stringify(reasoned))
  })
})

describe('client disconnect propagation', () => {
  it('aborts the upstream fetch signal when the client closes mid-stream', async () => {
    const req = anthReq({ stream: true })
    runInterceptors.mockResolvedValue({ intercepted: false, request: req })
    proxyFetch.mockResolvedValue(fakeResponse({ ok: true, body: {} }))

    // Keep the SSE conversion in flight until the test releases it.
    let releaseStream!: () => void
    streamOpenAIChatToAnthropic.mockImplementation(
      () => new Promise<void>((resolve) => { releaseStream = resolve })
    )

    const res = makeRes()
    const done = handleMessagesRequest(
      req,
      baseConfig({ apiType: 'chat_completions' }),
      res as unknown as ExpressResponse,
    )
    // Let fetch resolve and streaming begin.
    await vi.waitFor(() => expect(streamOpenAIChatToAnthropic).toHaveBeenCalledTimes(1))

    const fetchSignal = proxyFetch.mock.calls[0][1].signal as AbortSignal
    expect(fetchSignal.aborted).toBe(false)

    res.emit('close')
    expect(fetchSignal.aborted).toBe(true)

    releaseStream()
    await done
    // clearAllMocks does not drop implementations — remove the pending-promise
    // impl so later tests get the default resolved stream.
    streamOpenAIChatToAnthropic.mockReset()
  })

  it('does not write an error response when the abort came from the client', async () => {
    const req = anthReq()
    runInterceptors.mockResolvedValue({ intercepted: false, request: req })
    proxyFetch.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          )
        })
    )

    const res = makeRes()
    const done = handleMessagesRequest(
      req,
      baseConfig({ apiType: 'chat_completions' }),
      res as unknown as ExpressResponse,
    )
    await vi.waitFor(() => expect(proxyFetch).toHaveBeenCalledTimes(1))

    res.emit('close')
    await done

    // Client is gone: no timeout_error / api_error must be written.
    expect(res.jsonBody).toBeUndefined()
    expect(res.statusCode).toBe(200)
  })
})

describe('anthropic passthrough header merge', () => {
  async function runPassthrough(opts: {
    sdkHeaders?: Record<string, string>
    customHeaders?: Record<string, string>
  }) {
    const req = anthReq()
    runInterceptors.mockResolvedValue({ intercepted: false, request: req })
    proxyFetch.mockResolvedValue(fakeResponse({ ok: true, text: '{}' }))
    const res = makeRes()
    await handleMessagesRequest(
      req,
      baseConfig({
        apiType: 'anthropic_passthrough',
        url: 'https://third-party/v1/messages',
        headers: opts.customHeaders,
      }),
      res as unknown as ExpressResponse,
      { sdkHeaders: opts.sdkHeaders },
    )
    return proxyFetch.mock.calls[0][1].headers as Record<string, string>
  }

  it('unions and dedupes anthropic-beta from SDK and provider', async () => {
    const headers = await runPassthrough({
      sdkHeaders: { 'anthropic-beta': 'context-management, shared' },
      customHeaders: { 'anthropic-beta': 'oauth, shared' },
    })
    expect(headers['anthropic-beta']).toBe('context-management, shared, oauth')
  })

  it('collapses content-type casing and gives provider headers precedence', async () => {
    const headers = await runPassthrough({
      sdkHeaders: { 'content-type': 'application/json' },
      customHeaders: { 'Content-Type': 'application/json; charset=utf-8' },
    })
    const ctKeys = Object.keys(headers).filter((k) => k.toLowerCase() === 'content-type')
    expect(ctKeys).toHaveLength(1)
    expect(headers[ctKeys[0]]).toBe('application/json; charset=utf-8')
  })

  it('overrides an older Claude Code user-agent with the compatibility identity', async () => {
    const headers = await runPassthrough({
      sdkHeaders: { 'User-Agent': 'claude-cli/2.1.89 (external, cli)' },
    })
    const userAgentKeys = Object.keys(headers).filter((k) => k.toLowerCase() === 'user-agent')
    expect(userAgentKeys).toHaveLength(1)
    expect(headers[userAgentKeys[0]]).toBe(CLAUDE_CODE_USER_AGENT)
  })

  it('gives a provider-owned user-agent precedence over the SDK identity', async () => {
    const headers = await runPassthrough({
      sdkHeaders: { 'user-agent': 'claude-cli/2.1.89 (external, cli)' },
      customHeaders: { 'User-Agent': 'GitHubCopilotChat/0.39.1' },
    })
    const userAgentKeys = Object.keys(headers).filter((k) => k.toLowerCase() === 'user-agent')
    expect(userAgentKeys).toHaveLength(1)
    expect(headers[userAgentKeys[0]]).toBe('GitHubCopilotChat/0.39.1')
  })

  it('injects the Claude Code compatibility identity when user-agent is absent', async () => {
    const headers = await runPassthrough({})
    expect(headers['user-agent']).toBe(CLAUDE_CODE_USER_AGENT)
  })

  it('skips x-api-key when the provider supplies an Authorization header', async () => {
    const headers = await runPassthrough({
      customHeaders: { Authorization: 'Bearer provider-token' },
    })
    expect(headers['x-api-key']).toBeUndefined()
    expect(headers['Authorization']).toBe('Bearer provider-token')
  })

  it('injects x-api-key when no Authorization header is present', async () => {
    const headers = await runPassthrough({ sdkHeaders: {} })
    expect(headers['x-api-key']).toBe('sk-test')
  })
})

describe('anthropic passthrough non-streaming usage repair', () => {
  async function runNonStream(upstreamBody: string) {
    const req = anthReq()
    runInterceptors.mockResolvedValue({ intercepted: false, request: req })
    proxyFetch.mockResolvedValue(fakeResponse({ ok: true, text: upstreamBody }))
    const res = makeRes()
    await handleMessagesRequest(
      req,
      baseConfig({ apiType: 'anthropic_passthrough', url: 'https://third-party/v1/messages' }),
      res as unknown as ExpressResponse,
    )
    return res
  }

  function messageBody(usage?: unknown) {
    return JSON.stringify({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
      model: 'glm-5',
      stop_reason: 'end_turn',
      stop_sequence: null,
      ...(usage === undefined ? {} : { usage }),
    })
  }

  it('forwards a well-formed body byte-for-byte', async () => {
    const body = messageBody({ input_tokens: 12, output_tokens: 3 })
    const res = await runNonStream(body)
    expect(res.ended).toBe(body)
    expect(fillResponseUsageFallback).not.toHaveBeenCalled()
  })

  it('fills usage when the upstream omitted the object', async () => {
    fillResponseUsageFallback.mockImplementation((response: { usage?: unknown }) => {
      response.usage = { input_tokens: 42, output_tokens: 7 }
    })
    const res = await runNonStream(messageBody())

    expect(fillResponseUsageFallback).toHaveBeenCalledTimes(1)
    expect(JSON.parse(res.ended as string).usage).toEqual({ input_tokens: 42, output_tokens: 7 })
  })

  it('fills usage when the upstream reported zeros', async () => {
    await runNonStream(messageBody({ input_tokens: 0, output_tokens: 0 }))
    expect(fillResponseUsageFallback).toHaveBeenCalledTimes(1)
  })

  it('leaves a non-message body untouched', async () => {
    const body = JSON.stringify({ type: 'error', error: { message: 'nope' } })
    const res = await runNonStream(body)
    expect(res.ended).toBe(body)
    expect(fillResponseUsageFallback).not.toHaveBeenCalled()
  })

  it('leaves an unparseable body untouched', async () => {
    const res = await runNonStream('not json at all')
    expect(res.ended).toBe('not json at all')
    expect(fillResponseUsageFallback).not.toHaveBeenCalled()
  })
})

describe('upstream error mapping', () => {
  it('maps OpenAI-format upstream error to its type and status (rate_limit -> 429)', async () => {
    const req = anthReq()
    runInterceptors.mockResolvedValue({ intercepted: false, request: req })
    proxyFetch.mockResolvedValue(
      fakeResponse({
        ok: false,
        status: 500,
        text: JSON.stringify({ error: { type: 'rate_limit_error', message: 'slow down' } }),
      }),
    )
    const res = makeRes()

    await handleMessagesRequest(
      req,
      baseConfig({ apiType: 'chat_completions' }),
      res as unknown as ExpressResponse,
    )

    // getUpstreamError trusts the upstream error.type over the HTTP status;
    // sendError then maps that type through ERROR_STATUS_MAP.
    expect(res.statusCode).toBe(429)
    expect(res.jsonBody).toEqual({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'slow down' },
    })
  })

  it('falls back to status-derived type for non-JSON upstream errors', async () => {
    const req = anthReq()
    runInterceptors.mockResolvedValue({ intercepted: false, request: req })
    proxyFetch.mockResolvedValue(
      fakeResponse({ ok: false, status: 404, text: 'plain text not found' }),
    )
    const res = makeRes()

    await handleMessagesRequest(
      req,
      baseConfig({ apiType: 'chat_completions' }),
      res as unknown as ExpressResponse,
    )

    expect(res.statusCode).toBe(404)
    expect((res.jsonBody as { error: { type: string; message: string } }).error).toEqual({
      type: 'not_found_error',
      message: 'plain text not found',
    })
  })

  it('maps an unknown status to api_error (500)', async () => {
    const req = anthReq()
    runInterceptors.mockResolvedValue({ intercepted: false, request: req })
    proxyFetch.mockResolvedValue(fakeResponse({ ok: false, status: 418, text: 'teapot' }))
    const res = makeRes()

    await handleMessagesRequest(
      req,
      baseConfig({ apiType: 'chat_completions' }),
      res as unknown as ExpressResponse,
    )

    expect(res.statusCode).toBe(500)
    expect((res.jsonBody as { error: { type: string } }).error.type).toBe('api_error')
  })

  it('uses Anthropic-format error type when present (message-only body)', async () => {
    const req = anthReq()
    runInterceptors.mockResolvedValue({ intercepted: false, request: req })
    proxyFetch.mockResolvedValue(
      fakeResponse({
        ok: false,
        status: 400,
        text: JSON.stringify({ error: { message: 'bad input' } }),
      }),
    )
    const res = makeRes()

    await handleMessagesRequest(
      req,
      baseConfig({ apiType: 'chat_completions' }),
      res as unknown as ExpressResponse,
    )

    // No error.type in body -> derived from status 400.
    expect(res.statusCode).toBe(400)
    expect((res.jsonBody as { error: { type: string; message: string } }).error).toEqual({
      type: 'invalid_request_error',
      message: 'bad input',
    })
  })
})

describe('upstream error retry hints', () => {
  async function relay(upstream: { status: number; body: unknown; headers?: Record<string, string> }, apiType = 'chat_completions') {
    const req = anthReq()
    runInterceptors.mockResolvedValue({ intercepted: false, request: req })
    proxyFetch.mockResolvedValue(
      fakeResponse({
        ok: false,
        status: upstream.status,
        headers: upstream.headers,
        text: typeof upstream.body === 'string' ? upstream.body : JSON.stringify(upstream.body),
      }),
    )
    const res = makeRes()
    await handleMessagesRequest(
      req,
      baseConfig(apiType === 'anthropic_passthrough' ? { apiType, url: 'https://third-party/v1/messages' } : { apiType }),
      res as unknown as ExpressResponse,
    )
    return res
  }

  it('keeps the upstream status for a vendor-specific error type instead of collapsing it to 500', async () => {
    const res = await relay({
      status: 429,
      body: { type: 'error', error: { type: 'GoUsageLimitError', message: 'Go usage limit exceeded' } },
    })

    expect(res.statusCode).toBe(429)
    expect((res.jsonBody as { error: { type: string } }).error.type).toBe('GoUsageLimitError')
  })

  it('tells the client not to retry a spent quota, with no invented wait', async () => {
    const res = await relay({
      status: 429,
      body: { type: 'error', error: { type: 'GoUsageLimitError', message: 'Go usage limit exceeded' } },
    })

    expect(res.headers['x-should-retry']).toBe('false')
    expect(res.headers['retry-after']).toBeUndefined()
  })

  it('leaves an ordinary rate limit retryable on the client\'s own backoff', async () => {
    const res = await relay({ status: 429, body: { error: { type: 'rate_limit_error', message: 'Too many requests' } } })

    expect(res.statusCode).toBe(429)
    expect(res.headers['x-should-retry']).toBeUndefined()
    expect(res.headers['retry-after']).toBeUndefined()
  })

  it('forwards the upstream retry-after rather than replacing it', async () => {
    const res = await relay({
      status: 429,
      body: { error: { type: 'rate_limit_error', message: 'slow down' } },
      headers: { 'retry-after': '20' },
    })

    expect(res.headers['retry-after']).toBe('20')
  })

  it.each(['chat_completions', 'anthropic_passthrough'])(
    '%s: preserves short retry-after despite quota wording',
    async (apiType) => {
      const res = await relay({
        status: 429,
        body: { error: { type: 'rate_limit_error', message: 'Quota exceeded: requests per minute. Please retry in 2 seconds.' } },
        headers: { 'retry-after': '2' },
      }, apiType)

      expect(res.statusCode).toBe(429)
      expect(res.headers['retry-after']).toBe('2')
      expect(res.headers['x-should-retry']).toBeUndefined()
    },
  )

  it('honors an explicit upstream refusal to retry even with a retry-after', async () => {
    const res = await relay({
      status: 429,
      body: { error: { type: 'rate_limit_error', message: 'Quota exceeded' } },
      headers: { 'retry-after': '2', 'x-should-retry': 'false' },
    })

    expect(res.headers['x-should-retry']).toBe('false')
    expect(res.headers['retry-after']).toBe('2')
  })

  it('suggests a short wait for a server-side failure that came without one', async () => {
    const res = await relay({ status: 503, body: 'Service Unavailable' })

    expect(res.statusCode).toBe(500)
    expect(res.headers['retry-after']).toBe('3')
  })

  it('passthrough: keeps the upstream retry-after instead of forcing a short one', async () => {
    const res = await relay(
      {
        status: 429,
        body: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } },
        headers: { 'retry-after': '30' },
      },
      'anthropic_passthrough',
    )

    expect(res.statusCode).toBe(429)
    expect(res.headers['retry-after']).toBe('30')
  })

  it('passthrough: marks a spent quota as not retryable', async () => {
    const res = await relay(
      { status: 429, body: { type: 'error', error: { type: 'rate_limit_error', message: 'You exceeded your current quota' } } },
      'anthropic_passthrough',
    )

    expect(res.headers['x-should-retry']).toBe('false')
  })

  it('passthrough: an upstream x-should-retry is authoritative', async () => {
    const res = await relay(
      {
        status: 429,
        body: { type: 'error', error: { type: 'rate_limit_error', message: 'usage limit' } },
        headers: { 'x-should-retry': 'true' },
      },
      'anthropic_passthrough',
    )

    expect(res.headers['x-should-retry']).toBe('true')
  })
})
