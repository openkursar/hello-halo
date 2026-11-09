/**
 * Unit tests for AnthropicProvider.
 *
 * Covers:
 * - capabilities()
 * - createMessage(): text, tool_use, thinking+signature, HTTP errors, retries
 * - createMessageStream(): streaming text, tool_call, thinking, signature, error event,
 *   message_stop early termination, abort signal
 * - buildRequestBody (via request inspection): tools, thinking modes, temperature/topP/topK
 * - normalizeMessages: string content, ContentBlock arrays, tool_result, thinking, image, document
 * - listModels(): success, no key, HTTP error, network failure
 * - healthCheck(): with key, no key
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AnthropicProvider } from './anthropic.js';
import type { ProviderRequest, Message, ContentBlock } from '../types/provider.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProvider(overrides: Partial<ConstructorParameters<typeof AnthropicProvider>[0]> = {}) {
  return new AnthropicProvider({
    apiKey: 'test-sk-anthropic',
    defaultModel: 'claude-test',
    ...overrides,
  });
}

/** Build a mock SSE streaming response using Anthropic native SSE format. */
function makeAnthropicSseResponse(events: unknown[], status = 200): Response {
  const encoder = new TextEncoder();
  // Each event is a JSON object with a `type` field; Anthropic includes type in data payload
  const lines = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(lines));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/** Build the standard Anthropic SSE event sequence for a simple text response. */
function textSseEvents(text: string, model = 'claude-test', inputTokens = 10, outputTokens = 5) {
  return [
    {
      type: 'message_start',
      message: { id: 'msg-001', model, content: [], usage: { input_tokens: inputTokens, output_tokens: 1 } },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: outputTokens },
    },
    { type: 'message_stop' },
  ];
}

/** Collect all events from an async generator. */
async function collectStream<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const evt of gen) events.push(evt);
  return events;
}

/** Base ProviderRequest for most tests. */
function baseRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: 'claude-test',
    messages: [],
    maxTokens: 1024,
    tools: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// capabilities()
// ---------------------------------------------------------------------------

describe('capabilities()', () => {
  it('reports all expected Anthropic capabilities', () => {
    const caps = makeProvider().capabilities();
    expect(caps.streaming).toBe(true);
    expect(caps.toolCalling).toBe(true);
    expect(caps.thinking).toBe(true);
    expect(caps.imageInput).toBe(true);
    expect(caps.pdfInput).toBe(true);
    expect(caps.audioInput).toBe(false);
    expect(caps.videoInput).toBe(false);
    expect(caps.caching).toBe(true);
    expect(caps.systemPromptStyle).toBe('top_level');
  });
});

// ---------------------------------------------------------------------------
// createMessage() — non-streaming façade (delegates to createMessageStream)
// ---------------------------------------------------------------------------

