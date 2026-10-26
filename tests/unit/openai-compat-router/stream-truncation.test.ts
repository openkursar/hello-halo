import Anthropic from '@anthropic-ai/sdk'
import type { Response as ExpressResponse } from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: true, getAppPath: () => globalThis.__HALO_TEST_DIR__, getPath: () => globalThis.__HALO_TEST_DIR__, getName: () => 'Halo', getVersion: () => 'test' },
  session: { defaultSession: { resolveProxy: vi.fn(async () => 'DIRECT') } }
}))

import { streamOpenAIChatToAnthropic } from '../../../src/main/openai-compat-router/stream/openai-chat-stream'
import { streamOpenAIResponsesToAnthropic } from '../../../src/main/openai-compat-router/stream/openai-responses-stream'
import { streamAnthropicPassthrough } from '../../../src/main/openai-compat-router/stream/anthropic-stream'
import { collectAnthropicMessage } from '../../../src/main/openai-compat-router/stream/message-collector'
import { blockLifecycleViolations, toolCallsAtStop } from './messages-stream-contract'
import { createCodexStreamBridgeForTest } from '../../../src/main/openai-compat-router/server/codex-responses-handler'

type Finish = 'normal' | 'limit' | 'missing' | 'error'
type Call = { name: string; args: string }
const wires = [
  {
    name: 'Chat Completions',
    convert: streamOpenAIChatToAnthropic,
    events(calls: Call[], finish: Finish): unknown[] {
      const events: unknown[] = calls.map((call, index) => ({
        id: 'test', model: 'test', choices: [{ index: 0, delta: { tool_calls: [{ index, id: `call_${index}`, type: 'function', function: { name: call.name, arguments: call.args } }] }, finish_reason: null }]
      }))
      if (finish === 'error') events.push({ error: { message: 'Upstream unavailable' } })
      else if (finish !== 'missing') events.push({ choices: [{ index: 0, delta: {}, finish_reason: finish === 'limit' ? 'length' : 'tool_calls' }] })
      return events
    }
  },
  {
    name: 'Responses',
    convert: streamOpenAIResponsesToAnthropic,
    events(calls: Call[], finish: Finish): unknown[] {
      const events: unknown[] = calls.flatMap((call, output_index) => [
        { type: 'response.output_item.added', output_index, item: { type: 'function_call', call_id: `call_${output_index}`, name: call.name } },
        { type: 'response.output_item.done', output_index, item: { type: 'function_call', call_id: `call_${output_index}`, name: call.name, arguments: call.args } }
      ])
      if (finish === 'limit') events.push({ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } })
      if (finish === 'normal') events.push({ type: 'response.completed', response: { status: 'completed' } })
      if (finish === 'error') events.push({ type: 'response.failed', response: { error: { message: 'Upstream unavailable' } } })
      return events
    }
  },
  {
    name: 'Anthropic compatible',
    convert: streamAnthropicPassthrough,
    events(calls: Call[], finish: Finish): unknown[] {
      const events: unknown[] = [{ type: 'message_start', message: { id: 'test', model: 'test' } }]
      calls.forEach((call, index) => events.push(
        { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `call_${index}`, name: call.name, input: {} } },
        { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: call.args } },
        { type: 'content_block_stop', index }
      ))
      if (finish === 'error') events.push({ type: 'error', error: { message: 'Upstream unavailable' } })
      else if (finish !== 'missing') events.push(
        { type: 'message_delta', delta: { stop_reason: finish === 'limit' ? 'max_tokens' : 'tool_use' }, usage: { output_tokens: 5 } },
        { type: 'message_stop' }
      )
      return events
    }
  }
]

function upstream(events: unknown[], fail: boolean | Error = false): ReadableStream<Uint8Array> {
  let sent = false
  return new ReadableStream({
    async pull(controller) {
      if (!sent) {
        sent = true
        controller.enqueue(new TextEncoder().encode(events.map(event => `data: ${event === '[DONE]' ? event : JSON.stringify(event)}\n\n`).join('')))
      } else if (fail) {
        await new Promise(resolve => setTimeout(resolve, 0))
        controller.error(fail instanceof Error ? fail : Object.assign(new Error('Connection reset'), { cause: { code: 'ECONNRESET' } }))
      } else controller.close()
    }
  })
}

