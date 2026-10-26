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

import { streamOpenAIChatToAnthropic } from '../../../src/main/openai-compat-router/stream/openai-chat-stream'
import { blockLifecycleViolations, blockStarts, toolCallsAtStop } from './messages-stream-contract'

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

  it('preserves the empty-response fallback on a clean EOF without finish_reason', async () => {
    const { res, chunks } = createMockRes()
    const stream = chatSSE([
      { id: 'c1', model: 'glm-5.1', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }
    ])

    await streamOpenAIChatToAnthropic(stream, res, 'glm-5.1')

    const events = parseSSEEvents(chunks)
    const textDeltas = textDeltasOf(events)
    expect(textDeltas).toHaveLength(1)
    expect(textDeltas[0].data.delta.text).toBe(' ')
    expect(events.some(event => event.event === 'message_stop')).toBe(true)
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

  it('excludes cache_read_input_tokens from input_tokens when a provider bolts it onto an OpenAI-inclusive prompt_tokens (GLM Coding Plan regression)', async () => {
    // Real numbers from the production incident: prompt_tokens already
    // includes the cached portion (OpenAI semantics), so input_tokens must
    // be the difference — not prompt_tokens verbatim — or every downstream
    // consumer that sums input_tokens + cache_read_input_tokens double-counts
    // the cached tokens and reports ~2x the real context size.
    const { res, chunks } = createMockRes()
    const stream = chatSSE([
      { id: 'c1', model: 'glm-5.2-zp', choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }] },
      { id: 'c1', model: 'glm-5.2-zp', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 131186, completion_tokens: 79, total_tokens: 131265, cache_read_input_tokens: 130304 } }
    ])

    await streamOpenAIChatToAnthropic(stream, res, 'glm-5.2-zp')

    const events = parseSSEEvents(chunks)
    const msgDelta = events.find(e => e.event === 'message_delta')
    expect(msgDelta?.data.usage.input_tokens).toBe(882)
    expect(msgDelta?.data.usage.output_tokens).toBe(79)
  })

  it('leaves input_tokens unchanged when a provider never sends cache_read_input_tokens', async () => {
    // The overwhelming majority of OpenAI-compatible providers omit this
    // field entirely — normalization must be a no-op for them.
    const { res, chunks } = createMockRes()
    const stream = chatSSE([
      { id: 'c1', model: 'deepseek-v4-flash', choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }] },
      { id: 'c1', model: 'deepseek-v4-flash', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020 } }
    ])

    await streamOpenAIChatToAnthropic(stream, res, 'deepseek-v4-flash')

    const events = parseSSEEvents(chunks)
    const msgDelta = events.find(e => e.event === 'message_delta')
    expect(msgDelta?.data.usage.input_tokens).toBe(1000)
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

