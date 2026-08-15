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
vi.mock('../../../src/main/openai-compat-router/stream', () => ({
  streamOpenAIChatToAnthropic: (...a: unknown[]) => streamOpenAIChatToAnthropic(...a),
  streamOpenAIResponsesToAnthropic: (...a: unknown[]) => streamOpenAIResponsesToAnthropic(...a),
  streamAnthropicPassthrough: (...a: unknown[]) => streamAnthropicPassthrough(...a),
  pipeAnthropicPassthrough: (...a: unknown[]) => pipeAnthropicPassthrough(...a),
}))

const proxyFetch = vi.fn()
vi.mock('../../../src/main/services/proxy-fetch', () => ({
  proxyFetch: (...a: unknown[]) => proxyFetch(...a),
}))

const applyProviderAdapter = vi.fn(() => null)
vi.mock('../../../src/main/openai-compat-router/server/provider-adapters', () => ({
  applyProviderAdapter: (...a: unknown[]) => applyProviderAdapter(...a),
}))

// Run the queued fn inline so conversion-path assertions stay synchronous.
// api-type: real-ish behavior driven per test via mockReturnValue.
const getApiTypeFromUrl = vi.fn(() => 'chat_completions')
const isValidEndpointUrl = vi.fn(() => true)
const getEndpointUrlError = vi.fn(() => 'bad url')
const shouldForceStream = vi.fn(() => false)
vi.mock('../../../src/main/openai-compat-router/server/api-type', () => ({
  getApiTypeFromUrl: (...a: unknown[]) => getApiTypeFromUrl(...a),
  isValidEndpointUrl: (...a: unknown[]) => isValidEndpointUrl(...a),
  getEndpointUrlError: (...a: unknown[]) => getEndpointUrlError(...a),
  shouldForceStream: (...a: unknown[]) => shouldForceStream(...a),
}))

const isNativeAnthropicHost = vi.fn(() => false)
const normalizeSystemPrompt = vi.fn((request: unknown) => ({ request, modified: false }))
vi.mock('../../../src/main/openai-compat-router/utils', () => ({
  isNativeAnthropicHost: (...a: unknown[]) => isNativeAnthropicHost(...a),
  normalizeSystemPrompt: (...a: unknown[]) => normalizeSystemPrompt(...a),
  safeJsonParse: (input: string) => {
    try {
      return JSON.parse(input)
    } catch {
      return null
    }
  },
}))

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

  it('collapses content-type to a single value regardless of casing', async () => {
    const headers = await runPassthrough({
      sdkHeaders: { 'content-type': 'application/json' },
      customHeaders: { 'Content-Type': 'application/json' },
    })
    const ctKeys = Object.keys(headers).filter((k) => k.toLowerCase() === 'content-type')
    expect(ctKeys).toHaveLength(1)
    expect(headers[ctKeys[0]]).toBe('application/json')
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
