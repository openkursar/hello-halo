/**
 * Regression: the per-conversation session-id header must survive to the
 * upstream request on the OpenAI-conversion path (chat_completions / responses),
 * not only on the anthropic_passthrough path.
 *
 * Upstream channel-affinity routing (halo cloud gateway) keys on this header to
 * pin a conversation to a stable channel+key. The conversion path rebuilds a
 * minimal header set from provider config, which historically dropped it — this
 * test locks in that it is restored via pickSessionAffinityHeaders.
 *
 * The mock upstream stands in for halo cloud: we assert on the exact header map
 * handed to proxyFetch, i.e. what physically reaches upstream.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Response as ExpressResponse } from 'express'
import { pickSessionAffinityHeaders } from '../../../src/main/openai-compat-router/utils/session-affinity'

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

// Keep the real pickSessionAffinityHeaders — the drop/restore behavior under
// test lives there — while stubbing the other utils used by the handler.
const isNativeAnthropicHost = vi.fn(() => false)
const normalizeSystemPrompt = vi.fn((request: unknown) => ({ request, modified: false }))
vi.mock('../../../src/main/openai-compat-router/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/openai-compat-router/utils')>()
  return {
    ...actual,
    isNativeAnthropicHost: (...a: unknown[]) => isNativeAnthropicHost(...a),
    normalizeSystemPrompt: (...a: unknown[]) => normalizeSystemPrompt(...a),
  }
})

vi.mock('../../../src/main/openai-compat-router/utils/token-counter', () => ({
  countTokens: vi.fn(() => 7),
}))

vi.mock('../../../src/main/openai-compat-router/utils/usage-estimator', () => ({
  deferInputTokensEstimate: vi.fn(() => async () => 0),
  fillResponseUsageFallback: vi.fn(),
}))

import { handleMessagesRequest } from '../../../src/main/openai-compat-router/server/request-handler'
import { handleResponsesRequest } from '../../../src/main/openai-compat-router/server/codex-responses-handler'

function makeRes() {
  const listeners: Record<string, Array<() => void>> = {}
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    jsonBody: undefined as unknown,
    ended: undefined as string | undefined,
    status(n: number) { this.statusCode = n; return this },
    setHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v },
    getHeader(k: string) { return this.headers[k.toLowerCase()] },
    json(b: unknown) { this.jsonBody = b },
    end(b?: string) { this.ended = b },
    on(event: string, cb: () => void) { (listeners[event] ??= []).push(cb) },
    emit(event: string) { for (const cb of listeners[event] ?? []) cb() },
  }
}

function fakeResponse(opts: { ok?: boolean; status?: number; json?: unknown }): globalThis.Response {
  const h = new Map<string, string>()
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    headers: {
      forEach: (cb: (v: string, k: string) => void) => h.forEach((v, k) => cb(v, k)),
      get: (k: string) => h.get(k.toLowerCase()) ?? null,
    },
    text: async () => '',
    json: async () => opts.json ?? {},
    body: null,
  } as unknown as globalThis.Response
}

function baseConfig(over: Record<string, unknown> = {}) {
  return { url: 'https://halo-cloud.example/v1/llm/chat/completions', key: 'sk-test', ...over } as never
}

function anthReq(over: Record<string, unknown> = {}) {
  return {
    model: 'public',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hi' }],
    stream: false,
    ...over,
  } as never
}

const CLAUDE_SESSION_HEADER = 'x-claude-code-session-id'
const CLAUDE_SESSION_VALUE = '58b1790b-0000-4000-8000-000000000001'
const CODEX_SESSION_HEADER = 'session_id'
const CODEX_SESSION_VALUE = '019feff6-1690-7fe3-b04e-aed14152d4dd'

function loweredHeaders(call: unknown): Record<string, string> {
  const outgoing = (call as { headers: Record<string, string> }).headers
  return Object.fromEntries(
    Object.entries(outgoing).map(([k, v]) => [k.toLowerCase(), v]),
  )
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
  convertAnthropicToOpenAIChat.mockReturnValue({ request: { model: 'public', messages: [] } })
  convertOpenAIChatToAnthropic.mockReturnValue({ type: 'message', content: [] })
})

describe('pickSessionAffinityHeaders', () => {
  it('extracts the Claude session header (case-insensitive)', () => {
    expect(pickSessionAffinityHeaders({ 'X-Claude-Code-Session-Id': 'abc' }))
      .toEqual({ 'x-claude-code-session-id': 'abc' })
  })

  it('extracts the Codex session header', () => {
    expect(pickSessionAffinityHeaders({ Session_id: 'xyz' }))
      .toEqual({ session_id: 'xyz' })
  })

  it('drops everything not on the allowlist', () => {
    expect(pickSessionAffinityHeaders({
      'x-claude-code-session-id': 'abc',
      authorization: 'Bearer leak',
      'anthropic-beta': 'oauth',
    })).toEqual({ 'x-claude-code-session-id': 'abc' })
  })

  it('is undefined- and empty-safe', () => {
    expect(pickSessionAffinityHeaders(undefined)).toEqual({})
    expect(pickSessionAffinityHeaders({ 'x-claude-code-session-id': '' })).toEqual({})
  })
})

describe('session-id header on the halo cloud path (chat_completions conversion)', () => {
  it('conversion path FORWARDS x-claude-code-session-id to upstream', async () => {
    const req = anthReq()
    runInterceptors.mockResolvedValue({ intercepted: false, request: req })
    proxyFetch.mockResolvedValue(fakeResponse({ ok: true, json: { id: 'x' } }))
    const res = makeRes()

    await handleMessagesRequest(
      req,
      baseConfig({ apiType: 'chat_completions' }),
      res as unknown as ExpressResponse,
      { sdkHeaders: { [CLAUDE_SESSION_HEADER]: CLAUDE_SESSION_VALUE } },
    )

    const lowered = loweredHeaders(proxyFetch.mock.calls[0][1])
    expect(lowered[CLAUDE_SESSION_HEADER]).toBe(CLAUDE_SESSION_VALUE)
  })

  it('passthrough path also forwards x-claude-code-session-id to upstream', async () => {
    const req = anthReq()
    runInterceptors.mockResolvedValue({ intercepted: false, request: req })
    proxyFetch.mockResolvedValue(fakeResponse({ ok: true }))
    const res = makeRes()

    await handleMessagesRequest(
      req,
      baseConfig({ apiType: 'anthropic_passthrough', url: 'https://third-party/v1/messages' }),
      res as unknown as ExpressResponse,
      { sdkHeaders: { [CLAUDE_SESSION_HEADER]: CLAUDE_SESSION_VALUE } },
    )

    const lowered = loweredHeaders(proxyFetch.mock.calls[0][1])
    expect(lowered[CLAUDE_SESSION_HEADER]).toBe(CLAUDE_SESSION_VALUE)
  })
})

describe('session-id header on the codex responses conversion path', () => {
  it('conversion path FORWARDS session_id to upstream', async () => {
    proxyFetch.mockResolvedValue(fakeResponse({ ok: true, json: { id: 'x' } }))
    const res = makeRes()

    await handleResponsesRequest(
      { model: 'public', input: 'hi', stream: false },
      baseConfig({ apiType: 'chat_completions' }),
      res as unknown as ExpressResponse,
      { sdkHeaders: { [CODEX_SESSION_HEADER]: CODEX_SESSION_VALUE } },
    )

    const lowered = loweredHeaders(proxyFetch.mock.calls[0][1])
    expect(lowered[CODEX_SESSION_HEADER]).toBe(CODEX_SESSION_VALUE)
  })
})
