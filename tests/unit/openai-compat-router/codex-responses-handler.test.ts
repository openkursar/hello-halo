/**
 * Unit tests for Codex Responses compatibility helpers.
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
import {
  anthropicToCodexResponse,
  buildCodexToolNamespaceMap,
  codexResponsesToAnthropicRequest,
  createCodexStreamBridgeForTest
} from '../../../src/main/openai-compat-router/server/codex-responses-handler'

describe('Codex Responses compatibility', () => {
  it('converts Codex Responses text input and developer instructions to Anthropic format', () => {
    const request = codexResponsesToAnthropicRequest({
      model: 'gpt-5.1-codex-max',
      instructions: 'Runtime instructions',
      input: [
        {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'Developer policy' }]
        },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Hello' }]
        }
      ],
      stream: true
    })

    expect(request.model).toBe('gpt-5.1-codex-max')
    expect(request.system).toBe('Runtime instructions\n\nDeveloper policy')
    expect(request.stream).toBe(true)
    expect(request.messages).toEqual([{ role: 'user', content: 'Hello' }])
  })

  it('converts Codex function calls and outputs into Anthropic tool turns', () => {
    const request = codexResponsesToAnthropicRequest({
      model: 'gpt-5.1-codex-max',
      input: [
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'read_file',
          arguments: '{"path":"/tmp/a.txt"}'
        },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: 'file body'
        }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: 'Read a file',
            parameters: { type: 'object', properties: { path: { type: 'string' } } }
          }
        }
      ],
      tool_choice: 'auto',
      reasoning: { effort: 'medium' }
    })

    expect(request.tools).toEqual([
      {
        name: 'read_file',
        description: 'Read a file',
        input_schema: { type: 'object', properties: { path: { type: 'string' } } },
        strict: undefined
      }
    ])
    expect(request.tool_choice).toEqual({ type: 'auto' })
    expect(request.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 })
    expect(request.messages).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: '/tmp/a.txt' } }]
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'file body' }]
      }
    ])
  })
  it('flattens Codex namespace tools (MCP) into individual function tools with namespaced names', () => {
    // Codex serializes MCP tools as `{ type: "namespace", name: "mcp__<server>__",
    // tools: [{ type: "function", name: "<tool>", parameters: {...} }] }` (see
    // codex-rs/tools/src/responses_api.rs). The model-visible canonical name is
    // `<namespace_name>+<inner_name>` — e.g. namespace "mcp__web-search__" +
    // inner "web_search" => "mcp__web-search__web_search". If we drop or
    // mis-name these, the upstream LLM never sees Halo's MCP tools and refuses
    // to call them ("tool not available in this session's tool list").
    const request = codexResponsesToAnthropicRequest({
      model: 'gpt-5.1-codex-max',
      input: [],
      tools: [
        {
          type: 'namespace',
          name: 'mcp__web-search__',
          description: 'Tools in the mcp__web-search__ namespace.',
          tools: [
            {
              type: 'function',
              name: 'web_search',
              description: 'Search the web.',
              parameters: {
                type: 'object',
                properties: { query: { type: 'string' } },
                required: ['query']
              }
            }
          ]
        },
        {
          // Non-namespaced function tool alongside — must still pass through.
          type: 'function',
          function: {
            name: 'shell',
            description: 'Run a shell command.',
            parameters: { type: 'object', properties: { cmd: { type: 'string' } } }
          }
        },
        {
          // Namespace name without trailing "__" must still produce the same
          // canonical "ns__inner" shape (no double underscores, no missing).
          type: 'namespace',
          name: 'mcp__halo-apps',
          tools: [
            { type: 'function', name: 'list_apps', parameters: { type: 'object' } }
          ]
        }
      ]
    })

    expect(request.tools).toEqual([
      {
        name: 'mcp__web-search__web_search',
        description: 'Search the web.',
        input_schema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query']
        },
        strict: undefined
      },
      {
        name: 'shell',
        description: 'Run a shell command.',
        input_schema: { type: 'object', properties: { cmd: { type: 'string' } } },
        strict: undefined
      },
      {
        name: 'mcp__halo-apps__list_apps',
        description: undefined,
        input_schema: { type: 'object' },
        strict: undefined
      }
    ])
  })

  it('degrades FREEFORM custom tools to JSON-input function tools with grammar in description', () => {
    const grammar = 'patch: "*** Begin Patch" body "*** End Patch"\nbody: /[^\\0]+/'
    const request = codexResponsesToAnthropicRequest({
      model: 'gpt-5.1-codex-max',
      input: [],
      tools: [
        {
          type: 'custom',
          name: 'apply_patch',
          description: 'Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.',
          format: { type: 'grammar', syntax: 'lark', definition: grammar }
        }
      ]
    })

    expect(request.tools).toHaveLength(1)
    const tool = request.tools![0]
    expect(tool.name).toBe('apply_patch')
    expect(tool.input_schema).toEqual({
      type: 'object',
      properties: {
        input: {
          type: 'string',
          description: 'The entire freeform tool body as a single string.'
        }
      },
      required: ['input'],
      additionalProperties: false
    })
    // Description must preserve the original guidance, mention the JSON
    // envelope contract, and embed the lark grammar so the upstream model
    // has enough context to produce a valid `input` body.
    expect(tool.description).toContain('FREEFORM')
    expect(tool.description).toContain('`input` field')
    expect(tool.description).toContain('Grammar (lark)')
    expect(tool.description).toContain(grammar)
  })

  it('passes JSON-schema custom tools through without wrapping', () => {
    const request = codexResponsesToAnthropicRequest({
      model: 'gpt-5.1-codex-max',
      input: [],
      tools: [
        {
          type: 'custom',
          name: 'specialized',
          description: 'Custom tool exposed as JSON',
          parameters: { type: 'object', properties: { id: { type: 'string' } } }
        }
      ]
    })

    expect(request.tools).toEqual([
      {
        name: 'specialized',
        description: 'Custom tool exposed as JSON',
        input_schema: { type: 'object', properties: { id: { type: 'string' } } },
        strict: undefined
      }
    ])
  })

  it('replays custom_tool_call history items by forwarding raw input under the JSON envelope key', () => {
    const request = codexResponsesToAnthropicRequest({
      model: 'gpt-5.1-codex-max',
      input: [
        {
          type: 'custom_tool_call',
          id: 'fc_apply_1',
          call_id: 'call_apply_1',
          name: 'apply_patch',
          input: '*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch\n'
        }
      ]
    })

    expect(request.messages).toEqual([
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'call_apply_1',
          name: 'apply_patch',
          input: { input: '*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch\n' }
        }]
      }
    ])
  })

  it('reconstructs the flat namespaced tool name from codex function_call {name, namespace} on history replay', () => {
    // Codex's ResponseItem::FunctionCall stores `name` and an optional
    // `namespace` as separate fields (codex-rs/protocol/src/models.rs:778-791).
    // When codex replays a prior turn, it sends BOTH on the function_call
    // input item. Halo flattened namespace tools outbound as
    // `<namespace><inner_name>` (mcp__ai_browser__browser_snapshot), so the
    // assistant message we reconstruct INBOUND must use the same flat name
    // — otherwise the upstream Chat Completions provider sees the assistant
    // message replay with bare inner names ("browser_snapshot"), the model
    // learns the short form from its own history, and on the next turn
    // emits short names that codex's tool registry cannot resolve
    // ("unsupported call: ...") because they have a null namespace.
    const request = codexResponsesToAnthropicRequest({
      model: 'deepseek-v4-flash',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'open baidu' }] },
        // Codex replays the prior assistant turn's function_call with
        // structured {name, namespace}.
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_navigate',
          name: 'browser_navigate',
          namespace: 'mcp__ai_browser__',
          arguments: '{"url":"https://www.baidu.com"}'
        },
        { type: 'function_call_output', call_id: 'call_navigate', output: 'ok' },
        // Replay also covers the `__`-stripped namespace form (some codex
        // versions store namespaces without trailing dunder).
        {
          type: 'function_call',
          id: 'fc_2',
          call_id: 'call_snapshot',
          name: 'browser_snapshot',
          namespace: 'mcp__ai_browser',
          arguments: '{}'
        },
        { type: 'function_call_output', call_id: 'call_snapshot', output: 'snap' }
      ]
    })

    expect(request.messages).toEqual([
      { role: 'user', content: 'open baidu' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_navigate',
            // Flat name that matches what we sent to the upstream model.
            name: 'mcp__ai_browser__browser_navigate',
            input: { url: 'https://www.baidu.com' }
          }
        ]
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_navigate', content: 'ok' }] },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_snapshot',
            // Even with a no-trailing-dunder namespace value, the flat name
            // must still terminate the namespace with `__`.
            name: 'mcp__ai_browser__browser_snapshot',
            input: {}
          }
        ]
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_snapshot', content: 'snap' }] }
    ])
  })

  it('does not double-prefix when codex replays a function_call whose name already includes the namespace', () => {
    // Defensive: some replays may serialize the flat name in `name` already
    // (older payloads, mixed wire variants). Combining a namespace with an
    // already-flat name must NOT produce `mcp__ai_browser__mcp__ai_browser__browser_navigate`.
    const request = codexResponsesToAnthropicRequest({
      model: 'deepseek-v4-flash',
      input: [
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_a',
          name: 'mcp__ai_browser__browser_navigate',
          namespace: 'mcp__ai_browser__',
          arguments: '{}'
        }
      ]
    })

    expect(request.messages).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_a',
            name: 'mcp__ai_browser__browser_navigate',
            input: {}
          }
        ]
      }
    ])
  })

  it('groups consecutive parallel tool_calls into one assistant message followed by matching tool messages', async () => {
    // Codex's wire format (Responses API) supports parallel tool calls —
    // codex-rs/core/src/session/turn.rs:985 sets `parallel_tool_calls` based
    // on model capability. When the model emits multiple tool calls in a
    // single turn, codex serializes them as consecutive `function_call`
    // items (one per call) followed by the matching `function_call_output`
    // items in the same order.
    //
    // OpenAI Chat Completions strict validation, on the other hand, requires
    // every assistant message with `tool_calls` to be IMMEDIATELY followed
    // by exactly the matching tool messages (one per `tool_call_id`), with
    // no other assistant or user content in between. If we naively map each
    // codex `function_call` to its own assistant message, DeepSeek (and
    // other strict providers) reject with:
    //   "An assistant message with 'tool_calls' must be followed by tool
    //    messages responding to each 'tool_call_id'. (insufficient tool
    //    messages following tool_calls message)"
    //
    // This test pins the bridging contract: consecutive function_call items
    // collapse into ONE assistant turn carrying multiple tool_use blocks,
    // and the matching function_call_output items become consecutive tool
    // messages. End-to-end check verifies the downstream OpenAI Chat
    // conversion produces the strict-validation-friendly shape.
    const request = codexResponsesToAnthropicRequest({
      model: 'deepseek-reasoner',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'do A and B' }] },
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'plan' }] },
        { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'tool_a', arguments: '{"x":1}' },
        { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'tool_b', arguments: '{"y":2}' },
        { type: 'function_call_output', call_id: 'call_a', output: 'result a' },
        { type: 'function_call_output', call_id: 'call_b', output: 'result b' }
      ]
    })

    // Anthropic-side: ONE assistant message with thinking + 2 tool_use blocks,
    // followed by 2 user-tool_result messages in the same order as the calls.
    expect(request.messages).toEqual([
      { role: 'user', content: 'do A and B' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'plan' },
          { type: 'tool_use', id: 'call_a', name: 'tool_a', input: { x: 1 } },
          { type: 'tool_use', id: 'call_b', name: 'tool_b', input: { y: 2 } }
        ]
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_a', content: 'result a' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_b', content: 'result b' }] }
    ])

    // OpenAI Chat-side: ONE assistant message with tool_calls of length 2,
    // immediately followed by 2 tool messages whose tool_call_ids match the
    // assistant's tool_calls in order. This is the shape DeepSeek's strict
    // validator demands.
    const { convertAnthropicToOpenAIChat } = await import('../../../src/main/openai-compat-router/converters')
    const { request: chatRequest } = convertAnthropicToOpenAIChat(request)
    expect(chatRequest.messages).toHaveLength(4)
    const [userMsg, assistantMsg, toolA, toolB] = chatRequest.messages as any[]
    expect(userMsg.role).toBe('user')
    expect(assistantMsg.role).toBe('assistant')
    expect(assistantMsg.tool_calls).toHaveLength(2)
    expect(assistantMsg.tool_calls[0].id).toBe('call_a')
    expect(assistantMsg.tool_calls[1].id).toBe('call_b')
    expect(assistantMsg.reasoning_content).toBe('plan')
    expect(toolA.role).toBe('tool')
    expect(toolA.tool_call_id).toBe('call_a')
    expect(toolB.role).toBe('tool')
    expect(toolB.tool_call_id).toBe('call_b')
  })

  it('preserves codex reasoning items as thinking blocks attached to the next assistant turn', () => {
    // Codex CLI replays the previous assistant turn's reasoning back to the
    // model server as a standalone `type: "reasoning"` item that precedes the
    // assistant `message` / `function_call` it belongs to. Halo MUST translate
    // that item into an Anthropic `thinking` block on the same assistant
    // message; otherwise the shared outbound converter has nothing to lift
    // into `reasoning_content`, and DeepSeek (and other thinking-mode-strict
    // providers) reject the request with:
    //   "The reasoning_content in the thinking mode must be passed back to the API."
    // This test pins the contract for both message-following and tool-call-
    // following reasoning items, and verifies multiple consecutive reasoning
    // items are merged into a single thinking block.
    const request = codexResponsesToAnthropicRequest({
      model: 'deepseek-reasoner',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first turn' }] },
        {
          type: 'reasoning',
          summary: [
            { type: 'output_text', text: 'thought line one' },
            { type: 'output_text', text: 'thought line two' }
          ]
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'first answer' }]
        },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'second turn' }] },
        { type: 'reasoning', summary: [{ type: 'output_text', text: 'tool-precursor thought' }] },
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'read_file',
          arguments: '{"path":"/tmp/a.txt"}'
        },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: 'file body'
        }
      ]
    })

    expect(request.messages).toEqual([
      { role: 'user', content: 'first turn' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'thought line one\nthought line two' },
          { type: 'text', text: 'first answer' }
        ]
      },
      { role: 'user', content: 'second turn' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'tool-precursor thought' },
          { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: '/tmp/a.txt' } }
        ]
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'file body' }]
      }
    ])
  })

  it('flushes orphaned reasoning items as standalone assistant turns', () => {
    // If a reasoning item is followed by a user-side item (user message or
    // tool output) instead of an assistant item, the thinking content must
    // still be emitted as its own assistant turn so it isn't silently dropped.
    // Same rule applies to trailing reasoning at the end of the input array.
    const request = codexResponsesToAnthropicRequest({
      model: 'deepseek-reasoner',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q1' }] },
        { type: 'reasoning', summary: [{ type: 'output_text', text: 'orphan-before-user' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q2' }] },
        { type: 'reasoning', summary: [{ type: 'output_text', text: 'trailing-orphan' }] }
      ]
    })

    expect(request.messages).toEqual([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'orphan-before-user' }] },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'trailing-orphan' }] }
    ])
  })

  it('propagates codex reasoning into reasoning_content for downstream OpenAI Chat upstream', async () => {
    // End-to-end check: the inbound codex reasoning must survive both the
    // codex->Anthropic step AND the Anthropic->OpenAI Chat step that runs
    // before the request hits a DeepSeek-class upstream. Once any assistant
    // message carries reasoning_content, the empty-string placeholder guard
    // (anthropic-to-openai-chat.ts:52-64) must also fill the field on every
    // other assistant message — DeepSeek requires this on every assistant
    // turn once thinking has appeared.
    const { convertAnthropicToOpenAIChat } = await import('../../../src/main/openai-compat-router/converters')
    const anthropicRequest = codexResponsesToAnthropicRequest({
      model: 'deepseek-reasoner',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q1' }] },
        { type: 'reasoning', summary: [{ type: 'output_text', text: 'why' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a1' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q2' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a2' }] }
      ]
    })

    const { request: openaiRequest } = convertAnthropicToOpenAIChat(anthropicRequest)
    const assistantMessages = openaiRequest.messages.filter((m) => m.role === 'assistant')
    expect(assistantMessages).toHaveLength(2)
    // The first assistant message carries the lifted reasoning_content...
    expect((assistantMessages[0] as any).reasoning_content).toBe('why')
    // ...and the second gets the empty-string placeholder so the entire
    // history conforms to the "every assistant turn must have it" contract.
    expect('reasoning_content' in (assistantMessages[1] as any)).toBe(true)
    expect((assistantMessages[1] as any).reasoning_content).toBe('')
  })

  it('converts Anthropic content blocks back to Codex Responses output items', () => {
    const response = anthropicToCodexResponse({
      id: 'msg_1',
      model: 'provider-model',
      content: [
        { type: 'thinking', thinking: 'reasoning' },
        { type: 'text', text: 'answer' },
        { type: 'tool_use', id: 'toolu_1', name: 'write_file', input: { path: 'a.txt' } }
      ],
      usage: { input_tokens: 7, output_tokens: 11 }
    }, 'fallback-model') as any

    expect(response.object).toBe('response')
    expect(response.model).toBe('provider-model')
    expect(response.usage).toEqual({ input_tokens: 7, output_tokens: 11, total_tokens: 18 })
    expect(response.output).toEqual([
      {
        id: expect.stringMatching(/^rs_/),
        type: 'reasoning',
        status: 'completed',
        // MUST be `summary_text` — codex-rs/protocol/src/models.rs:1192-1196
        // defines `ReasoningItemReasoningSummary` with a single variant
        // `SummaryText` tagged via `rename_all = "snake_case"`. Any other
        // value (we previously emitted `output_text`) makes the codex SSE
        // parser fail to deserialize the ResponseItem and silently drop the
        // reasoning, breaking conversation history replay for thinking-mode
        // providers.
        summary: [{ type: 'summary_text', text: 'reasoning' }]
      },
      {
        id: expect.stringMatching(/^msg_/),
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'answer' }]
      },
      {
        id: 'toolu_1',
        type: 'function_call',
        status: 'completed',
        name: 'write_file',
        call_id: 'toolu_1',
        arguments: '{"path":"a.txt"}'
      }
    ])
  })

  it('bridges Anthropic text stream into Codex message item events', () => {
    const chunks: string[] = []
    const res = {
      write: (chunk: unknown) => {
        chunks.push(String(chunk))
        return true
      },
      end: vi.fn(),
      setHeader: vi.fn(),
      status: vi.fn(),
    }
    const bridge = createCodexStreamBridgeForTest(res as any, 'test-model') as any

    bridge.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n')
    bridge.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n')
    bridge.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}\n\n')
    bridge.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n')
    bridge.write('event: message_stop\ndata: {"type":"message_stop"}\n\n')
    bridge.end()

    const body = chunks.join('')
    expect(body).toContain('event: response.output_item.added')
    expect(body).toContain('event: response.output_text.delta')
    expect(body).toContain('event: response.output_item.done')
    expect(body).toContain('event: response.completed')
    expect(body).toContain('"type":"message"')
    expect(body).toContain('"text":"你好"')
  })

  it('emits a single message item id consistent across added / delta / done', () => {
    // Regression guard for the duplicate-bubble bug: Codex CLI's parser
    // correlates output_item.added → output_text.delta → output_item.done
    // by the item.id field. If `added` or `done` omits id, Codex creates
    // a separate ghost item that lacks the deltas, then a second item
    // from the deltas — producing two agentMessage items downstream and
    // a doubled bubble in Halo's UI. This test pins the contract: exactly
    // one message id appears, and it is the same id used by every event.
    const chunks: string[] = []
    const res = {
      write: (chunk: unknown) => { chunks.push(String(chunk)); return true },
      end: vi.fn(),
      setHeader: vi.fn(),
      status: vi.fn(),
    }
    const bridge = createCodexStreamBridgeForTest(res as any, 'test-model') as any

    bridge.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n')
    bridge.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n')
    bridge.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你"}}\n\n')
    bridge.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好"}}\n\n')
    bridge.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n')
    bridge.write('event: message_stop\ndata: {"type":"message_stop"}\n\n')
    bridge.end()

    const body = chunks.join('')

    // Parse the SSE stream into individual events for structural assertions.
    const events: Array<{ event: string; data: any }> = []
    for (const part of body.split('\n\n')) {
      const lines = part.split('\n')
      const eventLine = lines.find((l) => l.startsWith('event:'))
      const dataLine = lines.find((l) => l.startsWith('data:'))
      if (!eventLine || !dataLine) continue
      try {
        events.push({ event: eventLine.slice(7).trim(), data: JSON.parse(dataLine.slice(5).trim()) })
      } catch { /* skip malformed */ }
    }

    const added = events.filter((e) => e.event === 'response.output_item.added')
    const deltas = events.filter((e) => e.event === 'response.output_text.delta')
    const done = events.filter((e) => e.event === 'response.output_item.done')

    // Exactly one message item should be opened and closed.
    expect(added).toHaveLength(1)
    expect(done).toHaveLength(1)
    expect(deltas.length).toBeGreaterThan(0)

    // The id field must be present on the item in added/done — Codex CLI
    // requires this to correlate the events.
    const addedId = added[0]?.data?.item?.id
    const doneId = done[0]?.data?.item?.id
    expect(typeof addedId).toBe('string')
    expect(addedId).toBeTruthy()
    expect(doneId).toBe(addedId)

    // Every delta's item_id must match the same id.
    for (const d of deltas) {
      expect(d.data.item_id).toBe(addedId)
    }
  })

  it('frames reasoning blocks with output_item.added/done so codex can persist them', () => {
    // Regression guard for the second half of the DeepSeek "reasoning_content
    // must be passed back" bug. Without output_item.added (carrying a
    // ResponseItem of type=reasoning) and a matching output_item.done at the
    // end, codex CLI cannot parse the reasoning into a ResponseItem and never
    // stores it in conversation history — so on the next turn it never
    // replays a `type: "reasoning"` input item, the inbound converter has
    // nothing to attach to, and the upstream sees a thinking-mode request
    // whose assistant turns lack reasoning_content. This test pins the
    // contract: an Anthropic thinking content block streams through the
    // bridge as added → reasoning_summary_text.delta → done, all sharing a
    // single id, with the full text in the final summary.
    const chunks: string[] = []
    const res = {
      write: (chunk: unknown) => { chunks.push(String(chunk)); return true },
      end: vi.fn(),
      setHeader: vi.fn(),
      status: vi.fn(),
    }
    const bridge = createCodexStreamBridgeForTest(res as any, 'test-model') as any

    bridge.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n')
    bridge.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n')
    bridge.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"step "}}\n\n')
    bridge.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"one"}}\n\n')
    bridge.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n')
    bridge.write('event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n')
    bridge.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"answer"}}\n\n')
    bridge.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n')
    bridge.write('event: message_stop\ndata: {"type":"message_stop"}\n\n')
    bridge.end()

    const events: Array<{ event: string; data: any }> = []
    for (const part of chunks.join('').split('\n\n')) {
      const lines = part.split('\n')
      const eventLine = lines.find((l) => l.startsWith('event:'))
      const dataLine = lines.find((l) => l.startsWith('data:'))
      if (!eventLine || !dataLine) continue
      try {
        events.push({ event: eventLine.slice(7).trim(), data: JSON.parse(dataLine.slice(5).trim()) })
      } catch { /* skip */ }
    }

    const reasoningAdded = events.find(
      (e) => e.event === 'response.output_item.added' && e.data.item?.type === 'reasoning'
    )
    const reasoningDeltas = events.filter((e) => e.event === 'response.reasoning_summary_text.delta')
    const reasoningDone = events.find(
      (e) => e.event === 'response.output_item.done' && e.data.item?.type === 'reasoning'
    )

    expect(reasoningAdded).toBeDefined()
    expect(reasoningDeltas.length).toBe(2)
    expect(reasoningDone).toBeDefined()

    const reasoningId = reasoningAdded!.data.item.id
    expect(typeof reasoningId).toBe('string')
    expect(reasoningId).toMatch(/^rs_/)
    // All deltas and the done event MUST carry the same item_id as the
    // added event so codex can correlate them.
    for (const delta of reasoningDeltas) {
      expect(delta.data.item_id).toBe(reasoningId)
      expect(delta.data.summary_index).toBe(0)
    }
    expect(reasoningDone!.data.item.id).toBe(reasoningId)
    expect(reasoningDone!.data.item.status).toBe('completed')
    // The final summary text accumulates all deltas, formatted as the same
    // {type,text} envelope used by the non-streaming anthropicToCodexResponse
    // path (output_text), so both code paths produce the same persisted shape.
    expect(reasoningDone!.data.item.summary).toEqual([
      { type: 'summary_text', text: 'step one' }
    ])

    // The text item that follows the reasoning must still be framed correctly
    // and use a different id than the reasoning item.
    const textAdded = events.find(
      (e) => e.event === 'response.output_item.added' && e.data.item?.type === 'message'
    )
    expect(textAdded).toBeDefined()
    expect(textAdded!.data.item.id).not.toBe(reasoningId)
  })

  it('lazy-frames reasoning when a thinking_delta arrives without a content_block_start', () => {
    // Defensive contract: some upstream variants emit reasoning deltas as the
    // first event without a preceding content_block_start. The bridge must
    // still emit output_item.added before the delta, otherwise codex's
    // ResponseItem parser drops the orphaned delta. Same item id correlation
    // applies.
    const chunks: string[] = []
    const res = {
      write: (chunk: unknown) => { chunks.push(String(chunk)); return true },
      end: vi.fn(),
      setHeader: vi.fn(),
      status: vi.fn(),
    }
    const bridge = createCodexStreamBridgeForTest(res as any, 'test-model') as any

    bridge.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n')
    // No content_block_start — go straight to a thinking_delta.
    bridge.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hidden"}}\n\n')
    bridge.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n')
    bridge.write('event: message_stop\ndata: {"type":"message_stop"}\n\n')
    bridge.end()

    const body = chunks.join('')
    const events: Array<{ event: string; data: any }> = []
    for (const part of body.split('\n\n')) {
      const lines = part.split('\n')
      const eventLine = lines.find((l) => l.startsWith('event:'))
      const dataLine = lines.find((l) => l.startsWith('data:'))
      if (!eventLine || !dataLine) continue
      try {
        events.push({ event: eventLine.slice(7).trim(), data: JSON.parse(dataLine.slice(5).trim()) })
      } catch { /* skip */ }
    }

    const order = events.map((e) => `${e.event}:${e.data.item?.type ?? e.data.item_id ?? ''}`)
    // output_item.added MUST appear before the first reasoning_summary_text.delta.
    const addedIdx = order.findIndex((s) => s.startsWith('response.output_item.added:reasoning'))
    const firstDeltaIdx = order.findIndex((s) => s.startsWith('response.reasoning_summary_text.delta'))
    expect(addedIdx).toBeGreaterThanOrEqual(0)
    expect(firstDeltaIdx).toBeGreaterThan(addedIdx)

    const reasoningDone = events.find(
      (e) => e.event === 'response.output_item.done' && e.data.item?.type === 'reasoning'
    )
    expect(reasoningDone).toBeDefined()
    expect(reasoningDone!.data.item.summary).toEqual([
      { type: 'summary_text', text: 'hidden' }
    ])
  })

  it('builds codex tool namespace map for round-trip name splitting', () => {
    // The map is what lets the streaming bridge re-attach the `namespace`
    // field on outgoing function_call items. Without it, codex's tool registry
    // (codex-rs/core/src/tools/registry.rs:243-245) cannot find the handler
    // for namespaced MCP tools and surfaces "unsupported call: ..." back to
    // the model — exactly the regression the e2e was guarding against.
    const map = buildCodexToolNamespaceMap([
      {
        type: 'namespace',
        name: 'mcp__web_search__',
        tools: [
          { type: 'function', name: 'web_search', parameters: { type: 'object' } },
          { type: 'function', name: 'fetch_url', parameters: { type: 'object' } },
        ],
      },
      {
        // Namespace name without trailing "__" — must still produce the same
        // canonical "<namespace_with_trailing_dunder>+<inner>" key.
        type: 'namespace',
        name: 'mcp__halo_apps',
        tools: [{ type: 'function', name: 'list_apps', parameters: { type: 'object' } }],
      },
      {
        // Plain function tools must NOT pollute the map.
        type: 'function',
        function: { name: 'shell', parameters: { type: 'object' } },
      },
    ])

    expect(map.size).toBe(3)
    expect(map.get('mcp__web_search__web_search')).toEqual({
      namespace: 'mcp__web_search__',
      name: 'web_search',
    })
    expect(map.get('mcp__web_search__fetch_url')).toEqual({
      namespace: 'mcp__web_search__',
      name: 'fetch_url',
    })
    expect(map.get('mcp__halo_apps__list_apps')).toEqual({
      namespace: 'mcp__halo_apps__',
      name: 'list_apps',
    })
    expect(map.get('shell')).toBeUndefined()
  })

  it('emits namespace+name on outgoing function_call when the inbound was a namespace tool', () => {
    // End-to-end shape check using the streaming bridge with a populated
    // namespace map. Driving the bridge with an Anthropic-shaped tool_use
    // event whose name is the flat `mcp__web_search__web_search` should
    // produce a codex `response.output_item.added` whose `item.namespace` is
    // `mcp__web_search__` and `item.name` is `web_search` — what codex's
    // function_call response item parser (router.rs:180-204) expects when
    // looking up a handler in the registry.
    // The bridge writes Codex SSE to the underlying res via two separate
    // res.write() calls per event (event line + data line). Buffer everything
    // and parse at the end to avoid missing events that span calls.
    let collected = ''
    const fakeRes = {
      write: (chunk: any) => {
        collected += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8')
        return true
      },
      end: () => undefined,
      setHeader: () => undefined,
      status: () => fakeRes,
    } as any
    const captures: Array<{ event: string; payload: any }> = []
    const parseCaptured = (): void => {
      captures.length = 0
      for (const block of collected.split('\n\n')) {
        const lines = block.split('\n')
        const eventLine = lines.find((l) => l.startsWith('event:'))
        const dataLine = lines.find((l) => l.startsWith('data:'))
        if (!eventLine || !dataLine) continue
        captures.push({
          event: eventLine.slice(6).trim(),
          payload: JSON.parse(dataLine.slice(5).trim()),
        })
      }
    }

    const map = buildCodexToolNamespaceMap([
      {
        type: 'namespace',
        name: 'mcp__web_search__',
        tools: [{ type: 'function', name: 'web_search', parameters: { type: 'object' } }],
      },
    ])

    const bridge = createCodexStreamBridgeForTest(fakeRes, 'gpt-5.1-codex-max', map)

    const sse = (event: any): string => `data: ${JSON.stringify(event)}\n\n`

    bridge.write(sse({ type: 'message_start', message: { id: 'msg_1' } }))
    bridge.write(
      sse({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'call_42', name: 'mcp__web_search__web_search', input: {} },
      }),
    )
    bridge.write(
      sse({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"query":"x"}' },
      }),
    )
    bridge.write(sse({ type: 'content_block_stop', index: 0 }))
    bridge.write(sse({ type: 'message_stop' }))
    parseCaptured()

    const added = captures.find((c) => c.event === 'response.output_item.added')
    expect(added, 'output_item.added should be emitted').toBeTruthy()
    expect(added!.payload.item.type).toBe('function_call')
    expect(added!.payload.item.name).toBe('web_search')
    expect(added!.payload.item.namespace).toBe('mcp__web_search__')

    const done = captures.find((c) => c.event === 'response.output_item.done')
    expect(done, 'output_item.done should be emitted').toBeTruthy()
    expect(done!.payload.item.name).toBe('web_search')
    expect(done!.payload.item.namespace).toBe('mcp__web_search__')
    expect(done!.payload.item.arguments).toBe('{"query":"x"}')
  })
})
