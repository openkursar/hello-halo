import { describe, expect, it } from 'vitest'
import { streamOpenAIChatToAnthropic } from '../../../src/main/openai-compat-router/stream/openai-chat-stream'
import { streamOpenAIResponsesToAnthropic } from '../../../src/main/openai-compat-router/stream/openai-responses-stream'

type Event = { type: string; index?: number; content_block?: Record<string, any>; delta?: Record<string, any> }

async function convert(protocol: 'chat' | 'responses', input: unknown[]) {
  const chunks: string[] = []
  const response = { write: (chunk: unknown) => { chunks.push(String(chunk)); return true }, end() {}, setHeader() {} }
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    for (const event of input) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`))
    controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
    controller.close()
  } })
  const handler = protocol === 'chat' ? streamOpenAIChatToAnthropic : streamOpenAIResponsesToAnthropic
  await handler(stream, response as any, 'local-model')
  return chunks.join('').split('\n\n').flatMap(part => {
    const data = part.split('\n').find(line => line.startsWith('data: '))
    return data ? [JSON.parse(data.slice(6)) as Event] : []
  })
}

function content(events: Event[]) {
  const blocks: Array<Record<string, any>> = []
  const open = new Set<number>()
  const argumentsByIndex = new Map<number, string>()
  for (const event of events) {
    const index = event.index!
    if (event.type === 'content_block_start') {
      expect(index, 'Each content block needs its own position in the final message').toBe(blocks.length)
      blocks.push({ ...event.content_block })
      open.add(index)
    } else if (event.type === 'content_block_delta') {
      expect(open.has(index), `Delta must target an open block: ${JSON.stringify(event)}`).toBe(true)
      const block = blocks[index]
      if (event.delta?.type === 'text_delta') {
        expect(block.type).toBe('text')
        block.text += event.delta.text
      } else if (event.delta?.type === 'thinking_delta') {
        expect(block.type).toBe('thinking')
        block.thinking += event.delta.thinking
      } else if (event.delta?.type === 'signature_delta') {
        expect(block.type).toBe('thinking')
        block.signature = (block.signature ?? '') + event.delta.signature
      } else if (event.delta?.type === 'input_json_delta') {
        expect(block.type).toBe('tool_use')
        argumentsByIndex.set(index, (argumentsByIndex.get(index) ?? '') + event.delta.partial_json)
      }
    } else if (event.type === 'content_block_stop') {
      expect(open.delete(index), `A block must stop once after its deltas: ${index}`).toBe(true)
      if (blocks[index].type === 'tool_use') blocks[index].input = JSON.parse(argumentsByIndex.get(index) || '{}')
    }
  }
  expect(open.size).toBe(0)
  expect(events.at(-1)?.type).toBe('message_stop')
  return blocks
}

const chat = (delta: Record<string, unknown>, finishReason: string | null = null) => ({ id: 'local-completion', model: 'local-model', choices: [{ index: 0, delta, finish_reason: finishReason }] })
const tool = (index: number, id: string, args: string) => ({ index, id, type: 'function', function: { name: 'report_to_user', arguments: args } })
const complete = { type: 'response.completed', response: { status: 'completed' } }

describe('mixed-content protocol block identity', () => {
  it('preserves text followed by complete tool arguments in distinct Anthropic blocks', async () => {
    const input = { type: 'run_complete', message: 'The review is complete.' }
    const blocks = content(await convert('chat', [
      chat({ role: 'assistant', content: 'The review is in progress.' }),
      chat({ tool_calls: [tool(0, 'report-1', JSON.stringify(input))] }),
      chat({}, 'tool_calls'),
    ]))
    expect(blocks).toEqual([{ type: 'text', text: 'The review is in progress.' }, { type: 'tool_use', id: 'report-1', name: 'report_to_user', input }])
  })

  it.each([false, true])('assigns thinking, text and multiple tool calls unique indices (signature=%s)', async signature => {
    const blocks = content(await convert('chat', [
      chat({ reasoning_content: 'Consider both reports.' }),
      ...(signature ? [chat({ thinking: { signature: 'fixture-signature' } })] : []),
      chat({ content: 'Reporting both results.' }),
      chat({ tool_calls: [tool(0, 'report-a', '{"type":"run_complete","message":"A"}'), tool(1, 'report-b', '{"type":"run_complete","message":"B"}')] }),
      chat({}, 'tool_calls'),
    ]))
    expect(blocks.map(block => block.type)).toEqual(['thinking', 'text', 'tool_use', 'tool_use'])
    expect(blocks[0].thinking).toBe('Consider both reports.')
    if (signature) expect(blocks[0].signature).toBe('fixture-signature')
    expect(blocks[2].input).toEqual({ type: 'run_complete', message: 'A' })
    expect(blocks[3].input).toEqual({ type: 'run_complete', message: 'B' })
  })

  it('keeps interleaved tool argument deltas inside their original open blocks', async () => {
    const blocks = content(await convert('chat', [
      chat({ content: 'Reporting both results.' }),
      chat({ tool_calls: [tool(0, 'report-a', '{"type":"run_complete",'), tool(1, 'report-b', '{"type":"run_complete",')] }),
      chat({ tool_calls: [{ index: 0, function: { arguments: '"message":"A"}' } }, { index: 1, function: { arguments: '"message":"B"}' } } ] }),
      chat({}, 'tool_calls'),
    ]))
    expect(blocks.filter(block => block.type === 'tool_use').map(block => block.input)).toEqual([{ type: 'run_complete', message: 'A' }, { type: 'run_complete', message: 'B' }])
  })

  it('keeps a reasoning-only fallback after the already closed thinking block', async () => {
    const blocks = content(await convert('chat', [chat({ reasoning_content: 'Thinking without a visible answer.' }), chat({}, 'stop')]))
    expect(blocks.map(block => block.type)).toEqual(['thinking', 'text'])
    expect(blocks[1].text).toBe(' ')
  })

  it('starts a fresh text block after tools without closing their unfinished arguments', async () => {
    const blocks = content(await convert('chat', [
      chat({ content: 'Starting.' }),
      chat({ tool_calls: [tool(0, 'report-1', '{"type":"run_complete",')] }),
      chat({ content: 'Finishing.' }),
      chat({ tool_calls: [{ index: 0, function: { arguments: '"message":"Complete"}' } }] }),
      chat({}, 'tool_calls'),
    ]))
    expect(blocks.map(block => block.type)).toEqual(['text', 'tool_use', 'text'])
    expect(blocks[1].input).toEqual({ type: 'run_complete', message: 'Complete' })
    expect(blocks[2].text).toBe('Finishing.')
  })

  it.each(['chat', 'responses'] as const)('repairs only the final JSON suffix before the %s tool block closes', async protocol => {
    const argumentsJson = '{"type":"run_complete","details":{"ready":true'
    const input = protocol === 'chat' ? [chat({ tool_calls: [tool(0, 'report-1', argumentsJson)] }), chat({}, 'tool_calls')] : [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'report-1', name: 'report_to_user' } },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', arguments: argumentsJson } }, complete,
    ]
    const events = await convert(protocol, input)
    const blocks = content(events)
    const deltas = events.filter(event => event.delta?.type === 'input_json_delta').map(event => event.delta!.partial_json)
    expect(deltas).toEqual([argumentsJson, '}}'])
    expect(blocks[0].input).toEqual({ type: 'run_complete', details: { ready: true } })
  })

  it('keeps web-search annotations and later text in separate contiguous blocks', async () => {
    const blocks = content(await convert('chat', [
      chat({ content: 'Searching.' }),
      chat({ annotations: [{ type: 'url_citation', url_citation: { title: 'Example', url: 'https://example.invalid', start_index: 0, end_index: 1 } }] }),
      chat({ content: 'The result is ready.' }), chat({}, 'stop'),
    ]))
    expect(blocks.map(block => block.type)).toEqual(['text', 'web_search_tool_result', 'text'])
    expect(blocks[2].text).toBe('The result is ready.')
  })

  it('preserves Responses thinking/text completion and done-only tool arguments without index gaps', async () => {
    const blocks = content(await convert('responses', [
      { type: 'response.reasoning_summary_text.delta', delta: 'Consider the report.' },
      { type: 'response.output_text.delta', delta: 'The report is ready.' },
      { type: 'response.output_text.done' },
      { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', call_id: 'report-1', name: 'report_to_user' } },
      { type: 'response.output_item.done', output_index: 2, item: { type: 'function_call', arguments: '{"type":"run_complete","message":"Complete"}' } }, complete,
    ]))
    expect(blocks.map(block => block.type)).toEqual(['thinking', 'text', 'tool_use'])
    expect(blocks[2].input).toEqual({ type: 'run_complete', message: 'Complete' })
  })

  it('preserves Responses tool indices when output items finish in reverse order', async () => {
    const blocks = content(await convert('responses', [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'report-a', name: 'report_to_user' } },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'report-b', name: 'report_to_user' } },
      { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', arguments: '{"type":"run_complete","message":"B"}' } },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', arguments: '{"type":"run_complete","message":"A"}' } }, complete,
    ]))
    expect(blocks.map(block => block.input)).toEqual([{ type: 'run_complete', message: 'A' }, { type: 'run_complete', message: 'B' }])
  })
})
