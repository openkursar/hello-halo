/**
 * Unit tests for openai-compat.ts
 *
 * Covers:
 * - Request building (toOpenAiMessages: string/block content, system prompt, tools)
 * - Non-streaming response parsing (text, tool_calls, usage, finish_reason)
 * - Streaming event sequence (text, tool calls, reasoning, think-tag parsing)
 * - Provider quirks (toolIdMaxLen, toolIdAlphanumericOnly, fixToolUserSequence,
 *   includeUsageInStream, reasoningField, defaultTemperature)
 * - Error handling (HTTP errors, retries, abort)
 * - listModels / healthCheck
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAiCompatProvider } from './openai-compat.js';
import type { ProviderRequest, Message, ContentBlock, TextBlock, ToolUseBlock, ToolResultBlock } from '../types/provider.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProvider(overrides: Partial<ConstructorParameters<typeof OpenAiCompatProvider>[0]> = {}) {
  return new OpenAiCompatProvider({
    id: 'test',
    name: 'Test Provider',
    baseUrl: 'https://api.test.com/v1',
    apiKey: 'test-key',
    defaultModel: 'gpt-test',
    ...overrides,
  });
}

/** Build a mock non-streaming JSON response. */
function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Build a mock SSE streaming response from data lines. */
function makeSseResponse(lines: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const data = lines.join('') + 'data: [DONE]\n\n';
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(data));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/** Encode a single SSE data line. */
function sseData(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/** Collect all events from an async generator. */
async function collectStream<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const evt of gen) {
    events.push(evt);
  }
  return events;
}

