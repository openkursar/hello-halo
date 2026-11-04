/**
 * Kiro adapter: AWS event-stream responses → Anthropic SSE / JSON.
 * Fixtures are synthetic event-stream frames shaped like the service's.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { proxyFetch } = vi.hoisted(() => ({ proxyFetch: vi.fn() }))
vi.mock('../../../src/main/services/proxy-fetch', () => ({ proxyFetch }))

import { buildKiroPayload, handleKiroRequest } from '../../../src/main/openai-compat-router/adapters/kiro.adapter'
import { blockLifecycleViolations } from './messages-stream-contract'

type Headers = Record<string, string>

function frame(headers: Headers, payload: unknown): Buffer {
  const headerParts: Buffer[] = []
  for (const [name, value] of Object.entries(headers)) {
    const nameBuf = Buffer.from(name, 'utf8')
    const valueBuf = Buffer.from(value, 'utf8')
    const len = Buffer.alloc(2)
    len.writeUInt16BE(valueBuf.length)
    headerParts.push(Buffer.from([nameBuf.length]), nameBuf, Buffer.from([7]), len, valueBuf)
  }
  const headerBuf = Buffer.concat(headerParts)
  const payloadBuf = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8')
  const total = 12 + headerBuf.length + payloadBuf.length + 4
  const prelude = Buffer.alloc(12)
  prelude.writeUInt32BE(total, 0)
  prelude.writeUInt32BE(headerBuf.length, 4)
  return Buffer.concat([prelude, headerBuf, payloadBuf, Buffer.alloc(4)])
}

const event = (eventType: string, payload: unknown): Buffer =>
  frame({ ':message-type': 'event', ':event-type': eventType, ':content-type': 'application/json' }, payload)
const exception = (exceptionType: string, message: string): Buffer =>
  frame({ ':message-type': 'exception', ':exception-type': exceptionType }, { message })

/** Splits the bytes at awkward points so frames straddle chunks. */
function bodyOf(frames: Buffer[], chunkSize = 7): ReadableStream<Uint8Array> {
  const all = Buffer.concat(frames)
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < all.length; i += chunkSize) controller.enqueue(new Uint8Array(all.subarray(i, i + chunkSize)))
      controller.close()
    }
  })
}

function makeRes() {
  const res = {
    statusCode: 200,
    written: '',
    jsonBody: undefined as any,
    socket: null,
    status(n: number) { this.statusCode = n; return this },
    setHeader() {},
    flushHeaders() {},
    write(chunk: string) { this.written += chunk; return true },
    end() {},
    json(b: unknown) { this.jsonBody = b }
  }
  return res
}

function sseEvents(written: string): Array<{ event: string; data: any }> {
  return written.split('\n\n').filter(Boolean).map(block => {
    const [eventLine, dataLine] = block.split('\n')
    return { event: eventLine.slice('event: '.length), data: JSON.parse(dataLine.slice('data: '.length)) }
  })
}

async function run(frames: Buffer[], stream = true) {
  proxyFetch.mockResolvedValueOnce({ ok: true, status: 200, body: bodyOf(frames) })
  const res = makeRes()
  await handleKiroRequest(
    { model: 'claude-opus-5.5', max_tokens: 1024, stream, messages: [{ role: 'user', content: 'hi' }] } as any,
    { url: 'https://kiro.example/generateAssistantResponse', apiType: 'kiro', key: '', headers: {} } as any,
    res as any
  )
  return { res, events: sseEvents(res.written) }
}

const refusalFrames = [
  event('initial-response', { conversationId: 'c1' }),
  event('reasoningContentEvent', { text: 'Let me think about this request.' }),
  event('reasoningContentEvent', { signature: 'sig' }),
  event('metadataEvent', {
    stopReason: 'CONTENT_FILTERED',
    stopDetails: { refusal: { category: 'CYBER', explanation: 'The selected model cannot continue this conversation.' } }
  }),
  event('contextUsageEvent', { contextUsagePercentage: 7.4 })
]

