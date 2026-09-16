/**
 * Regression: Responses backends that never stream `function_call_arguments`
 * deltas must still produce a complete tool call.
 *
 * The official Codex backend delivers function-call arguments only on the
 * completed item, and the Codex CLI's own client reads that item while
 * discarding the deltas. Before the backfill, the Anthropic stream closed the
 * tool block with empty input and the SDK saw a call with no arguments.
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
    defaultSession: { resolveProxy: vi.fn(async () => 'DIRECT') },
    fromPartition: vi.fn(() => ({ setProxy: vi.fn(async () => undefined) }))
  }
}))

import { streamOpenAIResponsesToAnthropic } from '../../../src/main/openai-compat-router/stream/openai-responses-stream'

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

function responsesSSE(events: unknown[]): ReadableStream {
  const body = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n'
  const encoded = new TextEncoder().encode(body)
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoded)
      controller.close()
    }
  })
}

function parseSSEEvents(chunks: string[]): Array<{ event: string; data: any }> {
  const events: Array<{ event: string; data: any }> = []
  for (const part of chunks.join('').split('\n\n')) {
    const lines = part.split('\n')
    const eventLine = lines.find(l => l.startsWith('event:'))
    const dataLine = lines.find(l => l.startsWith('data:'))
    if (!eventLine || !dataLine) continue
    try {
      events.push({ event: eventLine.slice(7).trim(), data: JSON.parse(dataLine.slice(5).trim()) })
    } catch { /* skip malformed */ }
  }
  return events
}

function toolInputJson(events: Array<{ event: string; data: any }>): string {
  return events
    .filter(e => e.event === 'content_block_delta' && e.data.delta?.type === 'input_json_delta')
    .map(e => e.data.delta.partial_json)
    .join('')
}

function functionCallEvents(argumentsJson: string) {
  return [
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'function_call', call_id: 'call_1', name: 'get_weather' }
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: argumentsJson }
    },
    { type: 'response.completed', response: { id: 'resp_1', status: 'completed' } }
  ]
}

describe('OpenAIResponsesStreamHandler tool-call argument recovery', () => {
  it('recovers arguments delivered only on the completed item', async () => {
    const { res, chunks } = createMockRes()

    await streamOpenAIResponsesToAnthropic(
      responsesSSE(functionCallEvents('{"city":"SF"}')),
      res,
      'gpt-5.5'
    )

    const events = parseSSEEvents(chunks)
    expect(events.some(e => e.event === 'content_block_start' && e.data.content_block?.name === 'get_weather')).toBe(true)
    expect(toolInputJson(events)).toBe('{"city":"SF"}')
  })

  it('does not duplicate arguments when deltas already carried them', async () => {
    const { res, chunks } = createMockRes()

    await streamOpenAIResponsesToAnthropic(
      responsesSSE([
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'function_call', call_id: 'call_2', name: 'get_weather' }
        },
        { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"city":' },
        { type: 'response.function_call_arguments.delta', output_index: 0, delta: '"SF"}' },
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: { type: 'function_call', call_id: 'call_2', name: 'get_weather', arguments: '{"city":"SF"}' }
        },
        { type: 'response.completed', response: { id: 'resp_2', status: 'completed' } }
      ]),
      res,
      'gpt-5.5'
    )

    expect(toolInputJson(parseSSEEvents(chunks))).toBe('{"city":"SF"}')
  })
})