/** Base request used by most tests. */
function baseRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: 'gpt-test',
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
  it('returns expected defaults without reasoningField', () => {
    const provider = makeProvider();
    const caps = provider.capabilities();
    expect(caps.streaming).toBe(true);
    expect(caps.toolCalling).toBe(true);
    expect(caps.thinking).toBe(false);
    expect(caps.imageInput).toBe(true);
    expect(caps.pdfInput).toBe(false);
    expect(caps.systemPromptStyle).toBe('system_message');
  });

  it('sets thinking=true when reasoningField quirk is set', () => {
    const provider = makeProvider({ quirks: { reasoningField: 'reasoning_content' } });
    expect(provider.capabilities().thinking).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Non-streaming: createMessage
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

  it('builds correct request body with text-only response', async () => {
    const responseBody = {
      id: 'chatcmpl-1',
      model: 'gpt-test',
      choices: [{ message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    fetchMock.mockResolvedValue(makeJsonResponse(responseBody));

    const provider = makeProvider();
    const result = await provider.createMessage(baseRequest({
      messages: [{ role: 'user', content: 'Hi' }],
    }));

    expect(result.id).toBe('chatcmpl-1');
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'Hello!' });
    expect(result.stopReason).toBe('end_turn');
    expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 5 });

    // Verify the outgoing request body
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test.com/v1/chat/completions');
    const body = JSON.parse(options.body as string);
    expect(body.model).toBe('gpt-test');
    expect(body.stream).toBe(false);
    expect(body.max_tokens).toBe(1024);
    expect(body.messages).toEqual([{ role: 'user', content: 'Hi' }]);
  });

  it('sends Authorization header with API key', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({
      id: 'x', model: 'gpt-test',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: {},
    }));

    await makeProvider().createMessage(baseRequest());

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = options.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-key');
    expect(headers['Content-Type']).toBe('application/json');
    expect(Object.keys(headers).some(key => key.toLowerCase().startsWith('anthropic-'))).toBe(false);
  });

  it('parses tool_calls from non-streaming response', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({
      id: 'c1', model: 'gpt-test',
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_abc',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 20, completion_tokens: 8 },
    }));

    const result = await makeProvider().createMessage(baseRequest());

    expect(result.stopReason).toBe('tool_use');
    const toolBlock = result.content.find(b => b.type === 'tool_use') as ToolUseBlock;
    expect(toolBlock).toBeDefined();
    expect(toolBlock.name).toBe('get_weather');
    expect(toolBlock.id).toBe('call_abc');
    expect(toolBlock.input).toEqual({ city: 'Tokyo' });
  });

  it('maps finish_reason: length → max_tokens', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({
      id: 'c2', model: 'gpt-test',
      choices: [{ message: { content: 'truncated' }, finish_reason: 'length' }],
      usage: {},
    }));
    const result = await makeProvider().createMessage(baseRequest());
    expect(result.stopReason).toBe('max_tokens');
  });

  it('maps finish_reason: content_filter → content_filtered', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({
      id: 'c3', model: 'gpt-test',
      choices: [{ message: { content: '' }, finish_reason: 'content_filter' }],
      usage: {},
    }));
    const result = await makeProvider().createMessage(baseRequest());
    expect(result.stopReason).toBe('content_filtered');
  });

  it('includes tools in request body', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({
      id: 'x', model: 'gpt-test',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: {},
    }));

    await makeProvider().createMessage(baseRequest({
      tools: [{ name: 'search', description: 'Search the web', input_schema: { type: 'object', properties: {} } }],
    }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]).toMatchObject({
      type: 'function',
      function: { name: 'search', description: 'Search the web' },
    });
  });

  it('includes temperature when specified', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({
      id: 'x', model: 'gpt-test',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: {},
    }));

    await makeProvider().createMessage(baseRequest({ temperature: 0.7 }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.temperature).toBe(0.7);
  });

  it('falls back to defaultTemperature quirk when no temperature in request', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({
      id: 'x', model: 'gpt-test',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: {},
    }));

    const provider = makeProvider({ quirks: { defaultTemperature: 0.0 } });
    await provider.createMessage(baseRequest());

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.temperature).toBe(0.0);
  });

  it('passes reasoning_effort from providerOptions for o-series models', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({
      id: 'x', model: 'o3-mini',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: {},
    }));

    // o3-mini is an o-series model — reasoning_effort should be included
    await makeProvider().createMessage(baseRequest({
      model: 'o3-mini',
      providerOptions: { reasoning_effort: 'high' },
    }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.reasoning_effort).toBe('high');
  });

  it('does NOT send reasoning_effort for non-o-series models', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({
      id: 'x', model: 'gpt-4o',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: {},
    }));

    // gpt-4o is not an o-series model — reasoning_effort must be omitted
    await makeProvider().createMessage(baseRequest({
      model: 'gpt-4o',
      providerOptions: { reasoning_effort: 'high' },
    }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('forwards reasoning effort when the compatible provider explicitly supports it', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({
      id: 'effort', model: 'glm-5.3-flash', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {},
    }));
    await makeProvider({ quirks: { reasoningEffort: true } }).createMessage(baseRequest({
      model: 'glm-5.3-flash', providerOptions: { reasoning_effort: 'low' },
    }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).reasoning_effort).toBe('low');
  });

  it('uses max_completion_tokens for o-series models', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({
      id: 'x', model: 'o1',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: {},
    }));

    await makeProvider().createMessage(baseRequest({
      model: 'o1',
      maxTokens: 2048,
    }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // o-series: max_completion_tokens instead of max_tokens
    expect(body.max_completion_tokens).toBe(2048);
    expect(body.max_tokens).toBeUndefined();
  });

  it('uses max_tokens for non-o-series models', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({
      id: 'x', model: 'gpt-4o',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: {},
    }));

    await makeProvider().createMessage(baseRequest({
      model: 'gpt-4o',
      maxTokens: 2048,
    }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.max_tokens).toBe(2048);
    expect(body.max_completion_tokens).toBeUndefined();
  });

  it('omits temperature for o-series models', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({
      id: 'x', model: 'o4-mini',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: {},
    }));

    await makeProvider().createMessage(baseRequest({
      model: 'o4-mini',
      temperature: 0.7,
    }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // temperature must be omitted for o-series even when explicitly passed
    expect(body.temperature).toBeUndefined();
  });

  it('throws on 4xx non-retryable error', async () => {
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ error: { message: 'Invalid API key' } }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    ));

    const provider = makeProvider();
    await expect(provider.createMessage(baseRequest())).rejects.toThrow(/Invalid API key/);
  });

  it('retries on 429 and succeeds on second attempt', async () => {
    const okResponse = makeJsonResponse({
      id: 'x', model: 'gpt-test',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      usage: {},
    });
    fetchMock
      .mockResolvedValueOnce(new Response('rate limited', { status: 429, headers: {} }))
      .mockResolvedValueOnce(okResponse);

    const provider = makeProvider();
    const result = await provider.createMessage(baseRequest());
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'ok' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fills empty content with placeholder text block', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({
      id: 'x', model: 'gpt-test',
      choices: [{ message: { role: 'assistant', content: null }, finish_reason: 'stop' }],
      usage: {},
    }));

    const result = await makeProvider().createMessage(baseRequest());
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({ type: 'text', text: '' });
  });

  it.each([{ prompt_tokens_details: { cached_tokens: 70 } }, { prompt_cache_hit_tokens: 70 }])(
    'separates cached prompt tokens without changing total context usage (%j)', async cache => {
      fetchMock.mockResolvedValue(makeJsonResponse({
        id: 'cached', model: 'gpt-test', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20, ...cache },
      }));
      const result = await makeProvider().createMessage(baseRequest());
      expect(result.usage).toEqual({ input_tokens: 30, output_tokens: 20, cache_read_input_tokens: 70 });
      expect(result.usage.input_tokens + (result.usage.cache_read_input_tokens ?? 0)).toBe(100);
    },
  );

  it('extracts reasoning_content as ThinkingBlock before text (DeepSeek R1 / Kimi style)', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({
      id: 'ds1', model: 'deepseek-r1',
      choices: [{
        message: {
          role: 'assistant',
          reasoning_content: 'I need to think step by step.',
          content: 'The answer is 42.',
        },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 5, completion_tokens: 20 },
    }));

    const result = await makeProvider().createMessage(baseRequest({ model: 'deepseek-r1' }));
    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toMatchObject({ type: 'thinking', thinking: 'I need to think step by step.' });
    expect(result.content[1]).toMatchObject({ type: 'text', text: 'The answer is 42.' });
  });

  it('extracts thinking_content as ThinkingBlock (MiniMax style)', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({
      id: 'mm1', model: 'minimax-text-01',
      choices: [{
        message: {
          role: 'assistant',
          thinking_content: 'Reasoning about the problem.',
          content: 'Here is my response.',
        },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 8, completion_tokens: 12 },
    }));

    const result = await makeProvider().createMessage(baseRequest({ model: 'minimax-text-01' }));
    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toMatchObject({ type: 'thinking', thinking: 'Reasoning about the problem.' });
    expect(result.content[1]).toMatchObject({ type: 'text', text: 'Here is my response.' });
  });

  it('extracts structured delta.thinking with signature (Anthropic-mirroring providers)', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({
      id: 'at1', model: 'some-provider-v1',
      choices: [{
        message: {
          role: 'assistant',
          thinking: { content: 'deep thought', signature: 'sig123' },
          content: 'Result.',
        },
        finish_reason: 'stop',
      }],
      usage: {},
    }));

    const result = await makeProvider().createMessage(baseRequest());
    expect(result.content).toHaveLength(2);
    const thinking = result.content[0] as { type: string; thinking: string; signature: string };
    expect(thinking.type).toBe('thinking');
    expect(thinking.thinking).toBe('deep thought');
    expect(thinking.signature).toBe('sig123');
    expect(result.content[1]).toMatchObject({ type: 'text', text: 'Result.' });
  });

  it('emits only ThinkingBlock when response has reasoning but no text', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({
      id: 'r1', model: 'deepseek-r1',
      choices: [{
        message: {
          role: 'assistant',
          reasoning_content: 'Silent reasoning.',
          content: null,
        },
        finish_reason: 'stop',
      }],
      usage: {},
    }));

    const result = await makeProvider().createMessage(baseRequest({ model: 'deepseek-r1' }));
    // ThinkingBlock should be present even without any text content
    const thinkingBlock = result.content.find(b => b.type === 'thinking');
    expect(thinkingBlock).toMatchObject({ type: 'thinking', thinking: 'Silent reasoning.' });
  });
});