async function convertEvents(wire: typeof wires[number], input: unknown[], fail: boolean | Error = false) {
  const chunks: string[] = []
  const response = { write: (chunk: unknown) => { chunks.push(String(chunk)); return true }, end: () => {} }
  await wire.convert(upstream(input, fail), response as unknown as ExpressResponse, 'test')
  const body = chunks.join('')
  const events = parseEvents(body)
  const client = new Anthropic({
    apiKey: 'test', maxRetries: 0,
    fetch: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  })
  const acceptedTools: string[] = []
  const stream = client.messages.stream({ model: 'test', max_tokens: 100, messages: [{ role: 'user', content: 'test' }] })
  stream.on('contentBlock', block => { if (block.type === 'tool_use') acceptedTools.push(block.name) })
  return { events, acceptedTools, final: stream.finalMessage() }
}

function parseEvents(body: string) {
  return body.trim().split('\n\n').map(event => {
    const lines = event.split('\n')
    return { event: lines[0].slice(7), data: JSON.parse(lines[1].slice(6)) }
  })
}

function convert(wire: typeof wires[number], calls: Call[], finish: Finish, fail: boolean | Error = false) {
  return convertEvents(wire, wire.events(calls, finish), fail)
}

function textEvents(wire: typeof wires[number], text: string): unknown[] {
  if (wire.name === 'Chat Completions') return [{ choices: [{ index: 0, delta: { content: text } }] }]
  if (wire.name === 'Responses') return [{ type: 'response.output_text.delta', delta: text }]
  return [
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } }
  ]
}

afterEach(() => { vi.restoreAllMocks() })

describe.each(wires.slice(0, 2))('$name explicit stream completion', wire => {
  it('accepts complete tool arguments followed by DONE without a finish reason', async () => {
    const result = await convertEvents(wire, [...wire.events([{ name: 'Bash', args: '{"command":"echo complete"}' }], 'missing'), '[DONE]'])
    expect((await result.final).stop_reason).toBe('tool_use')
    expect(result.acceptedTools).toEqual(['Bash'])
    expect(toolCallsAtStop(result.events)).toEqual([{ name: 'Bash', input: { command: 'echo complete' } }])
    expect(result.events.some(event => event.event === 'message_stop')).toBe(true)
    expect(blockLifecycleViolations(result.events)).toEqual([])
  })

  it('rejects a partial value even when followed by DONE', async () => {
    const result = await convertEvents(wire, [...wire.events([{ name: 'Bash', args: '{"command":"echo partial' }], 'missing'), '[DONE]'])
    await expect(result.final).rejects.toThrow(/incomplete tool arguments/)
    expect(result.acceptedTools).toEqual([])
    expect(result.events.some(event => event.event === 'message_stop')).toBe(false)
  })

  it('ends a text-only response normally on DONE', async () => {
    const result = await convertEvents(wire, [...textEvents(wire, 'Complete text'), '[DONE]'])
    expect((await result.final).stop_reason).toBe('end_turn')
    expect(result.events.some(event => event.event === 'message_stop')).toBe(true)
    expect(blockLifecycleViolations(result.events)).toEqual([])
  })

  it('preserves an output-limit stop when followed by DONE', async () => {
    const result = await convertEvents(wire, [...textEvents(wire, 'Limited text'), ...wire.events([], 'limit'), '[DONE]'])
    expect((await result.final).stop_reason).toBe('max_tokens')
    expect(result.events.some(event => event.event === 'message_stop')).toBe(true)
    expect(blockLifecycleViolations(result.events)).toEqual([])
  })
})