describe('createMessage()', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('assembles a text response from streaming events', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(makeAnthropicSseResponse(textSseEvents('Hello World!'))),
    );

    const provider = makeProvider();
    const result = await provider.createMessage(baseRequest({
      messages: [{ role: 'user', content: 'Hi' }],
    }));

    expect(result.id).toBe('msg-001');
    expect(result.model).toBe('claude-test');
    expect(result.stopReason).toBe('end_turn');
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'Hello World!' });
    expect(result.usage.input_tokens).toBe(10);
    expect(result.usage.output_tokens).toBeGreaterThan(0);
  });

  it('rejects oversized aggregate image payload before network dispatch', async () => {
    const messages: Message[] = [{ role: 'user', content: Array.from({ length: 5 }, () => ({
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: 'image/png', data: 'A'.repeat(5 * 1024 * 1024) },
    })) }];
    await expect(makeProvider().createMessage(baseRequest({ messages }))).rejects.toThrow(/Image request exceeds/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends correct headers and request body', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(makeAnthropicSseResponse(textSseEvents('ok'))),
    );

    await makeProvider().createMessage(baseRequest({
      messages: [{ role: 'user', content: 'test' }],
    }));

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');

    const headers = options.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('test-sk-anthropic');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['anthropic-beta']).toBeUndefined();
    expect(headers['content-type']).toBe('application/json');

    const body = JSON.parse(options.body as string);
    expect(body.model).toBe('claude-test');
    expect(body.stream).toBe(true); // always streams internally
    expect(body.max_tokens).toBe(1024);
  });

  it('assembles a tool_use response from streaming events', async () => {
    const toolEvents = [
      {
        type: 'message_start',
        message: { id: 'msg-002', model: 'claude-test', content: [], usage: { input_tokens: 20, output_tokens: 1 } },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool_1', name: 'read_file', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"/etc/hosts"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10 } },
      { type: 'message_stop' },
    ];
    fetchMock.mockImplementation(() => Promise.resolve(makeAnthropicSseResponse(toolEvents)));

    const result = await makeProvider().createMessage(baseRequest());

    expect(result.stopReason).toBe('tool_use');
    const toolBlock = result.content.find((b) => b.type === 'tool_use') as any;
    expect(toolBlock).toBeDefined();
    expect(toolBlock.id).toBe('tool_1');
    expect(toolBlock.name).toBe('read_file');
    expect(toolBlock.input).toEqual({ path: '/etc/hosts' });
  });

  it('assembles a thinking block with signature', async () => {
    const thinkingEvents = [
      {
        type: 'message_start',
        message: { id: 'msg-003', model: 'claude-test', content: [], usage: { input_tokens: 15, output_tokens: 1 } },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me think...' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig_abc' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Answer here.' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } },
      { type: 'message_stop' },
    ];
    fetchMock.mockImplementation(() => Promise.resolve(makeAnthropicSseResponse(thinkingEvents)));

    const result = await makeProvider().createMessage(baseRequest());

    const thinking = result.content.find((b) => b.type === 'thinking') as any;
    expect(thinking).toBeDefined();
    expect(thinking.thinking).toBe('Let me think...');
    expect(thinking.signature).toBe('sig_abc');

    const text = result.content.find((b) => b.type === 'text') as any;
    expect(text?.text).toBe('Answer here.');
  });

  it('accumulates multiple thinking deltas and signature deltas', async () => {
    const events = [
      {
        type: 'message_start',
        message: { id: 'msg-004', model: 'claude-test', content: [], usage: { input_tokens: 5, output_tokens: 1 } },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Part1' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: ' Part2' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig_A' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig_B' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ];
    fetchMock.mockImplementation(() => Promise.resolve(makeAnthropicSseResponse(events)));

    const result = await makeProvider().createMessage(baseRequest());
    const thinking = result.content.find((b) => b.type === 'thinking') as any;
    expect(thinking.thinking).toBe('Part1 Part2');
    // Signature is an atomic value — last delta overwrites.
    expect(thinking.signature).toBe('sig_B');
  });

  it('throws on HTTP 401 authentication error', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { type: 'authentication_error', message: 'Invalid API key' } }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    await expect(makeProvider().createMessage(baseRequest())).rejects.toThrow(/401/);
  });

  it('throws on HTTP 400 bad request', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { message: 'Bad request' } }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    await expect(makeProvider().createMessage(baseRequest())).rejects.toThrow(/400/);
  });

  it('retries on HTTP 429 then succeeds', async () => {
    let callCount = 0;
    fetchMock.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(
          new Response('Rate limited', {
            status: 429,
            headers: { 'Content-Type': 'text/plain' },
          }),
        );
      }
      return Promise.resolve(makeAnthropicSseResponse(textSseEvents('Retry success')));
    });

    const result = await makeProvider().createMessage(baseRequest());
    expect(callCount).toBe(2);
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'Retry success' });
  });

  it('retries on network failure then succeeds', async () => {
    let callCount = 0;
    fetchMock.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error('Network timeout'));
      // A failure to connect is not a streaming failure: the retry streams again.
      return Promise.resolve(makeAnthropicSseResponse(textSseEvents('Recovered')));
    });

    const result = await makeProvider().createMessage(baseRequest());
    expect(callCount).toBe(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string).stream).toBe(true);
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'Recovered' });
  });

  it('respects Retry-After header on 429', async () => {
    let callCount = 0;
    fetchMock.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(
          new Response('', {
            status: 429,
            headers: { 'Retry-After': '0' },
          }),
        );
      }
      return Promise.resolve(makeAnthropicSseResponse(textSseEvents('After retry')));
    });

    const result = await makeProvider().createMessage(baseRequest());
    expect(callCount).toBe(2);
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'After retry' });
  });

  it('uses baseUrl override', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(makeAnthropicSseResponse(textSseEvents('ok'))),
    );

    await makeProvider({ baseUrl: 'https://my-proxy.example.com' }).createMessage(baseRequest());

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://my-proxy.example.com/v1/messages');
  });

  it('does not inject token-efficient tools through the removed provider option', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(makeAnthropicSseResponse(textSseEvents('ok'))),
    );

    await makeProvider().createMessage(baseRequest({
      providerOptions: { enableTokenEfficientTools: true },
    }));

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = options.headers as Record<string, string>;
    expect(headers['anthropic-beta']).toBeUndefined();
    const body = JSON.parse(options.body as string);
    expect(body).not.toHaveProperty('enableTokenEfficientTools');
  });

  it('preserves an explicitly supplied caller beta', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(makeAnthropicSseResponse(textSseEvents('ok'))),
    );

    await makeProvider({ betas: ['caller-feature-2099-01-01'] })
      .createMessage(baseRequest());

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = options.headers as Record<string, string>;
    expect(headers['anthropic-beta']).toBe('caller-feature-2099-01-01');
  });

  it('sends stable effort and caching without opting adaptive thinking into legacy betas', async () => {
    fetchMock.mockResolvedValue(makeAnthropicSseResponse(textSseEvents('ok')));
    await makeProvider().createMessage(baseRequest({
      systemPrompt: 'Keep the existing task instructions.',
      thinking: { type: 'adaptive' },
      providerOptions: { effort: 'high' },
    }));
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((options.headers as Record<string, string>)['anthropic-beta']).toBeUndefined();
    const body = JSON.parse(options.body as string);
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config.effort).toBe('high');
    expect(body.system[0]).toMatchObject({ text: 'Keep the existing task instructions.', cache_control: { type: 'ephemeral' } });
  });

  it('retains interleaved thinking opt-in for explicitly budgeted thinking', async () => {
    fetchMock.mockResolvedValue(makeAnthropicSseResponse(textSseEvents('ok')));
    await makeProvider().createMessage(baseRequest({ thinking: { type: 'enabled', budgetTokens: 512 } }));
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((options.headers as Record<string, string>)['anthropic-beta']).toBe('interleaved-thinking-2025-05-14');
    expect(JSON.parse(options.body as string).thinking).toEqual({ type: 'enabled', budget_tokens: 512 });
  });

  it('encodes a total-only task budget without mutating the caller', async () => {
    fetchMock.mockResolvedValue(makeAnthropicSseResponse(textSseEvents('ok')));
    const budget = Object.freeze({ total: 10000 });
    await makeProvider().createMessage(baseRequest({ providerOptions: { taskBudget: budget, effort: 'high' } }));
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((options.headers as Record<string, string>)['anthropic-beta']).toBe('task-budgets-2026-03-13');
    expect(JSON.parse(options.body as string).output_config).toEqual({
      effort: 'high', task_budget: { type: 'tokens', total: 10000 },
    });
    expect(budget).toEqual({ total: 10000 });
  });

  it.each([8000, 0, null])('preserves an explicit remaining task budget of %s', async (remaining) => {
    fetchMock.mockResolvedValue(makeAnthropicSseResponse(textSseEvents('ok')));
    const budget = Object.freeze({ type: 'tokens', total: 10000, remaining });
    await makeProvider().createMessage(baseRequest({ providerOptions: { taskBudget: budget } }));
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((options.headers as Record<string, string>)['anthropic-beta']).toBe('task-budgets-2026-03-13');
    expect(JSON.parse(options.body as string).output_config.task_budget).toEqual(budget);
  });

  it('omits task-budget fields and the beta when no budget was requested', async () => {
    fetchMock.mockResolvedValue(makeAnthropicSseResponse(textSseEvents('ok')));
    await makeProvider().createMessage(baseRequest({ providerOptions: { effort: 'high' } }));
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((options.headers as Record<string, string>)['anthropic-beta']).toBeUndefined();
    expect(JSON.parse(options.body as string).output_config).toEqual({ effort: 'high' });
  });

  it('includes beta headers when configured', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(makeAnthropicSseResponse(textSseEvents('ok'))),
    );

    await makeProvider({ betas: ['interleaved-thinking-2025-05-14', 'context-1m-2025-08-07'] })
      .createMessage(baseRequest());

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = options.headers as Record<string, string>;
    expect(headers['anthropic-beta']?.split(',')).toEqual([
      'interleaved-thinking-2025-05-14', 'context-1m-2025-08-07',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Request body construction (tested via fetch mock call inspection)
// ---------------------------------------------------------------------------

describe('buildRequestBody', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation(() =>
      Promise.resolve(makeAnthropicSseResponse(textSseEvents('ok'))),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  async function captureBody(req: ProviderRequest) {
    await makeProvider().createMessage(req);
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    return JSON.parse(options.body as string);
  }

  it('includes temperature, topP, topK when set', async () => {
    const body = await captureBody(baseRequest({ temperature: 0.7, topP: 0.9, topK: 40 }));
    expect(body.temperature).toBe(0.7);
    expect(body.top_p).toBe(0.9);
    expect(body.top_k).toBe(40);
  });

  it('sends temperature:1 by default, omits topP/topK when not set', async () => {
    // G-1: when thinking is disabled, temperature defaults to 1 (not omitted).
    // topP and topK are still omitted when not provided.
    const body = await captureBody(baseRequest());
    expect(body.temperature).toBe(1);
    expect(body.top_p).toBeUndefined();
    expect(body.top_k).toBeUndefined();
  });

  it('includes stop_sequences when non-empty', async () => {
    const body = await captureBody(baseRequest({ stopSequences: ['<|end|>', '###'] }));
    expect(body.stop_sequences).toEqual(['<|end|>', '###']);
  });

  it('omits stop_sequences when empty array', async () => {
    const body = await captureBody(baseRequest({ stopSequences: [] }));
    expect(body.stop_sequences).toBeUndefined();
  });

  it('serializes tools in request body', async () => {
    const body = await captureBody(
      baseRequest({
        tools: [
          { name: 'read_file', description: 'Read a file', input_schema: { type: 'object', properties: {} } },
        ],
      }),
    );
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]).toMatchObject({
      name: 'read_file',
      description: 'Read a file',
      input_schema: { type: 'object' },
    });
  });

  it('omits tools key when tools array is empty', async () => {
    const body = await captureBody(baseRequest({ tools: [] }));
    expect(body.tools).toBeUndefined();
  });

  it('sets thinking.type=enabled with budget_tokens clamped to maxTokens-1', async () => {
    // G-2: budget_tokens must be <= max_tokens - 1. baseRequest uses maxTokens:1024,
    // so budgetTokens:8000 is clamped to 1023.
    const body = await captureBody(
      baseRequest({ thinking: { type: 'enabled', budgetTokens: 8000 } }),
    );
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 1023 });
  });

  it('sends adaptive thinking as requested, whatever the model', async () => {
    const body = await captureBody(baseRequest({ thinking: { type: 'adaptive' } }));
    expect(body.thinking).toEqual({ type: 'adaptive' });
  });

  it('sends a budget as requested, whatever the model', async () => {
    const body = await captureBody(
      baseRequest({ model: 'glm-4.6', thinking: { type: 'enabled', budgetTokens: 500 } }),
    );
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 500 });
  });

  it('sends max_tokens as requested, without a model-name cap', async () => {
    const body = await captureBody(baseRequest({ model: 'deepseek-chat', maxTokens: 64_000 }));
    expect(body.max_tokens).toBe(64_000);
  });

  it('sends an explicit disabled mode instead of relying on provider defaults', async () => {
    const body = await captureBody(baseRequest({ thinking: { type: 'disabled' } }));
    expect(body.thinking).toEqual({ type: 'disabled' });
  });

  it('preserves provider defaults when no thinking mode is requested', async () => {
    const body = await captureBody(baseRequest());
    expect(body.thinking).toBeUndefined();
  });

  it('wraps string system prompt in a block with cache_control', async () => {
    // G-6: when caching is enabled (default), system prompts get cache_control.
    const body = await captureBody(baseRequest({ systemPrompt: 'You are a helpful assistant.' }));
    expect(body.system).toEqual([
      { type: 'text', text: 'You are a helpful assistant.', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('adds cache_control to last block of system prompt array', async () => {
    const blocks = [{ type: 'text', text: 'Block system prompt' }];
    const body = await captureBody(baseRequest({ systemPrompt: blocks as any }));
    // cache_control is appended to the last block
    expect(body.system).toEqual([
      { type: 'text', text: 'Block system prompt', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('passes system prompt unchanged when caching disabled', async () => {
    const body = await captureBody(
      baseRequest({
        systemPrompt: 'You are a helpful assistant.',
        providerOptions: { enableCaching: false },
      }),
    );
    expect(body.system).toBe('You are a helpful assistant.');
  });
});

// ---------------------------------------------------------------------------
// normalizeMessages (tested via request body inspection)
// ---------------------------------------------------------------------------

describe('normalizeMessages', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation(() =>
      Promise.resolve(makeAnthropicSseResponse(textSseEvents('ok'))),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  async function captureMessages(messages: Message[]) {
    await makeProvider().createMessage(baseRequest({ messages }));
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    return JSON.parse(options.body as string).messages as unknown[];
  }

  it('wraps string content in a block with cache_control', async () => {
    // G-6: single-message conversations get a cache breakpoint on the last message.
    // String content is converted to a text block with cache_control.
    const msgs = await captureMessages([{ role: 'user', content: 'Hello string' }]);
    expect(msgs[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'Hello string', cache_control: { type: 'ephemeral' } }],
    });
  });

  it('maps text ContentBlock array', async () => {
    const msgs = await captureMessages([
      {
        role: 'user',
        content: [{ type: 'text', text: 'Block text' }] as ContentBlock[],
      },
    ]);
    expect(msgs[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'Block text' }],
    });
  });

  it('serializes thinking block with signature', async () => {
    const msgs = await captureMessages([
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'deep thoughts', signature: 'sig_123' } as ContentBlock],
      },
    ]);
    const block = (msgs[0] as any).content[0];
    expect(block.type).toBe('thinking');
    expect(block.thinking).toBe('deep thoughts');
    expect(block.signature).toBe('sig_123');
  });

  it('serializes thinking block without signature (omits key)', async () => {
    const msgs = await captureMessages([
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'thoughts' } as ContentBlock],
      },
    ]);
    const block = (msgs[0] as any).content[0];
    expect(block.signature).toBeUndefined();
  });

  it('serializes tool_use block', async () => {
    const msgs = await captureMessages([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: { cmd: 'ls' } } as ContentBlock],
      },
    ]);
    const block = (msgs[0] as any).content[0];
    expect(block).toMatchObject({ type: 'tool_use', id: 'tu_1', name: 'bash', input: { cmd: 'ls' } });
  });

  it('serializes tool_result block', async () => {
    const msgs = await captureMessages([
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_1',
            content: 'file contents',
          } as unknown as ContentBlock,
        ],
      },
    ]);
    const block = (msgs[0] as any).content[0];
    expect(block).toMatchObject({ type: 'tool_result', tool_use_id: 'tu_1', content: 'file contents' });
    expect(block.is_error).toBeUndefined();
  });

  it('serializes tool_result is_error flag', async () => {
    const msgs = await captureMessages([
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_1',
            content: 'error msg',
            is_error: true,
          } as unknown as ContentBlock,
        ],
      },
    ]);
    const block = (msgs[0] as any).content[0];
    expect(block.is_error).toBe(true);
  });

  it('serializes image block', async () => {
    const source = { type: 'base64', media_type: 'image/png', data: 'abc123' };
    const msgs = await captureMessages([
      {
        role: 'user',
        content: [{ type: 'image', source } as unknown as ContentBlock],
      },
    ]);
    const block = (msgs[0] as any).content[0];
    expect(block).toMatchObject({ type: 'image', source });
  });

  it('serializes document block', async () => {
    const source = { type: 'base64', media_type: 'application/pdf', data: 'pdfdata' };
    const msgs = await captureMessages([
      {
        role: 'user',
        content: [{ type: 'document', source } as unknown as ContentBlock],
      },
    ]);
    const block = (msgs[0] as any).content[0];
    expect(block).toMatchObject({ type: 'document', source });
  });

  // Prompt caching — cache_control passthrough
  it('preserves cache_control on text block', async () => {
    const cc = { type: 'ephemeral' };
    const msgs = await captureMessages([
      {
        role: 'user',
        content: [{ type: 'text', text: 'cached', cache_control: cc } as unknown as ContentBlock],
      },
    ]);
    const block = (msgs[0] as any).content[0];
    expect(block.cache_control).toEqual(cc);
    expect(block.text).toBe('cached');
  });

  it('preserves cache_control on tool_use block', async () => {
    const cc = { type: 'ephemeral' };
    const msgs = await captureMessages([
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'bash', input: {}, cache_control: cc } as unknown as ContentBlock,
        ],
      },
    ]);
    const block = (msgs[0] as any).content[0];
    expect(block.cache_control).toEqual(cc);
  });

  it('preserves cache_control on tool_result block', async () => {
    const cc = { type: 'ephemeral' };
    const msgs = await captureMessages([
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_1',
            content: 'result text',
            cache_control: cc,
          } as unknown as ContentBlock,
        ],
      },
    ]);
    const block = (msgs[0] as any).content[0];
    expect(block.cache_control).toEqual(cc);
  });

  it('does NOT add cache_control to thinking blocks', async () => {
    // Thinking blocks cannot carry cache_control per Anthropic API contract
    const msgs = await captureMessages([
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: 'deep thought',
            signature: 'sig_abc',
            cache_control: { type: 'ephemeral' },
          } as unknown as ContentBlock,
        ],
      },
    ]);
    const block = (msgs[0] as any).content[0];
    expect(block.type).toBe('thinking');
    // cache_control intentionally omitted for thinking blocks
    expect(block.cache_control).toBeUndefined();
  });

  it('preserves cache_control on image block', async () => {
    const cc = { type: 'ephemeral' };
    const source = { type: 'base64', media_type: 'image/png', data: 'abc' };
    const msgs = await captureMessages([
      {
        role: 'user',
        content: [{ type: 'image', source, cache_control: cc } as unknown as ContentBlock],
      },
    ]);
    const block = (msgs[0] as any).content[0];
    expect(block.cache_control).toEqual(cc);
  });
});

