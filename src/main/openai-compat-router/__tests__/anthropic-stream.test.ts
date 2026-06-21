/**
 * Tests for AnthropicStreamHandler and BaseStreamHandler empty-text-block repair.
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

import { Readable } from 'node:stream'
import { streamAnthropicPassthrough, pipeAnthropicPassthrough } from '../stream/anthropic-stream'

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

/** Convert SSE text lines into a ReadableStream (simulates upstream body) */
function sseToStream(lines: string): ReadableStream {
  const encoded = new TextEncoder().encode(lines)
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

describe('AnthropicStreamHandler', () => {
  it('passes through a normal thinking + text response', async () => {
    const { res, chunks } = createMockRes()
    const upstream = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"test","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"let me think"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"hello world"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":20}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    ].join('')

    await streamAnthropicPassthrough(sseToStream(upstream), res, 'test-model')

    const events = parseSSEEvents(chunks)
    const textDeltas = events.filter(e =>
      e.event === 'content_block_delta' && e.data.delta?.type === 'text_delta'
    )
    expect(textDeltas).toHaveLength(1)
    expect(textDeltas[0].data.delta.text).toBe('hello world')

    const thinkingDeltas = events.filter(e =>
      e.event === 'content_block_delta' && e.data.delta?.type === 'thinking_delta'
    )
    expect(thinkingDeltas).toHaveLength(1)
    expect(thinkingDeltas[0].data.delta.thinking).toBe('let me think')
  })

  it('repairs thinking-only response with empty text block (GLM bug)', async () => {
    // GLM-4.7 bug: thinking has content, text block opened but no text_delta sent
    const { res, chunks } = createMockRes()
    const upstream = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"glm-4.7","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":100,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"full answer in thinking"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":50}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    ].join('')

    await streamAnthropicPassthrough(sseToStream(upstream), res, 'glm-4.7')

    const events = parseSSEEvents(chunks)

    // Should have injected a placeholder text block
    const textDeltas = events.filter(e =>
      e.event === 'content_block_delta' && e.data.delta?.type === 'text_delta'
    )
    expect(textDeltas.length).toBeGreaterThanOrEqual(1)
    // The placeholder text should be a space
    expect(textDeltas[textDeltas.length - 1].data.delta.text).toBe(' ')

    // message_delta should still be present with end_turn
    const msgDelta = events.find(e => e.event === 'message_delta')
    expect(msgDelta?.data.delta.stop_reason).toBe('end_turn')
  })

  it('repairs completely empty response (no blocks at all)', async () => {
    const { res, chunks } = createMockRes()
    const upstream = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"test","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":0}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    ].join('')

    await streamAnthropicPassthrough(sseToStream(upstream), res, 'test-model')

    const events = parseSSEEvents(chunks)

    // Should have injected a placeholder text block. The placeholder must be
    // non-empty: empty assistant text converts to `content: null` (invalid)
    // when the history is replayed to OpenAI-compat providers.
    const textBlockStarts = events.filter(e =>
      e.event === 'content_block_start' && e.data.content_block?.type === 'text'
    )
    expect(textBlockStarts).toHaveLength(1)

    const textDeltas = events.filter(e =>
      e.event === 'content_block_delta' && e.data.delta?.type === 'text_delta'
    )
    expect(textDeltas).toHaveLength(1)
    expect(textDeltas[0].data.delta.text).toBe(' ')

    const msgDelta = events.find(e => e.event === 'message_delta')
    expect(msgDelta?.data.delta.stop_reason).toBe('end_turn')
  })

  it('does not inject placeholder when text has actual content', async () => {
    const { res, chunks } = createMockRes()
    const upstream = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"test","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"real answer"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    ].join('')

    await streamAnthropicPassthrough(sseToStream(upstream), res, 'test-model')

    const events = parseSSEEvents(chunks)
    const textDeltas = events.filter(e =>
      e.event === 'content_block_delta' && e.data.delta?.type === 'text_delta'
    )
    // Only the original delta, no placeholder injected
    expect(textDeltas).toHaveLength(1)
    expect(textDeltas[0].data.delta.text).toBe('real answer')
  })

  it('does not inject placeholder when response has tool calls', async () => {
    const { res, chunks } = createMockRes()
    const upstream = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"test","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_file","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.txt\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":10}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    ].join('')

    await streamAnthropicPassthrough(sseToStream(upstream), res, 'test-model')

    const events = parseSSEEvents(chunks)

    // No text blocks should be injected — tool calls are the response
    const textBlockStarts = events.filter(e =>
      e.event === 'content_block_start' && e.data.content_block?.type === 'text'
    )
    expect(textBlockStarts).toHaveLength(0)
  })

  it('repairs thinking-only response that never opens a text block (GLM-5.1 form)', async () => {
    // GLM-5.1 form: only reasoning is streamed, no text block is ever opened.
    // The repair must not depend on which blocks the provider happened to open.
    const { res, chunks } = createMockRes()
    const upstream = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"test","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"deep thought"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":5}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    ].join('')

    await streamAnthropicPassthrough(sseToStream(upstream), res, 'test-model')

    const events = parseSSEEvents(chunks)

    const textDeltas = events.filter(e =>
      e.event === 'content_block_delta' && e.data.delta?.type === 'text_delta'
    )
    expect(textDeltas).toHaveLength(1)
    expect(textDeltas[0].data.delta.text).toBe(' ')

    const msgDelta = events.find(e => e.event === 'message_delta')
    expect(msgDelta?.data.delta.stop_reason).toBe('end_turn')
  })
})

