/**
 * A request that does not ask for a stream must get one JSON message back,
 * even when the upstream is only ever asked to stream (a source that forces
 * streaming, a Responses source given no `stream` flag, or an upstream that
 * demands `stream: true`).
 *
 * Claude Code sends such a request as its fallback after a streamed answer
 * failed, and reads `usage.input_tokens` straight off the result. An SSE body
 * reaches it as plain text, which aborted the turn with "Cannot read
 * properties of undefined (reading 'input_tokens')".
 *
 * Runs the real converters and stream handlers; only the network is faked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Response as ExpressResponse } from 'express'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp/halo-test',
    getName: () => 'Halo',
    getVersion: () => '1.0.0-test'
  },
  session: {
    defaultSession: { resolveProxy: vi.fn(async () => 'DIRECT') },
    fromPartition: vi.fn(() => ({ setProxy: vi.fn(async () => undefined) }))
  }
}))

const proxyFetch = vi.fn()
vi.mock('../../../src/main/services/proxy-fetch', () => ({
  proxyFetch: (...a: unknown[]) => proxyFetch(...a)
}))

vi.mock('../../../src/main/openai-compat-router/interceptors', () => ({
  runInterceptors: async (request: unknown) => ({ intercepted: false, request })
}))

import { handleMessagesRequest } from '../../../src/main/openai-compat-router/server/request-handler'

interface CapturedRes {
  statusCode: number
  headers: Record<string, string>
  jsonBody: unknown
  written: string[]
  ended: boolean
  status: (n: number) => CapturedRes
  setHeader: (k: string, v: string) => void
  json: (b: unknown) => void
  write: (chunk: unknown) => boolean
  end: () => void
  on: (event: string, cb: () => void) => void
  emit: (event: string) => void
}

function makeRes(): CapturedRes {
  const listeners: Record<string, Array<() => void>> = {}
  return {
    statusCode: 200,
    headers: {},
    jsonBody: undefined,
    written: [],
    ended: false,
    status(n) { this.statusCode = n; return this },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v },
    json(b) { this.jsonBody = b; this.ended = true },
    write(chunk) { this.written.push(String(chunk)); return true },
    end() { this.ended = true },
    on(event, cb) { (listeners[event] ??= []).push(cb) },
    emit(event) { for (const cb of listeners[event] ?? []) cb() }
  }
}

/**
 * The reply as a non-streaming SDK client reads it: the parsed body for a
 * JSON reply, the raw text for anything else.
 */
function nonStreamingClientReading(res: CapturedRes): any {
  return res.jsonBody !== undefined ? res.jsonBody : res.written.join('')
}

/** The engine's cost accounting on a non-streaming result. */
function inputTokensOf(result: any): number {
  return result.usage.input_tokens
}