describe('OpenAIChatStreamHandler block lifecycle', () => {
  const toolCall = (index: number, id: string, name: string, args: string) => ({
    id: 'c1',
    model: 'glm-5.3',
    choices: [{ index: 0, delta: { tool_calls: [{ index, id, type: 'function', function: { name, arguments: args } }] }, finish_reason: null }]
  })

  it('gives the answer its own block after the reasoning', async () => {
    // The text block used to reopen index 0 of the closed thinking block.
    const { res, chunks } = createMockRes()
    const stream = chatSSE([
      { id: 'c1', model: 'glm-5.3', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'The user said hello.' }, finish_reason: null }] },
      { id: 'c1', model: 'glm-5.3', choices: [{ index: 0, delta: { content: '你好' }, finish_reason: null }] },
      { id: 'c1', model: 'glm-5.3', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
    ])

    await streamOpenAIChatToAnthropic(stream, res, 'glm-5.3')

    const events = parseSSEEvents(chunks)
    expect(blockStarts(events)).toEqual(['thinking@0', 'text@1'])
    expect(blockLifecycleViolations(events)).toEqual([])
  })

  it('keeps reasoning, text and every tool call of a turn on their own indices', async () => {
    const { res, chunks } = createMockRes()
    const stream = chatSSE([
      { id: 'c1', model: 'glm-5.3', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Read both files.' }, finish_reason: null }] },
      { id: 'c1', model: 'glm-5.3', choices: [{ index: 0, delta: { content: 'Let me look.' }, finish_reason: null }] },
      toolCall(0, 'call_1', 'Read', '{"path":"a.ts"}'),
      toolCall(1, 'call_2', 'Read', '{"path":"b.ts"}'),
      { id: 'c1', model: 'glm-5.3', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
    ])

    await streamOpenAIChatToAnthropic(stream, res, 'glm-5.3')

    const events = parseSSEEvents(chunks)
    expect(blockStarts(events)).toEqual(['thinking@0', 'text@1', 'tool_use@2', 'tool_use@3'])
    expect(blockLifecycleViolations(events)).toEqual([])
  })

  it('puts the reasoning-only placeholder after the thinking block', async () => {
    const { res, chunks } = createMockRes()
    const stream = chatSSE([
      { id: 'c1', model: 'glm-5.1', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'thinking hard' }, finish_reason: null }] },
      { id: 'c1', model: 'glm-5.1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
    ])

    await streamOpenAIChatToAnthropic(stream, res, 'glm-5.1')

    const events = parseSSEEvents(chunks)
    expect(blockStarts(events)).toEqual(['thinking@0', 'text@1'])
    expect(blockLifecycleViolations(events)).toEqual([])
  })

  it('opens a new text block for text that follows a tool call', async () => {
    const { res, chunks } = createMockRes()
    const stream = chatSSE([
      { id: 'c1', model: 'glm-5.3', choices: [{ index: 0, delta: { role: 'assistant', content: 'Checking.' }, finish_reason: null }] },
      toolCall(0, 'call_1', 'Read', '{"path":"a.ts"}'),
      { id: 'c1', model: 'glm-5.3', choices: [{ index: 0, delta: { content: 'Done.' }, finish_reason: null }] },
      { id: 'c1', model: 'glm-5.3', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
    ])

    await streamOpenAIChatToAnthropic(stream, res, 'glm-5.3')

    const events = parseSSEEvents(chunks)
    expect(blockStarts(events)).toEqual(['text@0', 'tool_use@1', 'text@2'])
    expect(blockLifecycleViolations(events)).toEqual([])
  })

  it('repairs the truncated JSON of an earlier tool call before its block stops', async () => {
    const { res, chunks } = createMockRes()
    const stream = chatSSE([
      toolCall(0, 'call_1', 'Read', '{"path":"a.ts"'),
      toolCall(1, 'call_2', 'Read', '{"path":"b.ts"}'),
      { id: 'c1', model: 'glm-5.3', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
    ])

    await streamOpenAIChatToAnthropic(stream, res, 'glm-5.3')

    const events = parseSSEEvents(chunks)
    expect(blockLifecycleViolations(events)).toEqual([])
    const firstInput = events
      .filter(e => e.event === 'content_block_delta' && e.data.index === 0)
      .map(e => e.data.delta.partial_json)
      .join('')
    expect(JSON.parse(firstInput)).toEqual({ path: 'a.ts' })
  })
})