describe.each(wires)('$name truncated tool calls', wire => {
  it('delivers a complete tool and following text before the response ends', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const source = new ReadableStream<Uint8Array>({ start(value) { controller = value } })
    const chunks: string[] = []
    let sawText!: () => void
    const textReady = new Promise<void>(resolve => { sawText = resolve })
    const response = {
      write(chunk: unknown) {
        chunks.push(String(chunk))
        if (String(chunk).includes('"text":"After."')) sawText()
        return true
      },
      end() {}
    }
    const processing = wire.convert(source, response as unknown as ExpressResponse, 'test')
    const send = (events: unknown[]) => controller.enqueue(new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')))
    try {
      send([
        ...wire.events([{ name: 'Read', args: '{"file_path":"a.ts"}' }], 'missing'),
        ...textEvents(wire, 'After.')
      ])
      await textReady
      expect(toolCallsAtStop(parseEvents(chunks.join('')))).toEqual([{ name: 'Read', input: { file_path: 'a.ts' } }])
      expect(chunks.join('')).not.toContain('event: message_stop')
      send(wire.events([], 'normal'))
    } finally {
      controller.close()
      await processing
    }
    expect(blockLifecycleViolations(parseEvents(chunks.join('')))).toEqual([])
  })

  it.each(['{"command":"rm -rf ~', '{"command":"echo ok"', '{"seconds":90', ''])('rejects an output-limit cutoff: %s', async args => {
    const result = await convert(wire, [{ name: 'Bash', args }], 'limit')
    await expect(result.final).rejects.toThrow(/incomplete tool arguments/)
    expect(result.acceptedTools).toEqual([])
    expect(toolCallsAtStop(result.events)).toEqual([])
    expect(result.events.some(event => event.event === 'message_stop')).toBe(false)
  })

  it('rejects an incomplete last tool without revoking a tool already delivered', async () => {
    const result = await convert(wire, [{ name: 'Read', args: '{"file_path":"a.ts"}' }, { name: 'Bash', args: '{"command":"echo partial' }], 'limit')
    await expect(result.final).rejects.toThrow(/incomplete tool arguments/)
    expect(result.acceptedTools).toEqual(['Read'])
    expect(toolCallsAtStop(result.events)).toEqual([{ name: 'Read', input: { file_path: 'a.ts' } }])
  })

  it.each(['normal', 'limit'] as const)('rejects an earlier incomplete tool followed by a complete tool (%s)', async finish => {
    const result = await convert(wire, [{ name: 'Bash', args: '{"command":"echo truncated' }, { name: 'Read', args: '{"file_path":"a.ts"}' }], finish)
    await expect(result.final).rejects.toThrow(/incomplete tool arguments/)
    expect(result.acceptedTools).toEqual([])
    expect(toolCallsAtStop(result.events)).toEqual([])
  })

  it.each(['normal', 'limit'] as const)('rejects an earlier incomplete tool followed by text (%s)', async finish => {
    const result = await convertEvents(wire, [
      ...wire.events([{ name: 'Bash', args: '{"command":"echo truncated' }], 'missing'),
      ...textEvents(wire, 'Later text'),
      ...wire.events([], finish)
    ])
    await expect(result.final).rejects.toThrow(/incomplete tool arguments/)
    expect(result.acceptedTools).toEqual([])
    expect(toolCallsAtStop(result.events)).toEqual([])
  })

  it('preserves safe missing-bracket repair on normal completion', async () => {
    const result = await convert(wire, [{ name: 'Read', args: '{"file_path":"a.ts"' }], 'normal')
    const message = await result.final
    expect(message.content).toEqual([{ type: 'tool_use', id: 'call_0', name: 'Read', input: { file_path: 'a.ts' } }])
  })

  it('does not invent the end of a string even when the provider says it completed', async () => {
    const result = await convert(wire, [{ name: 'Bash', args: '{"command":"echo partial' }], 'normal')
    await expect(result.final).rejects.toThrow(/incomplete tool arguments/)
    expect(result.acceptedTools).toEqual([])
  })

  it('allows a completed empty object when the response reaches its output limit', async () => {
    const result = await convert(wire, [{ name: 'GetStatus', args: '{}' }], 'limit')
    expect((await result.final).content).toEqual([{ type: 'tool_use', id: 'call_0', name: 'GetStatus', input: {} }])
  })

  it('preserves parameterless tools with no argument deltas on normal completion', async () => {
    const result = await convert(wire, [{ name: 'GetStatus', args: '' }], 'normal')
    expect((await result.final).content).toEqual([{ type: 'tool_use', id: 'call_0', name: 'GetStatus', input: {} }])
  })

  it.each([false, true])('fails an unfinished stream instead of inventing a normal stop (connection error: %s)', async fail => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await convert(wire, [{ name: 'Bash', args: '{"command":"echo partial' }], 'missing', fail)
    await expect(result.final).rejects.toThrow(/before completion/)
    expect(warn.mock.calls.flat().join(' ')).toContain('tool=Bash, chars=24')
    expect(warn).toHaveBeenCalledTimes(1)
    if (fail) expect(warn.mock.calls[0][0]).toContain('name=Error, code=ECONNRESET, message=Connection reset')
    expect(result.acceptedTools).toEqual([])
  })

  it('logs a late stream failure once without rejecting a completed response', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await convert(wire, [{ name: 'Read', args: '{"file_path":"a.ts"}' }], 'normal', true)
    await result.final
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('Stream failed after completion')
    expect(warn.mock.calls[0][0]).toContain('code=ECONNRESET')
  })

  it('combines a late stream failure with the tool rejection in one warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await convert(wire, [{ name: 'Bash', args: '{"command":"echo private-input' }], 'limit', true)
    await expect(result.final).rejects.toThrow(/incomplete tool arguments/)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('reason=truncated_tool')
    expect(warn.mock.calls[0][0]).toContain('code=ECONNRESET')
    expect(warn.mock.calls[0][0]).not.toContain('private-input')
  })

  it('bounds exception messages and removes embedded URLs and quoted content', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = Object.assign(new TypeError('Stream failed at https://example.test/?token=private-token with "private-content"'), { code: 'ETIMEDOUT', cause: { code: 'ECONNRESET' } })
    const input = [...wire.events([], 'missing'), ...textEvents(wire, 'Private response')]
    const result = await convertEvents(wire, input, error)
    await expect(result.final).rejects.toThrow(/before completion/)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('name=TypeError, code=ETIMEDOUT, message=Stream failed')
    expect(warn.mock.calls[0][0]).not.toMatch(/private-token|private-content|Private response|example\.test/)

    warn.mockClear()
    const long = await convertEvents(wire, input, new Error('x'.repeat(250)))
    await expect(long.final).rejects.toThrow(/before completion/)
    expect(warn.mock.calls[0][0]).toContain(`message=${'x'.repeat(200)})`)
  })

  it('never repairs a tool after an upstream error event', async () => {
    const result = await convert(wire, [{ name: 'Bash', args: '{"command":"echo partial' }], 'error')
    await expect(result.final).rejects.toThrow(/Upstream unavailable/)
    expect(result.acceptedTools).toEqual([])
  })

  it('returns an error to non-streaming callers too', async () => {
    const result = await collectAnthropicMessage(sink => wire.convert(upstream(wire.events([{ name: 'Bash', args: '{"command":"echo partial' }], 'limit')), sink, 'test'))
    expect(result).toMatchObject({ error: { type: 'api_error', message: expect.stringContaining('incomplete tool arguments') } })
  })

  it('reports the rejection without logging tool input', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await convert(wire, [{ name: 'Bash', args: '{"command":"echo private-input' }], 'limit')
    await expect(result.final).rejects.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls.flat().join(' ')).toContain('reason=truncated_tool')
    expect(warn.mock.calls.flat().join(' ')).not.toContain('private-input')
  })
})

