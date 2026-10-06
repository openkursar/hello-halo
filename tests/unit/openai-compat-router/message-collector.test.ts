/**
 * collectAnthropicMessage: folds the SSE a stream handler writes into the
 * message it describes. Events are produced with the real SSEWriter so the
 * fold is tested against the exact wire the handlers emit.
 */

import { describe, expect, it } from 'vitest'
import { collectAnthropicMessage } from '../../../src/main/openai-compat-router/stream'
import { SSEWriter } from '../../../src/main/openai-compat-router/stream/sse-writer'

const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheCreationTokens: 0 }

describe('collectAnthropicMessage', () => {
  it('folds every block kind, in order, with the final stop reason and usage', async () => {
    const collected = await collectAnthropicMessage(async (sink) => {
      const w = new SSEWriter(sink)
      w.writeMessageStart('msg_1', 'model-x')
      w.writeThinkingBlockStart(0)
      w.writeThinkingDelta(0, 'pl')
      w.writeThinkingDelta(0, 'an')
      w.writeSignatureDelta(0, 'sig')
      w.writeBlockStop(0)
      w.writeTextBlockStart(1)
      w.writeTextDelta(1, 'Hel')
      w.writeTextDelta(1, 'lo')
      w.writeBlockStop(1)
      w.writeToolUseBlockStart(2, 'call_1', 'Grep')
      w.writeInputJsonDelta(2, '{"pattern":')
      w.writeInputJsonDelta(2, '"usage"}')
      w.writeBlockStop(2)
      w.writeWebSearchBlockStart(3, 'srv_1', [{ type: 'web_search_result', title: 'T', url: 'https://example.com' }])
      w.writeBlockStop(3)
      w.writeMessageDelta('tool_use', usage)
      w.writeMessageStop()
      w.end()
    })

    expect(collected).toEqual({
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'model-x',
        content: [
          { type: 'thinking', thinking: 'plan', signature: 'sig' },
          { type: 'text', text: 'Hello' },
          { type: 'tool_use', id: 'call_1', name: 'Grep', input: { pattern: 'usage' } },
          {
            type: 'web_search_tool_result',
            tool_use_id: 'srv_1',
            content: [{ type: 'web_search_result', title: 'T', url: 'https://example.com' }]
          }
        ],
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 0 }
      }
    })
  })

  it('starts a new block when an index is reused after its stop', async () => {
    // BaseStreamHandler opens text at the index of a thinking block that
    // closed without a signature.
    const collected = await collectAnthropicMessage(async (sink) => {
      const w = new SSEWriter(sink)
      w.writeMessageStart('msg_1', 'model-x')
      w.writeThinkingBlockStart(0)
      w.writeThinkingDelta(0, 'plan')
      w.writeBlockStop(0)
      w.writeTextBlockStart(0)
      w.writeTextDelta(0, 'answer')
      w.writeBlockStop(0)
      w.writeMessageDelta('end_turn', usage)
      w.writeMessageStop()
      w.end()
    })

    expect('message' in collected && collected.message.content).toEqual([
      { type: 'thinking', thinking: 'plan' },
      { type: 'text', text: 'answer' }
    ])
  })

  it('applies tool JSON that arrives after the block stopped', async () => {
    const collected = await collectAnthropicMessage(async (sink) => {
      const w = new SSEWriter(sink)
      w.writeMessageStart('msg_1', 'model-x')
      w.writeToolUseBlockStart(0, 'call_1', 'Read')
      w.writeInputJsonDelta(0, '{"path":"a.ts"')
      w.writeBlockStop(0)
      w.writeInputJsonDelta(0, '}')
      w.writeMessageDelta('tool_use', usage)
      w.end()
    })

    expect('message' in collected && collected.message.content).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'Read', input: { path: 'a.ts' } }
    ])
  })

  it('keeps empty tool input as an object and unparseable input as text', async () => {
    const collected = await collectAnthropicMessage(async (sink) => {
      const w = new SSEWriter(sink)
      w.writeMessageStart('msg_1', 'model-x')
      w.writeToolUseBlockStart(0, 'call_1', 'Ping')
      w.writeBlockStop(0)
      w.writeToolUseBlockStart(1, 'call_2', 'Read')
      w.writeInputJsonDelta(1, '{"path": a.ts')
      w.writeBlockStop(1)
      w.writeMessageDelta('tool_use', usage)
      w.end()
    })

    expect('message' in collected && collected.message.content).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'Ping', input: {} },
      { type: 'tool_use', id: 'call_2', name: 'Read', input: { text: '{"path": a.ts' } }
    ])
  })

  it('returns an error the stream reported instead of a partial message', async () => {
    const collected = await collectAnthropicMessage(async (sink) => {
      const w = new SSEWriter(sink)
      w.writeMessageStart('msg_1', 'model-x')
      w.writeTextBlockStart(0)
      w.writeTextDelta(0, 'Partial')
      w.writeError('{"code":"server_error","message":"upstream broke"}')
      w.writeMessageDelta('end_turn', usage)
      w.end()
    })

    expect(collected).toEqual({
      error: { type: 'api_error', message: '{"code":"server_error","message":"upstream broke"}' }
    })
  })

  it('returns the error a handler sent as a JSON error reply', async () => {
    const collected = await collectAnthropicMessage(async (sink) => {
      new SSEWriter(sink).sendError(502, 'api_error', 'Empty stream from provider')
    })

    expect(collected).toEqual({ error: { type: 'api_error', message: 'Empty stream from provider' } })
  })

  it('reports a stream that never started a message', async () => {
    const collected = await collectAnthropicMessage(async (sink) => {
      const w = new SSEWriter(sink)
      w.writeMessageDelta('end_turn', usage)
      w.writeMessageStop()
      w.end()
    })

    expect(collected).toEqual({ error: { type: 'api_error', message: 'Empty stream from provider' } })
  })
})