describe('OpenAIChatStreamHandler tool call cut off before its arguments end', () => {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
    id: 'c1',
    model: 'qwen3.6',
    choices: [{ index: 0, delta, finish_reason: finish }]
  })
  const callStart = (index: number, name: string) =>
    chunk({ tool_calls: [{ index, id: `call_${index}`, type: 'function', function: { name, arguments: '' } }] })
  const callArgs = (index: number, args: string) => chunk({ tool_calls: [{ index, function: { arguments: args } }] })
  const text = (content: string) => chunk({ content })
  const end = chunk({}, 'tool_calls')

  async function run(chunkObjects: unknown[]) {
    const { res, chunks } = createMockRes()
    await streamOpenAIChatToAnthropic(chatSSE(chunkObjects), res, 'qwen3.6')
    return parseSSEEvents(chunks)
  }

  it('waits for all interleaved command arguments before completing the call', async () => {
    // Closed at the cut, `rm -rf ~/old-build` would run as `rm -rf ~`.
    const events = await run([
      callStart(0, 'Bash'),
      callArgs(0, '{"command":"rm -rf ~'),
      callStart(1, 'Read'),
      callArgs(1, '{"file_path":"b.ts"'),
      callArgs(0, '/old-build"}'),
      callArgs(1, '}'),
      end
    ])

    expect(toolCallsAtStop(events)).toEqual([
      { name: 'Bash', input: { command: 'rm -rf ~/old-build' } },
      { name: 'Read', input: { file_path: 'b.ts' } }
    ])
    expect(blockLifecycleViolations(events)).toEqual([])
  })

  it('keeps an interleaved numeric argument whole', async () => {
    const events = await run([
      callStart(0, 'Read'),
      callArgs(0, '{"file_path":"big.log","offset":90'),
      callStart(1, 'Read'),
      callArgs(1, '{"file_path":"b.ts"}'),
      callArgs(0, '00}'),
      end
    ])

    expect(toolCallsAtStop(events)[0]).toEqual({ name: 'Read', input: { file_path: 'big.log', offset: 9000 } })
    expect(blockLifecycleViolations(events)).toEqual([])
  })

  it('keeps a command whole when text arrives between its argument chunks', async () => {
    const events = await run([
      callStart(0, 'Bash'),
      callArgs(0, '{"command":"git reset --hard HEAD'),
      text('Resetting.'),
      callArgs(0, '~3"}'),
      end
    ])

    expect(toolCallsAtStop(events)).toEqual([{ name: 'Bash', input: { command: 'git reset --hard HEAD~3' } }])
    expect(blockLifecycleViolations(events)).toEqual([])
  })

  it('still closes a call that lacks only its closing braces when the next call starts', async () => {
    const events = await run([
      callStart(0, 'Edit'),
      callArgs(0, '{"file_path":"a.ts","options":{"replace_all":true}'),
      callStart(1, 'Read'),
      callArgs(1, '{"file_path":"b.ts"}'),
      end
    ])

    expect(toolCallsAtStop(events)).toEqual([
      { name: 'Edit', input: { file_path: 'a.ts', options: { replace_all: true } } },
      { name: 'Read', input: { file_path: 'b.ts' } }
    ])
    expect(blockLifecycleViolations(events)).toEqual([])
  })

  it('keeps calls whole when the server streams a newline inside their arguments', async () => {
    // Shape reported for sglang serving Qwen3.6: content "\n" before each
    // parallel call's closing brace.
    const call = (index: number, path: string) => [
      callStart(index, 'Read'),
      callArgs(index, '{'),
      callArgs(index, `"file_path": "${path}"`),
      text('\n'),
      callArgs(index, '}')
    ]
    const events = await run([...call(0, 'main.go'), ...call(1, 'weibo/weibo.go'), ...call(2, 'model/model.go'), end])

    expect(toolCallsAtStop(events)).toEqual([
      { name: 'Read', input: { file_path: 'main.go' } },
      { name: 'Read', input: { file_path: 'weibo/weibo.go' } },
      { name: 'Read', input: { file_path: 'model/model.go' } }
    ])
    expect(blockStarts(events)).toEqual(['tool_use@0', 'tool_use@1', 'tool_use@2'])
    expect(blockLifecycleViolations(events)).toEqual([])
  })

  it('keeps a command whole when the server streams a newline inside it', async () => {
    const events = await run([
      callStart(0, 'Bash'),
      callArgs(0, '{"command":"git reset --hard HEAD'),
      text('\n'),
      callArgs(0, '~3"}'),
      end
    ])

    expect(toolCallsAtStop(events)).toEqual([{ name: 'Bash', input: { command: 'git reset --hard HEAD~3' } }])
    expect(blockLifecycleViolations(events)).toEqual([])
  })
})