describe('Kiro adapter stream decoding', () => {
  let warn: { mock: { calls: unknown[][] } }
  beforeEach(() => {
    proxyFetch.mockReset()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('streams answer text and tool calls split across chunks', async () => {
    const { events } = await run([
      event('assistantResponseEvent', { content: 'Hello ' }),
      event('assistantResponseEvent', { content: 'world' }),
      event('toolUseEvent', { name: 'Read', toolUseId: 't1', input: '' }),
      event('toolUseEvent', { name: 'Read', toolUseId: 't1', input: '{"path":' }),
      event('toolUseEvent', { name: 'Read', toolUseId: 't1', input: '"a.ts"}' }),
      event('toolUseEvent', { name: 'Read', toolUseId: 't1', stop: true }),
      event('meteringEvent', { unit: 'credit', usage: 3 }),
      event('contextUsageEvent', { contextUsagePercentage: 1 })
    ])
    expect(blockLifecycleViolations(events)).toEqual([])
    const text = events.filter(e => e.data.delta?.type === 'text_delta').map(e => e.data.delta.text).join('')
    expect(text).toBe('Hello world')
    const tool = events.find(e => e.data.content_block?.type === 'tool_use')
    expect(tool?.data.content_block).toMatchObject({ id: 't1', name: 'Read' })
    expect(events.find(e => e.data.delta?.type === 'input_json_delta')?.data.delta.partial_json).toBe('{"path":"a.ts"}')
    expect(events.find(e => e.event === 'message_delta')?.data.delta.stop_reason).toBe('tool_use')
    expect(warn).not.toHaveBeenCalled()
  })

  it('streams native reasoning as a thinking block before the answer', async () => {
    const { events } = await run([
      event('reasoningContentEvent', { text: 'Thinking step.' }),
      event('reasoningContentEvent', { signature: 'sig' }),
      event('assistantResponseEvent', { content: 'Answer.' })
    ])
    expect(blockLifecycleViolations(events)).toEqual([])
    expect(events.filter(e => e.event === 'content_block_start').map(e => e.data.content_block.type)).toEqual(['thinking', 'text'])
    expect(events.find(e => e.data.delta?.type === 'thinking_delta')?.data.delta.thinking).toBe('Thinking step.')
    expect(events.find(e => e.event === 'message_delta')?.data.delta.stop_reason).toBe('end_turn')
  })

  it('reports a content-filter refusal as an error carrying the upstream reason', async () => {
    const { events } = await run(refusalFrames)
    const error = events.find(e => e.event === 'error')
    expect(error?.data.error.type).toBe('invalid_request_error')
    expect(error?.data.error.message).toContain('claude-opus-5.5')
    expect(error?.data.error.message).toContain('CONTENT_FILTERED, CYBER')
    expect(error?.data.error.message).toContain('cannot continue this conversation')
    expect(events.some(e => e.event === 'message_delta')).toBe(false)
    expect(events.some(e => e.data.delta?.type === 'text_delta')).toBe(false)
    expect(blockLifecycleViolations(events)).toEqual([])
  })

  it('reports an in-stream exception as an error with its type', async () => {
    const { events } = await run([
      event('assistantResponseEvent', { content: 'Partial' }),
      exception('ThrottlingException', 'Too many requests')
    ])
    const error = events.find(e => e.event === 'error')
    expect(error?.data.error).toEqual({
      type: 'rate_limit_error',
      message: 'Kiro ThrottlingException for claude-opus-5.5: Too many requests'
    })
    expect(events.some(e => e.event === 'message_delta')).toBe(false)
    expect(blockLifecycleViolations(events)).toEqual([])
  })

  it('ends with max_tokens when content length is exceeded after answer text', async () => {
    const { events } = await run([
      event('assistantResponseEvent', { content: 'Long answer' }),
      exception('ContentLengthExceededException', 'Encountered unexpectedly high load')
    ])
    expect(events.some(e => e.event === 'error')).toBe(false)
    expect(events.find(e => e.event === 'message_delta')?.data.delta.stop_reason).toBe('max_tokens')
  })

  it('names the model and the dropped event types when a 200 stream has only unknown events', async () => {
    const { events } = await run([
      event('futureShinyEvent', { whatever: 1 }),
      event('futureShinyEvent', { whatever: 2 }),
      event('contextUsageEvent', { contextUsagePercentage: 1 })
    ])
    const error = events.find(e => e.event === 'error')
    expect(error?.data.error).toEqual({
      type: 'invalid_request_error',
      message: 'Kiro returned no content for claude-opus-5.5 (only unrecognized events: futureShinyEvent)'
    })
    const dropLogs = warn.mock.calls.filter(c => String(c[0]).includes('Dropped'))
    expect(dropLogs).toHaveLength(1)
    expect(String(dropLogs[0][0])).toContain('Dropped 2 unrecognized stream events model=claude-opus-5.5 types=futureShinyEvent')
  })

  it('reports reasoning without an answer as an explicit error', async () => {
    const { events } = await run([event('reasoningContentEvent', { text: 'Hmm.' })])
    expect(events.find(e => e.event === 'error')?.data.error).toEqual({
      type: 'invalid_request_error',
      message: 'Kiro returned no content for claude-opus-5.5 (reasoning only, no answer)'
    })
  })

  it('keeps an empty stream with no events retryable', async () => {
    const { events } = await run([])
    expect(events.find(e => e.event === 'error')?.data.error).toEqual({
      type: 'api_error',
      message: 'Kiro returned no content for claude-opus-5.5 (no events)'
    })
  })

  it('reports the length limit when it is hit during reasoning', async () => {
    const { events } = await run([
      event('reasoningContentEvent', { text: 'Long thought' }),
      exception('ContentLengthExceededException', 'Output too long')
    ])
    expect(events.find(e => e.event === 'error')?.data.error).toEqual({
      type: 'invalid_request_error',
      message: 'Kiro ContentLengthExceededException for claude-opus-5.5: Output too long'
    })
  })

  it('uses non-retryable status for deterministic empty ends on the non-streaming path', async () => {
    expect((await run([event('reasoningContentEvent', { text: 'Hmm.' })], false)).res.statusCode).toBe(400)
    expect((await run([event('futureShinyEvent', { a: 1 })], false)).res.statusCode).toBe(400)
    expect((await run([], false)).res.statusCode).toBe(500)
  })

  it('returns the refusal as an HTTP error on the non-streaming path', async () => {
    const { res } = await run(refusalFrames, false)
    expect(res.statusCode).toBe(400)
    expect(res.jsonBody.error.message).toContain('CONTENT_FILTERED, CYBER')
  })

  it('returns reasoning and text as blocks on the non-streaming path', async () => {
    const { res } = await run([
      event('reasoningContentEvent', { text: 'Why.' }),
      event('assistantResponseEvent', { content: 'Because.' })
    ], false)
    expect(res.jsonBody.content).toEqual([
      { type: 'thinking', thinking: 'Why.' },
      { type: 'text', text: 'Because.' }
    ])
  })
})

describe('Kiro request history', () => {
  it('does not replay earlier-turn thinking as assistant text', () => {
    const payload = buildKiroPayload({
      model: 'claude-opus-5.5',
      max_tokens: 1024,
      messages: [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: [
          { type: 'thinking', thinking: 'SECRET-REASONING', signature: '' },
          { type: 'text', text: 'A1' }
        ] },
        { role: 'user', content: 'q2' }
      ]
    } as any, 'conv-1', undefined) as any
    const history = payload.conversationState.history as any[]
    const assistant = history.find(h => h.assistantResponseMessage)?.assistantResponseMessage
    expect(assistant.content).toBe('A1')
    expect(JSON.stringify(payload)).not.toContain('SECRET-REASONING')
  })

  it('keeps tool calls and their results when dropping thinking from an agentic turn', () => {
    const payload = buildKiroPayload({
      model: 'claude-opus-5.5',
      max_tokens: 1024,
      tools: [{ name: 'Read', description: 'read', input_schema: { type: 'object', properties: {} } }],
      messages: [
        { role: 'user', content: 'read a.ts' },
        { role: 'assistant', content: [
          { type: 'thinking', thinking: 'SECRET-REASONING', signature: '' },
          { type: 'tool_use', id: 't1', name: 'Read', input: { path: 'a.ts' } }
        ] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file body' }] }
      ]
    } as any, 'conv-1', undefined) as any
    expect(JSON.stringify(payload)).not.toContain('SECRET-REASONING')
    const history = payload.conversationState.history as any[]
    const assistant = history.find(h => h.assistantResponseMessage)?.assistantResponseMessage
    expect(assistant.toolUses).toEqual([{ toolUseId: 't1', name: 'Read', input: { path: 'a.ts' } }])
    const results = payload.conversationState.currentMessage.userInputMessage.userInputMessageContext.toolResults
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ toolUseId: 't1', content: [{ text: 'file body' }] })
  })
})