describe('truncated response forwarding', () => {
  it.each([' ', 'unexpected'])('handles data after an already delivered tool without reopening it (%s)', async extra => {
    const result = await convertEvents(wires[0], [
      ...wires[0].events([{ name: 'Bash', args: '{"command":"echo complete"}' }, { name: 'Read', args: '{"file_path":"a.ts"}' }], 'missing'),
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: extra } }] } }] },
      ...wires[0].events([], 'normal')
    ])
    if (extra.trim()) {
      await expect(result.final).rejects.toThrow(/after completing/)
      expect(result.acceptedTools).toEqual(['Bash'])
      expect(result.events.some(event => event.event === 'message_stop')).toBe(false)
    } else {
      await result.final
      expect(result.acceptedTools).toEqual(['Bash', 'Read'])
      expect(blockLifecycleViolations(result.events)).toEqual([])
    }
    expect(toolCallsAtStop(result.events).filter(call => call.name === 'Bash')).toEqual([{ name: 'Bash', input: { command: 'echo complete' } }])
  })

  it('keeps a text-only network failure distinct from clean EOF', async () => {
    const result = await convertEvents(wires[0], textEvents(wires[0], 'Partial text'), true)
    await expect(result.final).rejects.toThrow(/before completion/)
    expect(result.events.find(event => event.event === 'message_delta')?.data.delta.stop_reason).toBeNull()
    expect(result.events.some(event => event.event === 'message_stop')).toBe(false)
  })

  it('parses ordinary tool arguments once and an interleaved unfinished tool at most twice', async () => {
    const parse = JSON.parse
    const parsedInputs: string[] = []
    vi.spyOn(JSON, 'parse').mockImplementation((value: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
      if (value.startsWith('{"audit_input":')) parsedInputs.push(value)
      return parse(value, reviver)
    })
    const sink = { write: () => true, end() {} } as unknown as ExpressResponse
    await streamOpenAIChatToAnthropic(upstream(wires[0].events([
      { name: 'Read', args: '{"audit_input":"first"}' },
      { name: 'Read', args: '{"audit_input":"second"}' }
    ], 'normal')), sink, 'test')
    expect(parsedInputs).toEqual(['{"audit_input":"first"}', '{"audit_input":"second"}'])

    parsedInputs.length = 0
    const start = '{"audit_input":"' + 'x'.repeat(1024)
    const events = wires[0].events([{ name: 'Read', args: start }], 'missing')
    events.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_1', function: { name: 'Read', arguments: '{"file_path":"a.ts"}' } }] } }] })
    for (let index = 0; index < 64; index++) {
      events.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'x'.repeat(64) } }] } }] })
      events.push(...textEvents(wires[0], '.'))
    }
    events.push({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"}' } }] } }] })
    events.push(...wires[0].events([], 'normal'))
    await streamOpenAIChatToAnthropic(upstream(events), sink, 'test')
    expect(parsedInputs).toEqual([start, start + 'x'.repeat(64 * 64) + '"}'])
  })

  it('preserves complete interleaved tool inputs, text order and usage for the SDK', async () => {
    const chunk = (delta: Record<string, unknown>) => ({ choices: [{ index: 0, delta }] })
    const args = (index: number, value: string) => chunk({ tool_calls: [{ index, function: { arguments: value } }] })
    const result = await convertEvents(wires[0], [
      ...textEvents(wires[0], 'Before.'),
      chunk({ tool_calls: [
        { index: 0, id: 'call_0', type: 'function', function: { name: 'Bash', arguments: '{"command":"echo ' } },
        { index: 1, id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"' } }
      ] }),
      args(0, 'complete"}'),
      ...textEvents(wires[0], 'After.'),
      args(1, 'a.ts"}'),
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 17, completion_tokens: 9 } }
    ])
    const message = await result.final
    expect(message.content).toEqual([
      { type: 'text', text: 'Before.' },
      { type: 'tool_use', id: 'call_0', name: 'Bash', input: { command: 'echo complete' } },
      { type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: 'a.ts' } },
      { type: 'text', text: 'After.' }
    ])
    expect(message.usage).toMatchObject({ input_tokens: 17, output_tokens: 9 })
    expect(blockLifecycleViolations(result.events)).toEqual([])
  })

  it('streams text and tool input before the first completion boundary', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const source = new ReadableStream<Uint8Array>({ start(value) { controller = value } })
    const chunks: string[] = []
    let sawText!: () => void
    const textReady = new Promise<void>(resolve => { sawText = resolve })
    const response = {
      write(chunk: unknown) {
        chunks.push(String(chunk))
        if (String(chunk).includes('"text":"Before."')) sawText()
        return true
      },
      end() {}
    }
    const processing = streamOpenAIChatToAnthropic(source, response as unknown as ExpressResponse, 'test')
    const send = (events: unknown[]) => controller.enqueue(new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')))
    send([
      ...textEvents(wires[0], 'Before.'),
      ...wires[0].events([{ name: 'Read', args: '{"file_path":"a.ts"}' }], 'missing')
    ])
    await textReady
    expect(chunks.join('')).toContain('"type":"tool_use"')
    expect(chunks.join('')).not.toContain('"type":"content_block_stop","index":1')
    send(wires[0].events([], 'normal'))
    controller.close()
    await processing
    expect(chunks.join('')).toContain('"type":"tool_use"')
  })

  it('retains actual usage on a rejected tool batch without declaring a successful stop', async () => {
    const result = await convertEvents(wires[0], [
      ...wires[0].events([{ name: 'Bash', args: '{"command":"echo truncated' }], 'missing'),
      { choices: [{ index: 0, delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 17, completion_tokens: 9 } }
    ])
    await expect(result.final).rejects.toThrow(/incomplete tool arguments/)
    const usage = result.events.find(event => event.event === 'message_delta')
    expect(usage?.data).toMatchObject({ delta: { stop_reason: null }, usage: { input_tokens: 17, output_tokens: 9 } })
    expect(result.events.some(event => event.event === 'message_stop')).toBe(false)
    expect(result.acceptedTools).toEqual([])
  })

  it.each(['failed', 'incomplete'])('does not turn a Responses %s event without details into a completed tool', async status => {
    const result = await collectAnthropicMessage(sink => streamOpenAIResponsesToAnthropic(upstream([
      ...wires[1].events([{ name: 'Bash', args: '{"command":"echo partial"' }], 'missing'),
      { type: `response.${status}`, response: { status } }
    ]), sink, 'test'))
    expect(result).toHaveProperty('error')
  })

  it('preserves a truncation error through the Codex stream bridge', async () => {
    const chunks: string[] = []
    const response = { write: (chunk: unknown) => { chunks.push(String(chunk)); return true }, end: () => {} }
    const bridge = createCodexStreamBridgeForTest(response as unknown as ExpressResponse, 'test')
    await streamOpenAIChatToAnthropic(upstream(wires[0].events([{ name: 'Bash', args: '{"command":"echo partial' }], 'limit')), bridge, 'test')
    const body = chunks.join('')
    expect(body).toContain('event: response.failed')
    expect(body).toContain('incomplete tool arguments')
    expect(body).not.toContain('event: response.output_item.done')
    expect(body).not.toContain('event: response.completed')
  })
})