// ---------------------------------------------------------------------------
// createMessageStream() — streaming generator
// ---------------------------------------------------------------------------

describe('createMessageStream()', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('yields message_start, content events, message_delta, message_stop', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(makeAnthropicSseResponse(textSseEvents('Stream text'))),
    );

    const events = await collectStream(makeProvider().createMessageStream(baseRequest()));

    const types = events.map((e) => e.type);
    expect(types).toContain('message_start');
    expect(types).toContain('content_block_start');
    expect(types).toContain('text_delta');
    expect(types).toContain('content_block_stop');
    expect(types).toContain('message_delta');
    expect(types).toContain('message_stop');
  });

  it('terminates after message_stop without waiting for stream close', async () => {
    // SSE stream without [DONE] — message_stop should terminate early
    const encoder = new TextEncoder();
    const events = textSseEvents('Early stop');
    const lines = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');

    let streamClosed = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(lines));
        // Intentionally do NOT close — simulates a provider that keeps connection open
      },
      cancel() {
        streamClosed = true;
      },
    });
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })),
    );

    const events2 = await collectStream(makeProvider().createMessageStream(baseRequest()));
    const lastType = events2[events2.length - 1]?.type;
    expect(lastType).toBe('message_stop');
    expect(streamClosed).toBe(true);
    expect(stream.locked).toBe(false);
  });

  it('yields tool call events for a tool_use response', async () => {
    const toolEvents = [
      {
        type: 'message_start',
        message: { id: 'msg-t', model: 'claude-test', content: [], usage: { input_tokens: 5, output_tokens: 1 } },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_x', name: 'glob', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"pattern":"**"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } },
      { type: 'message_stop' },
    ];
    fetchMock.mockImplementation(() => Promise.resolve(makeAnthropicSseResponse(toolEvents)));

    const events = await collectStream(makeProvider().createMessageStream(baseRequest()));
    const inputJsonDelta = events.find((e) => e.type === 'input_json_delta') as any;
    expect(inputJsonDelta).toBeDefined();
    expect(inputJsonDelta.partialJson).toBe('{"pattern":"**"}');
  });

  it('yields thinking_delta and signature_delta events', async () => {
    const thinkEvents = [
      {
        type: 'message_start',
        message: { id: 'msg-th', model: 'claude-test', content: [], usage: { input_tokens: 5, output_tokens: 1 } },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Thinking hard' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig_XYZ' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } },
      { type: 'message_stop' },
    ];
    fetchMock.mockImplementation(() => Promise.resolve(makeAnthropicSseResponse(thinkEvents)));

    const events = await collectStream(makeProvider().createMessageStream(baseRequest()));
    const thinkingDelta = events.find((e) => e.type === 'thinking_delta') as any;
    expect(thinkingDelta?.thinking).toBe('Thinking hard');

    const sigDelta = events.find((e) => e.type === 'signature_delta') as any;
    expect(sigDelta?.signature).toBe('sig_XYZ');
  });

  it('classifies a terminal SSE error without yielding a second-layer retry signal', async () => {
    const errorEvents = [
      { type: 'error', error: { type: 'authentication_error', message: 'Invalid credential' } },
    ];
    fetchMock.mockImplementation(() => Promise.resolve(makeAnthropicSseResponse(errorEvents)));

    await expect(collectStream(makeProvider().createMessageStream(baseRequest()))).rejects.toMatchObject({
      message: 'Invalid credential', statusCode: 401, retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('createMessage() throws when stream contains an error event', async () => {
    const errorEvents = [
      { type: 'error', error: { type: 'overloaded_error', message: 'API overloaded' } },
    ];
    fetchMock.mockImplementation(() => Promise.resolve(makeAnthropicSseResponse(errorEvents)));

    await expect(makeProvider().createMessage(baseRequest({ providerOptions: { querySource: 'background' } })))
      .rejects.toMatchObject({ message: 'API overloaded', retryable: true, retriesExhausted: true });
  });

  it('skips ping events (no yield)', async () => {
    const events = [
      { type: 'ping' },
      ...textSseEvents('After ping'),
    ];
    fetchMock.mockImplementation(() => Promise.resolve(makeAnthropicSseResponse(events)));

    const collected = await collectStream(makeProvider().createMessageStream(baseRequest()));
    const types = collected.map((e) => e.type);
    expect(types).not.toContain('ping');
    expect(types).toContain('message_start');
  });

  it('throws immediately on AbortError without retrying', async () => {
    const ac = new AbortController();
    ac.abort();

    fetchMock.mockImplementation(() => Promise.reject(Object.assign(new Error('abort'), { name: 'AbortError' })));

    await expect(
      collectStream(makeProvider().createMessageStream(baseRequest({ providerOptions: { signal: ac.signal } }))),
    ).rejects.toThrow();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('handles message_delta with no usage gracefully', async () => {
    const events = [
      {
        type: 'message_start',
        message: { id: 'msg-nu', model: 'claude-test', content: [], usage: { input_tokens: 5, output_tokens: 0 } },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, // no usage field
      { type: 'message_stop' },
    ];
    fetchMock.mockImplementation(() => Promise.resolve(makeAnthropicSseResponse(events)));

    const collected = await collectStream(makeProvider().createMessageStream(baseRequest()));
    const msgDelta = collected.find((e) => e.type === 'message_delta') as any;
    expect(msgDelta.usage).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listModels()
// ---------------------------------------------------------------------------

describe('listModels()', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('returns model list from API when successful', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              { id: 'claude-opus-4-5', display_name: 'Claude Opus 4.5' },
              { id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    const models = await makeProvider().listModels();
    expect(models.length).toBeGreaterThanOrEqual(2);
    const opus = models.find((m) => m.id === 'claude-opus-4-5');
    expect(opus).toBeDefined();
    expect(opus?.name).toBe('Claude Opus 4.5');
    expect(opus?.providerId).toBe('anthropic');
    expect(opus?.contextWindow).toBe(200_000);
  });

  it('returns an empty list when no API key configured', async () => {
    const provider = makeProvider({ apiKey: '' });
    const models = await provider.listModels();
    expect(models).toEqual([]);
    // Should not have called fetch
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns an empty list on HTTP error', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response('Forbidden', { status: 403 })),
    );

    const models = await makeProvider().listModels();
    expect(models).toEqual([]);
  });

  it('returns an empty list on network failure', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error('DNS failure')));

    const models = await makeProvider().listModels();
    expect(models).toEqual([]);
  });

  it('returns an empty list when API returns empty data array', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const models = await makeProvider().listModels();
    expect(models).toEqual([]);
  });

  it('uses GET request and excludes content-type header', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: [{ id: 'claude-test' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    await makeProvider().listModels();

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/models?limit=100');
    expect((options.method as string).toUpperCase()).toBe('GET');
    const headers = options.headers as Record<string, string>;
    expect(headers['content-type']).toBeUndefined();
    expect(headers['x-api-key']).toBe('test-sk-anthropic');
  });
});

// ---------------------------------------------------------------------------
// healthCheck()
// ---------------------------------------------------------------------------

describe('healthCheck()', () => {
  it('returns healthy when API key is configured', async () => {
    const status = await makeProvider().healthCheck();
    expect(status.status).toBe('healthy');
    expect(status.reason).toBeUndefined();
  });

  it('returns unavailable when no API key', async () => {
    const status = await makeProvider({ apiKey: '' }).healthCheck();
    expect(status.status).toBe('unavailable');
    expect(status.reason).toMatch(/api key/i);
  });
});

// ---------------------------------------------------------------------------
// Structured output
// ---------------------------------------------------------------------------