// ---------------------------------------------------------------------------
// Streaming: createMessageStream
// ---------------------------------------------------------------------------

describe('createMessageStream()', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('yields message_start, text deltas, and message_stop for basic text response', async () => {
    const chunks = [
      sseData({ id: 'c1', model: 'gpt-test', choices: [{ delta: { role: 'assistant', content: '' }, finish_reason: null }], usage: null }),
      sseData({ choices: [{ delta: { content: 'Hello' }, finish_reason: null }] }),
      sseData({ choices: [{ delta: { content: ' World' }, finish_reason: null }] }),
      sseData({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
    ];
    fetchMock.mockResolvedValue(makeSseResponse(chunks));

    const provider = makeProvider();
    const events = await collectStream(provider.createMessageStream(baseRequest()));

    const types = events.map(e => e.type);
    expect(types).toContain('message_start');
    expect(types).toContain('text_delta');
    expect(types).toContain('message_stop');

    const textEvents = events.filter(e => e.type === 'text_delta');
    const text = textEvents.map((e: any) => e.text).join('');
    expect(text).toBe('Hello World');
  });

  it('yields content_block_start for tool calls and input_json_delta fragments', async () => {
    const chunks = [
      sseData({ id: 'c2', model: 'gpt-test', choices: [{ delta: { role: 'assistant' }, finish_reason: null }] }),
      sseData({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_x', type: 'function', function: { name: 'search', arguments: '' } }] }, finish_reason: null }] }),
      sseData({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] }, finish_reason: null }] }),
      sseData({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"cats"}' } }] }, finish_reason: null }] }),
      sseData({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    ];
    fetchMock.mockResolvedValue(makeSseResponse(chunks));

    const events = await collectStream(makeProvider().createMessageStream(baseRequest()));

    const blockStart = events.find((e: any) => e.type === 'content_block_start' && e.content_block?.type === 'tool_use') as any;
    expect(blockStart).toBeDefined();
    expect(blockStart.content_block.name).toBe('search');

    const jsonDeltas = events.filter(e => e.type === 'input_json_delta') as any[];
    const assembled = jsonDeltas.map(e => e.partialJson).join('');
    expect(assembled).toBe('{"q":"cats"}');
  });

  it('tool-only response: tool block at index 0, no spurious empty text block', async () => {
    // Pure tool-call response (no text) — tool block must start at index 0,
    // not index 1 (which was caused by a phantom text-block reservation).
    const chunks = [
      sseData({ id: 'tonly', model: 'gpt-test', choices: [{ delta: { role: 'assistant' }, finish_reason: null }] }),
      sseData({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_t', type: 'function', function: { name: 'calc', arguments: '' } }] }, finish_reason: null }] }),
      sseData({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"x":1}' } }] }, finish_reason: null }] }),
      sseData({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    ];
    fetchMock.mockImplementation(() => Promise.resolve(makeSseResponse(chunks)));

    const events = await collectStream(makeProvider().createMessageStream(baseRequest()));

    // No spurious empty text block — only tool_use content_block_start events.
    const textBlockStarts = events.filter(
      (e: any) => e.type === 'content_block_start' && e.content_block?.type === 'text'
    );
    expect(textBlockStarts).toHaveLength(0);

    // Tool block at index 0 (not index 1).
    const toolBlockStart = events.find(
      (e: any) => e.type === 'content_block_start' && e.content_block?.type === 'tool_use'
    ) as any;
    expect(toolBlockStart).toBeDefined();
    expect(toolBlockStart.index).toBe(0);
    expect(toolBlockStart.content_block.name).toBe('calc');

    // input_json_delta events reference index 0.
    const jsonDeltas2 = events.filter((e: any) => e.type === 'input_json_delta') as any[];
    expect(jsonDeltas2.length).toBeGreaterThan(0);
    expect(jsonDeltas2.every((e: any) => e.index === 0)).toBe(true);
  });

  it('text+tool response: text at index 0, tool at index 1', async () => {
    // When text arrives before tool calls, text block must be at 0, tool at 1.
    const chunks = [
      sseData({ id: 'tt1', model: 'gpt-test', choices: [{ delta: { role: 'assistant' }, finish_reason: null }] }),
      sseData({ choices: [{ delta: { content: "I'll search for you." }, finish_reason: null }] }),
      sseData({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_s', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }] }, finish_reason: null }] }),
      sseData({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    ];
    fetchMock.mockImplementation(() => Promise.resolve(makeSseResponse(chunks)));

    const events = await collectStream(makeProvider().createMessageStream(baseRequest()));

    const textBlockStart = events.find(
      (e: any) => e.type === 'content_block_start' && e.content_block?.type === 'text'
    ) as any;
    const toolBlockStart2 = events.find(
      (e: any) => e.type === 'content_block_start' && e.content_block?.type === 'tool_use'
    ) as any;

    expect(textBlockStart).toBeDefined();
    expect(toolBlockStart2).toBeDefined();
    // Text must be at index 0, tool at index 1.
    expect(textBlockStart.index).toBe(0);
    expect(toolBlockStart2.index).toBe(1);
  });

  it('yields reasoning_delta events for reasoning_content field', async () => {
    const chunks = [
      sseData({ id: 'r1', model: 'gpt-test', choices: [{ delta: { role: 'assistant' }, finish_reason: null }] }),
      sseData({ choices: [{ delta: { reasoning_content: 'Let me think...' }, finish_reason: null }] }),
      sseData({ choices: [{ delta: { content: 'Answer.' }, finish_reason: null }] }),
      sseData({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    ];
    fetchMock.mockResolvedValue(makeSseResponse(chunks));

    const provider = makeProvider({ quirks: { reasoningField: 'reasoning_content' } });
    const events = await collectStream(provider.createMessageStream(baseRequest({ model: 'gpt-test' })));

    const reasoningEvt = events.find(e => e.type === 'reasoning_delta') as any;
    expect(reasoningEvt).toBeDefined();
    expect(reasoningEvt.reasoning).toBe('Let me think...');

    // Should also emit content_block_start for thinking
    const thinkingBlockStart = events.find(
      (e: any) => e.type === 'content_block_start' && e.content_block?.type === 'thinking'
    );
    expect(thinkingBlockStart).toBeDefined();
  });

  it('assigns thinking block index 0 and text block index 1 for reasoning-first responses (DeepSeek R1 style)', async () => {
    // DeepSeek R1: reasoning_content arrives BEFORE content.
    // Lazy block init must assign: thinking=0, text=1 (no collision at index 0).
    const chunks = [
      sseData({ id: 'ds1', model: 'deepseek-r1', choices: [{ delta: { role: 'assistant' }, finish_reason: null }] }),
      sseData({ choices: [{ delta: { reasoning_content: 'step-by-step...' }, finish_reason: null }] }),
      sseData({ choices: [{ delta: { content: 'Final answer.' }, finish_reason: null }] }),
      sseData({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    ];
    fetchMock.mockImplementation(() => Promise.resolve(makeSseResponse(chunks)));

    const provider = makeProvider();
    const events = await collectStream(provider.createMessageStream(baseRequest({ model: 'deepseek-r1' })));

    const thinkStart = events.find(
      (e: any) => e.type === 'content_block_start' && e.content_block?.type === 'thinking'
    ) as any;
    const textStart = events.find(
      (e: any) => e.type === 'content_block_start' && e.content_block?.type === 'text'
    ) as any;

    expect(thinkStart).toBeDefined();
    expect(textStart).toBeDefined();
    // thinking block must be at index 0, text block at index 1 (no collision)
    expect(thinkStart.index).toBe(0);
    expect(textStart.index).toBe(1);

    const reasoningDeltas = events.filter(e => e.type === 'reasoning_delta') as any[];
    expect(reasoningDeltas.every((e: any) => e.index === 0)).toBe(true);

    const textDeltas = events.filter(e => e.type === 'text_delta') as any[];
    expect(textDeltas.every((e: any) => e.index === 1)).toBe(true);
    expect(textDeltas.map((e: any) => e.text).join('')).toBe('Final answer.');
  });

  it('detects reasoning via thinking_content field (MiniMax-style)', async () => {
    const chunks = [
      sseData({ id: 'mm1', model: 'minimax-01', choices: [{ delta: { role: 'assistant' }, finish_reason: null }] }),
      sseData({ choices: [{ delta: { thinking_content: 'MiniMax thinking...' }, finish_reason: null }] }),
      sseData({ choices: [{ delta: { content: 'MiniMax answer.' }, finish_reason: null }] }),
      sseData({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    ];
    fetchMock.mockImplementation(() => Promise.resolve(makeSseResponse(chunks)));

    const provider = makeProvider();
    const events = await collectStream(provider.createMessageStream(baseRequest({ model: 'minimax-01' })));

    const reasoningDeltas = events.filter(e => e.type === 'reasoning_delta') as any[];
    expect(reasoningDeltas.length).toBeGreaterThan(0);
    expect(reasoningDeltas.map((e: any) => e.reasoning).join('')).toBe('MiniMax thinking...');

    const thinkingBlock = events.find(
      (e: any) => e.type === 'content_block_start' && e.content_block?.type === 'thinking'
    );
    expect(thinkingBlock).toBeDefined();
  });

  it('handles structured delta.thinking format (content + signature sub-fields)', async () => {
    const chunks = [
      sseData({ id: 'st1', model: 'gpt-test', choices: [{ delta: { role: 'assistant' }, finish_reason: null }] }),
      sseData({ choices: [{ delta: { thinking: { content: 'Structured thinking...' } }, finish_reason: null }] }),
      sseData({ choices: [{ delta: { thinking: { signature: 'sig-abc123' } }, finish_reason: null }] }),
      sseData({ choices: [{ delta: { content: 'Structured answer.' }, finish_reason: null }] }),
      sseData({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    ];
    fetchMock.mockImplementation(() => Promise.resolve(makeSseResponse(chunks)));

    const provider = makeProvider();
    const events = await collectStream(provider.createMessageStream(baseRequest({ model: 'gpt-test' })));

    const reasoningDeltas = events.filter(e => e.type === 'reasoning_delta') as any[];
    expect(reasoningDeltas.length).toBeGreaterThan(0);
    expect(reasoningDeltas.map((e: any) => e.reasoning).join('')).toBe('Structured thinking...');

    const sigDeltas = events.filter(e => e.type === 'signature_delta') as any[];
    expect(sigDeltas.length).toBeGreaterThan(0);
    expect(sigDeltas[0].signature).toBe('sig-abc123');

    const thinkingBlock = events.find(
      (e: any) => e.type === 'content_block_start' && e.content_block?.type === 'thinking'
    );
    expect(thinkingBlock).toBeDefined();
    // Signature events must share the same block index as reasoning events
    expect(sigDeltas[0].index).toBe(reasoningDeltas[0].index);
  });

  it('parses Qwen <think> XML tags via ThinkTagParser', async () => {
    const qwenModel = 'qwen-plus-2025-01-25';
    const chunks = [
      sseData({ id: 'q1', model: qwenModel, choices: [{ delta: { role: 'assistant' }, finish_reason: null }] }),
      sseData({ choices: [{ delta: { content: '<think>reason</think>answer' }, finish_reason: null }] }),
      sseData({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    ];
    fetchMock.mockResolvedValue(makeSseResponse(chunks));

    const provider = makeProvider();
    const events = await collectStream(provider.createMessageStream(baseRequest({ model: qwenModel })));

    const reasoningDeltas = events.filter(e => e.type === 'reasoning_delta') as any[];
    expect(reasoningDeltas.length).toBeGreaterThan(0);
    expect(reasoningDeltas.map((e: any) => e.reasoning).join('')).toBe('reason');

    const textDeltas = events.filter(e => e.type === 'text_delta') as any[];
    expect(textDeltas.map((e: any) => e.text).join('')).toBe('answer');
  });

  it('parses GLM <think> XML tags via ThinkTagParser', async () => {
    const glmModel = 'glm-z1-plus';
    const chunks = [
      sseData({ id: 'g1', model: glmModel, choices: [{ delta: { role: 'assistant' }, finish_reason: null }] }),
      sseData({ choices: [{ delta: { content: '<think>GLM reasoning</think>Final.' }, finish_reason: null }] }),
      sseData({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    ];
    fetchMock.mockResolvedValue(makeSseResponse(chunks));

    const provider = makeProvider();
    const events = await collectStream(provider.createMessageStream(baseRequest({ model: glmModel })));

    const reasoningDeltas = events.filter(e => e.type === 'reasoning_delta') as any[];
    expect(reasoningDeltas.map((e: any) => e.reasoning).join('')).toBe('GLM reasoning');

    const textDeltas = events.filter(e => e.type === 'text_delta') as any[];
    expect(textDeltas.map((e: any) => e.text).join('')).toBe('Final.');
  });

  it('handles usage-only chunk without choices', async () => {
    const chunks = [
      sseData({ id: 'u1', model: 'gpt-test', choices: [{ delta: { content: 'Hi' }, finish_reason: null }] }),
      sseData({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      sseData({ usage: { prompt_tokens: 10, completion_tokens: 3 } }),
    ];
    fetchMock.mockResolvedValue(makeSseResponse(chunks));

    const events = await collectStream(makeProvider().createMessageStream(baseRequest()));
    expect(events).toContainEqual({ type: 'message_delta', usage: { input_tokens: 10, output_tokens: 3 } });
    expect(events.at(-1)).toEqual({ type: 'message_stop' });
  });

  it('preserves cache usage delivered after the streamed answer', async () => {
    fetchMock.mockResolvedValue(makeSseResponse([
      sseData({ id: 'cache-stream', model: 'gpt-test', choices: [{ delta: { content: 'ok' }, finish_reason: null }] }),
      sseData({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      sseData({ usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 70 } } }),
    ]));
    const events = await collectStream(makeProvider().createMessageStream(baseRequest()));
    expect(events).toContainEqual({ type: 'message_delta', usage: { input_tokens: 30, output_tokens: 20, cache_read_input_tokens: 70 } });
    expect(events.at(-1)).toEqual({ type: 'message_stop' });
  });

  it('includes stream_options when includeUsageInStream quirk is set', async () => {
    const chunks = [
      sseData({ id: 'x', model: 'gpt-test', choices: [{ delta: {}, finish_reason: 'stop' }] }),
    ];
    fetchMock.mockResolvedValue(makeSseResponse(chunks));

    const provider = makeProvider({ quirks: { includeUsageInStream: true } });
    await collectStream(provider.createMessageStream(baseRequest()));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it('throws on 4xx error during streaming', async () => {
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ error: { message: 'Unauthorized' } }),
      { status: 401 },
    ));

    const provider = makeProvider();
    await expect(collectStream(provider.createMessageStream(baseRequest()))).rejects.toThrow(/401/);
  });

  it('retries connection on 503 and succeeds', async () => {
    const okChunks = [
      sseData({ id: 'x', model: 'gpt-test', choices: [{ delta: { content: 'ok' }, finish_reason: null }] }),
      sseData({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    ];
    fetchMock
      .mockResolvedValueOnce(new Response('service unavailable', { status: 503 }))
      .mockResolvedValueOnce(makeSseResponse(okChunks));

    const provider = makeProvider();
    const events = await collectStream(provider.createMessageStream(baseRequest()));
    expect(events.some(e => e.type === 'text_delta')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Message conversion: toOpenAiMessages
// ---------------------------------------------------------------------------

describe('toOpenAiMessages via createMessage', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  /** Return a fresh Response on every call (body can only be read once). */
  const okResponseFactory = () => makeJsonResponse({
    id: 'x', model: 'gpt-test',
    choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    usage: {},
  });

  beforeEach(() => {
    fetchMock = vi.fn();
    fetchMock.mockImplementation(() => Promise.resolve(okResponseFactory()));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('converts string message content directly', async () => {

    await makeProvider().createMessage(baseRequest({
      messages: [{ role: 'user', content: 'Hello' }],
    }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages).toContainEqual({ role: 'user', content: 'Hello' });
  });

  it('injects system prompt as first message', async () => {

    await makeProvider().createMessage(baseRequest({
      systemPrompt: 'You are helpful.',
      messages: [{ role: 'user', content: 'Hi' }],
    }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'You are helpful.' });
  });

  it('concatenates system prompt blocks with double newline', async () => {

    await makeProvider().createMessage(baseRequest({
      systemPrompt: [{ type: 'text', text: 'Block one.' }, { type: 'text', text: 'Block two.' }],
      messages: [{ role: 'user', content: 'Hi' }],
    }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages[0].content).toBe('Block one.\n\nBlock two.');
  });

  it('maps assistant tool_use blocks to tool_calls', async () => {

    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me search.' } as TextBlock,
          { type: 'tool_use', id: 'call_1', name: 'search', input: { q: 'cats' } } as ToolUseBlock,
        ],
      },
    ];

    await makeProvider().createMessage(baseRequest({ messages }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const assistantMsg = body.messages[0];
    expect(assistantMsg.role).toBe('assistant');
    expect(assistantMsg.content).toBe('Let me search.');
    expect(assistantMsg.tool_calls).toHaveLength(1);
    expect(assistantMsg.tool_calls[0]).toMatchObject({
      id: 'call_1',
      type: 'function',
      function: { name: 'search', arguments: '{"q":"cats"}' },
    });
  });

  it('maps tool_result blocks to separate tool messages', async () => {

    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'Result text' } as ToolResultBlock,
        ],
      },
    ];

    await makeProvider().createMessage(baseRequest({ messages }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const toolMsg = body.messages.find((m: any) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg.tool_call_id).toBe('call_1');
    expect(toolMsg.content).toBe('Result text');
  });

  it('maps tool_result with ContentBlock[] content to joined text', async () => {

    const messages: Message[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_2',
            content: [{ type: 'text', text: 'Part A' }, { type: 'text', text: 'Part B' }],
          } as ToolResultBlock,
        ],
      },
    ];

    await makeProvider().createMessage(baseRequest({ messages }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const toolMsg = body.messages.find((m: any) => m.role === 'tool');
    expect(toolMsg.content).toBe('Part A\nPart B');
  });

  it('maps image blocks to image_url format', async () => {

    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this:' } as TextBlock,
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } } as ContentBlock,
        ],
      },
    ];

    await makeProvider().createMessage(baseRequest({ messages }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const userMsg = body.messages.find((m: any) => m.role === 'user');
    expect(Array.isArray(userMsg.content)).toBe(true);
    const imgBlock = userMsg.content.find((b: any) => b.type === 'image_url');
    expect(imgBlock.image_url.url).toBe('data:image/png;base64,abc123');
  });

  it('rejects oversized aggregate image payload before sending a request', async () => {
    const messages: Message[] = [{ role: 'user', content: Array.from({ length: 5 }, () => ({
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: 'image/png', data: 'A'.repeat(5 * 1024 * 1024) },
    })) }];
    await expect(makeProvider().createMessage(baseRequest({ messages }))).rejects.toThrow(/Image request exceeds/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards structured tool-result images in OpenAI tool content', async () => {
    const messages: Message[] = [{ role: 'user', content: [{
      type: 'tool_result', tool_use_id: 'call_img', content: [
        { type: 'text', text: 'screenshot' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } },
      ],
    }] }];
    await makeProvider().createMessage(baseRequest({ messages }));
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages[0]).toEqual({ role: 'tool', tool_call_id: 'call_img', content: 'screenshot' });
    expect(body.messages[1]).toEqual({ role: 'user', content: [
      { type: 'text', text: 'Images from tool result call_img:' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aGk=' } },
    ] });
  });
});

// ---------------------------------------------------------------------------
// Quirks
// ---------------------------------------------------------------------------

describe('provider quirks', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  const okResponseFactory = () => makeJsonResponse({
    id: 'x', model: 'gpt-test',
    choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    usage: {},
  });

  beforeEach(() => {
    fetchMock = vi.fn();
    fetchMock.mockImplementation(() => Promise.resolve(okResponseFactory()));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('toolIdMaxLen truncates and pads tool call IDs', async () => {

    const provider = makeProvider({ quirks: { toolIdMaxLen: 6 } });
    const messages: Message[] = [{
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_very_long_id_123', name: 'fn', input: {} } as ToolUseBlock],
    }];

    await provider.createMessage(baseRequest({ messages }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const tc = body.messages[0].tool_calls[0];
    expect(tc.id).toHaveLength(6);
    expect(tc.id).toBe('call_v'); // first 6 chars, pad with 0 if shorter (here exact length)
  });

  it('toolIdAlphanumericOnly strips non-alphanumeric chars', async () => {

    const provider = makeProvider({ quirks: { toolIdAlphanumericOnly: true } });
    const messages: Message[] = [{
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call-xyz_123!', name: 'fn', input: {} } as ToolUseBlock],
    }];

    await provider.createMessage(baseRequest({ messages }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const tc = body.messages[0].tool_calls[0];
    expect(tc.id).toBe('callxyz123');
  });

  it('fixToolUserSequence inserts assistant:Done between tool→user', async () => {

    const provider = makeProvider({ quirks: { fixToolUserSequence: true } });
    const messages: Message[] = [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'result' } as ToolResultBlock],
      },
      { role: 'user', content: 'Follow-up question' },
    ];

    await provider.createMessage(baseRequest({ messages }));

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // Find the injected assistant message
    const assistantDone = body.messages.find((m: any) => m.role === 'assistant' && m.content === 'Done.');
    expect(assistantDone).toBeDefined();
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

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns parsed model list on success', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({
      data: [
        { id: 'gpt-4o', object: 'model' },
        { id: 'gpt-3.5-turbo', object: 'model' },
      ],
    }));

    const models = await makeProvider().listModels();
    expect(models).toHaveLength(2);
    expect(models[0].id).toBe('gpt-4o');
    expect(models[0].providerId).toBe('test');
    expect(typeof models[0].contextWindow).toBe('number');
  });

  it('returns empty array on HTTP error', async () => {
    fetchMock.mockResolvedValue(new Response('error', { status: 500 }));
    const models = await makeProvider().listModels();
    expect(models).toEqual([]);
  });

  it('returns empty array on network failure', async () => {
    fetchMock.mockRejectedValue(new Error('Network error'));
    const models = await makeProvider().listModels();
    expect(models).toEqual([]);
  });

  it('filters out entries without id field', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({
      data: [{ id: 'gpt-4' }, { object: 'model' /* no id */ }],
    }));
    const models = await makeProvider().listModels();
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('gpt-4');
  });
});

// ---------------------------------------------------------------------------
// healthCheck()
// ---------------------------------------------------------------------------

describe('healthCheck()', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns healthy when /models responds 200', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ data: [] }));
    const status = await makeProvider().healthCheck();
    expect(status.status).toBe('healthy');
  });

  it('returns unavailable when no API key for remote provider', async () => {
    const provider = makeProvider({ apiKey: undefined });
    const status = await provider.healthCheck();
    expect(status.status).toBe('unavailable');
    expect(status.reason).toMatch(/API key/);
    // Should not attempt a network call
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns unavailable on network failure', async () => {
    fetchMock.mockRejectedValue(new Error('Connection refused'));
    const status = await makeProvider().healthCheck();
    expect(status.status).toBe('unavailable');
    expect(status.reason).toContain('Connection refused');
  });

  it('allows localhost provider without API key', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ data: [] }));
    const provider = makeProvider({ baseUrl: 'http://localhost:11434/v1', apiKey: undefined });
    const status = await provider.healthCheck();
    // Should actually make the request (no early return for no-api-key check)
    expect(fetchMock).toHaveBeenCalled();
    expect(status.status).toBe('healthy');
  });
});

// ---------------------------------------------------------------------------
// Structured output
// ---------------------------------------------------------------------------