function sseResponse(events: unknown[], trailer = 'data: [DONE]\n\n'): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + trailer
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const responsesEvents = [
  { type: 'response.created', response: { id: 'resp_1', model: 'gpt-test', status: 'in_progress' } },
  { type: 'response.output_text.delta', delta: 'Let me search.' },
  { type: 'response.output_text.done' },
  { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'call_1', name: 'Grep' } },
  { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"pattern":' },
  { type: 'response.function_call_arguments.delta', output_index: 1, delta: '"usage"}' },
  { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', call_id: 'call_1', name: 'Grep', arguments: '{"pattern":"usage"}' } },
  {
    type: 'response.completed',
    response: { id: 'resp_1', model: 'gpt-test', status: 'completed', usage: { input_tokens: 1200, output_tokens: 30 } }
  }
]

const chatChunks = [
  { id: 'c1', model: 'chat-test', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Thinking it over.' } }] },
  { id: 'c1', model: 'chat-test', choices: [{ index: 0, delta: { content: 'Hello' } }] },
  { id: 'c1', model: 'chat-test', choices: [{ index: 0, delta: { content: ' there' }, finish_reason: 'stop' }] },
  { id: 'c1', model: 'chat-test', choices: [], usage: { prompt_tokens: 900, completion_tokens: 12 } }
]

function request(over: Record<string, unknown> = {}) {
  return {
    model: 'gpt-test',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Where is usage read?' }],
    ...over
  } as never
}

const responsesSource = {
  url: 'https://upstream.example/v1/responses',
  key: 'sk-test',
  apiType: 'responses'
}

const chatSource = {
  url: 'https://upstream.example/v1/chat/completions',
  key: 'sk-test',
  apiType: 'chat_completions'
}

async function send(req: unknown, config: Record<string, unknown>) {
  const res = makeRes()
  await handleMessagesRequest(req as never, config as never, res as unknown as ExpressResponse)
  return res
}

beforeEach(() => {
  proxyFetch.mockReset()
})

describe('non-streaming request, streaming upstream', () => {
  it('answers a source that forces streaming with one JSON message carrying usage', async () => {
    proxyFetch.mockResolvedValue(sseResponse(responsesEvents))

    const res = await send(request(), { ...responsesSource, forceStream: true })

    const result = nonStreamingClientReading(res)
    expect(() => inputTokensOf(result)).not.toThrow()
    expect(res.headers['content-type']).not.toBe('text/event-stream')
    expect(res.written).toEqual([])
    expect(result).toMatchObject({
      type: 'message',
      role: 'assistant',
      model: 'gpt-test',
      stop_reason: 'end_turn',
      content: [
        { type: 'text', text: 'Let me search.' },
        { type: 'tool_use', id: 'call_1', name: 'Grep', input: { pattern: 'usage' } }
      ],
      usage: { input_tokens: 1200, output_tokens: 30 }
    })
    // The upstream itself is still asked to stream.
    expect(JSON.parse(proxyFetch.mock.calls[0][1].body).stream).toBe(true)
  })

  it('answers a Responses source given no stream flag with one JSON message', async () => {
    proxyFetch.mockResolvedValue(sseResponse(responsesEvents))

    const res = await send(request(), responsesSource)

    expect(inputTokensOf(nonStreamingClientReading(res))).toBe(1200)
  })

  it('collects a forced Chat Completions stream, thinking included', async () => {
    proxyFetch.mockResolvedValue(sseResponse(chatChunks))

    const res = await send(request({ stream: false }), { ...chatSource, forceStream: true })

    expect(nonStreamingClientReading(res)).toMatchObject({
      type: 'message',
      content: [
        { type: 'thinking', thinking: 'Thinking it over.' },
        { type: 'text', text: 'Hello there' }
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 900, output_tokens: 12 }
    })
  })

  it('collects the stream of an upstream that demanded stream=true on retry', async () => {
    proxyFetch
      .mockResolvedValueOnce(new Response('{"error":{"message":"stream must be set to true"}}', { status: 400 }))
      .mockResolvedValueOnce(sseResponse(chatChunks))

    const res = await send(request({ stream: false }), chatSource)

    expect(proxyFetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse(proxyFetch.mock.calls[1][1].body).stream).toBe(true)
    expect(inputTokensOf(nonStreamingClientReading(res))).toBe(900)
  })

  it('turns an error the upstream reported mid-stream into an error reply', async () => {
    proxyFetch.mockResolvedValue(sseResponse([
      { type: 'response.output_text.delta', delta: 'Partial' },
      { type: 'response.failed', response: { status: 'failed', error: { code: 'server_error', message: 'upstream broke' } } }
    ]))

    const res = await send(request(), { ...responsesSource, forceStream: true })

    expect(res.statusCode).toBe(500)
    expect(res.jsonBody).toMatchObject({ type: 'error', error: { type: 'api_error' } })
    expect((res.jsonBody as { error: { message: string } }).error.message).toContain('upstream broke')
  })

  it('reports an upstream stream that never started a message as an error', async () => {
    proxyFetch.mockResolvedValue(sseResponse([], ''))

    const res = await send(request(), { ...responsesSource, forceStream: true })

    expect(res.statusCode).toBe(500)
    expect(res.jsonBody).toMatchObject({ type: 'error', error: { type: 'api_error' } })
  })

  it('writes nothing once the client has gone away', async () => {
    const encoder = new TextEncoder()
    proxyFetch.mockImplementation(async (_url: string, init: { signal: AbortSignal }) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(responsesEvents[1])}\n\n`))
          init.signal.addEventListener('abort', () =>
            controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })))
        }
      })
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })

    const res = makeRes()
    const done = handleMessagesRequest(request() as never, { ...responsesSource, forceStream: true } as never, res as unknown as ExpressResponse)
    await vi.waitFor(() => expect(proxyFetch).toHaveBeenCalledTimes(1))
    res.emit('close')
    await done

    expect(res.jsonBody).toBeUndefined()
    expect(res.written).toEqual([])
    expect(res.statusCode).toBe(200)
  })
})

describe('streaming request', () => {
  it('still relays the upstream stream as SSE', async () => {
    proxyFetch.mockResolvedValue(sseResponse(responsesEvents))

    const res = await send(request({ stream: true }), { ...responsesSource, forceStream: true })

    expect(res.headers['content-type']).toBe('text/event-stream')
    expect(res.jsonBody).toBeUndefined()
    const events = res.written.join('')
    expect(events).toContain('event: message_start')
    expect(events).toContain('event: message_stop')
  })
})
