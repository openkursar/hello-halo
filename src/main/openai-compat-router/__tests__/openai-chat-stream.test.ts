/**
 * Tests for OpenAIChatStreamHandler — Chat Completions SSE to Anthropic
 * stream conversion, focused on empty-response repair.
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp/halo-test',
    getName: () => 'Halo',
    getVersion: () => '1.0.0-test'
  },
  session: {
    defaultSession: {
      resolveProxy: vi.fn(async () => 'DIRECT')
    },
    fromPartition: vi.fn(() => ({ setProxy: vi.fn(async () => undefined) }))
  }
}))

import { streamOpenAIChatToAnthropic } from '../stream/openai-chat-stream'

/** Build a mock Express response that captures written chunks */
function createMockRes() {
  const chunks: string[] = []
  const res = {
    write: (chunk: unknown) => { chunks.push(String(chunk)); return true },
    end: vi.fn(),
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn()
  }
  return { res: res as any, chunks }
}

/** Build a Chat Completions SSE body from chunk objects */
function chatSSE(chunkObjects: unknown[]): ReadableStream {
  const body = chunkObjects.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n'
  const encoded = new TextEncoder().encode(body)
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoded)
      controller.close()
    }
  })
}

/** Parse captured SSE chunks into typed events */
function parseSSEEvents(chunks: string[]): Array<{ event: string; data: any }> {
  const body = chunks.join('')
  const events: Array<{ event: string; data: any }> = []
  for (const part of body.split('\n\n')) {
    const lines = part.split('\n')
    const eventLine = lines.find(l => l.startsWith('event:'))
    const dataLine = lines.find(l => l.startsWith('data:'))
    if (!eventLine || !dataLine) continue
    try {
      events.push({
        event: eventLine.slice(7).trim(),
        data: JSON.parse(dataLine.slice(5).trim())
      })
    } catch { /* skip malformed */ }
  }
  return events
}

function textDeltasOf(events: Array<{ event: string; data: any }>) {
  return events.filter(e =>
    e.event === 'content_block_delta' && e.data.delta?.type === 'text_delta'
  )
}

describe('OpenAIChatStreamHandler empty-response repair', () => {
  it('repairs a truly empty response (role delta + finish_reason stop only)', async () => {
    // Observed from GLM-5.1: HTTP 200, no content/reasoning/tool_calls deltas,
    // straight to finish_reason "stop".
    const { res, chunks } = createMockRes()
    const stream = chatSSE([
      { id: 'c1', model: 'glm-5.1', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
      { id: 'c1', model: 'glm-5.1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
    ])

    await streamOpenAIChatToAnthropic(stream, res, 'glm-5.1')

    const events = parseSSEEvents(chunks)
    const textDeltas = textDeltasOf(events)
    expect(textDeltas).toHaveLength(1)
    expect(textDeltas[0].data.delta.text).toBe(' ')

    const msgDelta = events.find(e => e.event === 'message_delta')
    expect(msgDelta?.data.delta.stop_reason).toBe('end_turn')
    expect(events.some(e => e.event === 'message_stop')).toBe(true)
  })

  it('repairs a reasoning-only response (GLM-5.1 thinking without text)', async () => {
    const { res, chunks } = createMockRes()
    const stream = chatSSE([
      { id: 'c1', model: 'glm-5.1', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'thinking hard' }, finish_reason: null }] },
      { id: 'c1', model: 'glm-5.1', choices: [{ index: 0, delta: { reasoning_content: ' about it' }, finish_reason: null }] },
      { id: 'c1', model: 'glm-5.1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
    ])

    await streamOpenAIChatToAnthropic(stream, res, 'glm-5.1')

    const events = parseSSEEvents(chunks)

    // Thinking is forwarded
    const thinkingDeltas = events.filter(e =>
      e.event === 'content_block_delta' && e.data.delta?.type === 'thinking_delta'
    )
    expect(thinkingDeltas.length).toBeGreaterThanOrEqual(1)

    // Placeholder text block is injected so the SDK accepts the turn and the
    // assistant message round-trips as non-null content on the next request
    const textDeltas = textDeltasOf(events)
    expect(textDeltas).toHaveLength(1)
    expect(textDeltas[0].data.delta.text).toBe(' ')
  })

  it('repairs a stream that dies without finish_reason after producing nothing', async () => {
    // stopReason stays null; finishMessage defaults it to end_turn, so the
    // repair gate must match the effective stop reason.
    const { res, chunks } = createMockRes()
    const stream = chatSSE([
      { id: 'c1', model: 'glm-5.1', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }
    ])

    await streamOpenAIChatToAnthropic(stream, res, 'glm-5.1')

    const events = parseSSEEvents(chunks)
    const textDeltas = textDeltasOf(events)
    expect(textDeltas).toHaveLength(1)
    expect(textDeltas[0].data.delta.text).toBe(' ')
  })

  it('does not inject placeholder when text content is present', async () => {
    const { res, chunks } = createMockRes()
    const stream = chatSSE([
      { id: 'c1', model: 'glm-5.1', choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' }, finish_reason: null }] },
      { id: 'c1', model: 'glm-5.1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
    ])

    await streamOpenAIChatToAnthropic(stream, res, 'glm-5.1')

    const events = parseSSEEvents(chunks)
    const textDeltas = textDeltasOf(events)
    expect(textDeltas).toHaveLength(1)
    expect(textDeltas[0].data.delta.text).toBe('hello')
  })

  it('captures usage frame that arrives after finish_reason (LiteLLM shape)', async () => {
    // LiteLLM/DeepSeek-flavored upstream emits usage in a chunk AFTER the
    // finish_reason chunk. The client must not short-circuit on finish_reason
    // or the terminal usage frame is dropped and message_delta reports zeros.
    const { res, chunks } = createMockRes()
    const stream = chatSSE([
      { id: 'c1', model: 'deepseek-v4-flash', choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }] },
      { id: 'c1', model: 'deepseek-v4-flash', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { id: 'c1', model: 'deepseek-v4-flash', choices: [{ index: 0, delta: {}, finish_reason: null }] },
      { id: 'c1', model: 'deepseek-v4-flash', choices: [{ index: 0, delta: {}, finish_reason: null }], usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 } }
    ])

    await streamOpenAIChatToAnthropic(stream, res, 'deepseek-v4-flash')

    const events = parseSSEEvents(chunks)
    const msgDelta = events.find(e => e.event === 'message_delta')
    expect(msgDelta?.data.usage.input_tokens).toBe(5)
    expect(msgDelta?.data.usage.output_tokens).toBe(10)
    expect(msgDelta?.data.delta.stop_reason).toBe('end_turn')
  })

  it('does not inject placeholder when the response is tool calls', async () => {
    const { res, chunks } = createMockRes()
    const stream = chatSSE([
      {
        id: 'c1',
        model: 'glm-5.1',
        choices: [{
          index: 0,
          delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
          finish_reason: null
        }]
      },
      { id: 'c1', model: 'glm-5.1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
    ])

    await streamOpenAIChatToAnthropic(stream, res, 'glm-5.1')

    const events = parseSSEEvents(chunks)
    expect(textDeltasOf(events)).toHaveLength(0)

    const toolStarts = events.filter(e =>
      e.event === 'content_block_start' && e.data.content_block?.type === 'tool_use'
    )
    expect(toolStarts).toHaveLength(1)

    const msgDelta = events.find(e => e.event === 'message_delta')
    expect(msgDelta?.data.delta.stop_reason).toBe('tool_use')
  })
})