describe('Anthropic passthrough: re-serialize vs raw pipe', () => {
  // Interleaved thinking: a thinking block that appears AFTER a text block in
  // the same response (the norm with Anthropic's interleaved-thinking beta).
  // The re-serializer's one-shot reasoning state machine drops such thinking
  // text while letting the signature through — this is the Claude-OAuth bug.
  const interleavedUpstream = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-opus-4-8","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Let me check."}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"thinking","thinking":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"thinking_delta","thinking":"interleaved reasoning"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"signature_delta","signature":"sig-abc"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":20}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  ].join('')

  it('re-serialize path drops interleaved thinking text but keeps the signature (documents the bug)', async () => {
    const { res, chunks } = createMockRes()

    await streamAnthropicPassthrough(sseToStream(interleavedUpstream), res, 'claude-opus-4-8')

    const events = parseSSEEvents(chunks)
    const thinkingDeltas = events.filter(e =>
      e.event === 'content_block_delta' && e.data.delta?.type === 'thinking_delta'
    )
    const signatureDeltas = events.filter(e =>
      e.event === 'content_block_delta' && e.data.delta?.type === 'signature_delta'
    )

    // The bug: thinking text is dropped, signature survives.
    expect(thinkingDeltas).toHaveLength(0)
    expect(signatureDeltas).toHaveLength(1)
  })

  it('raw pipe path forwards interleaved thinking text verbatim (the fix)', async () => {
    const { res, chunks } = createMockRes()

    await pipeAnthropicPassthrough(sseToStream(interleavedUpstream), res)

    // Byte-for-byte forwarding: output equals input exactly.
    expect(chunks.join('')).toBe(interleavedUpstream)

    const events = parseSSEEvents(chunks)
    const thinkingDeltas = events.filter(e =>
      e.event === 'content_block_delta' && e.data.delta?.type === 'thinking_delta'
    )
    expect(thinkingDeltas).toHaveLength(1)
    expect(thinkingDeltas[0].data.delta.thinking).toBe('interleaved reasoning')
  })

  it('raw pipe ends the response on an empty/missing upstream body', async () => {
    const { res } = createMockRes()
    await pipeAnthropicPassthrough(null, res)
    expect(res.end).toHaveBeenCalled()
  })
})
