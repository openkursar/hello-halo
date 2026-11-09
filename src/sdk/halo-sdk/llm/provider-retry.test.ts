/**
 * Retry behaviour shared by the bundled providers: every retried attempt is
 * reported in-band, the server's retry hints decide whether and how long to
 * wait, and a failure that outlives the budget is marked so no caller retries
 * it a second time.
 *
 * Waits are recorded instead of slept, so the full budget runs instantly and
 * the exact delay chosen for each attempt can be asserted.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sleeps: number[] = [];
vi.mock('../utils/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/retry.js')>();
  return {
    ...actual,
    delayForAttempt: (_config: unknown, attempt: number) => 1_000 * 2 ** attempt,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
});

import { AnthropicProvider } from './anthropic.js';
import { OpenAiCompatProvider } from './openai-compat.js';
import { DEFAULT_RETRY } from '../utils/retry.js';
import { queryLoop } from '../core/query-loop.js';
import type { QueryConfig } from '../types/config.js';
import type { SDKMessage } from '../core/query-types.js';
import { PromptToolCallingAdapter } from './tool-calling/prompt-adapter.js';
import { ModelFallbackError, ProviderError } from '../utils/errors.js';
import type { ProviderRequest, StreamEvent, StreamRetryEvent } from '../types/provider.js';

function sse(events: unknown[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function anthropicText(text: string): unknown[] {
  return [
    { type: 'message_start', message: { id: 'msg-1', model: 'm', content: [], usage: { input_tokens: 1, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ];
}

function openAiText(text: string): unknown[] {
  return [
    { id: 'c1', model: 'm', choices: [{ delta: { content: text } }] },
    { id: 'c1', model: 'm', choices: [{ delta: {}, finish_reason: 'stop' }] },
  ];
}

function errorResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function request(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return { model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 64, stream: true, ...overrides };
}

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

async function collectUntilThrow(gen: AsyncGenerator<StreamEvent>): Promise<{ events: StreamEvent[]; error: unknown }> {
  const events: StreamEvent[] = [];
  try {
    for await (const e of gen) events.push(e);
  } catch (error) {
    return { events, error };
  }
  return { events, error: undefined };
}

const retries = (events: StreamEvent[]) =>
  events.filter((e): e is StreamRetryEvent => e.type === 'retry');

const anthropic = () => new AnthropicProvider({ apiKey: 'k', defaultModel: 'm' });
const openAi = () => new OpenAiCompatProvider({ id: 'x', name: 'X', baseUrl: 'https://x.test/v1', apiKey: 'k' });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sleeps.length = 0;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe.each([
  ['AnthropicProvider', anthropic, anthropicText],
  ['OpenAiCompatProvider', openAi, openAiText],
] as const)('%s retries', (_name, makeProvider, textEvents) => {
  it('reports each retried attempt with the status and the server message, then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(errorResponse(503, { error: { message: 'upstream busy' } }))
      .mockResolvedValueOnce(sse(textEvents('ok')));

    const events = await collect(makeProvider().createMessageStream(request()));

    expect(retries(events)).toEqual([
      {
        type: 'retry',
        attempt: 1,
        maxRetries: DEFAULT_RETRY.maxRetries,
        delayMs: sleeps[0],
        status: 503,
        message: 'upstream busy',
      },
    ]);
    expect(sleeps[0]).toBeGreaterThan(0);
    expect(events.indexOf(retries(events)[0])).toBe(0);
    expect(events.some((e) => e.type === 'text_delta')).toBe(true);
  });

  it('waits the server-requested time instead of the backoff, never both', async () => {
    fetchMock
      .mockResolvedValueOnce(errorResponse(429, { error: { message: 'slow down' } }, { 'retry-after': '7' }))
      .mockResolvedValueOnce(sse(textEvents('ok')));

    const events = await collect(makeProvider().createMessageStream(request()));

    expect(sleeps).toEqual([7_000]);
    expect(retries(events)[0].delayMs).toBe(7_000);
  });

  it('does not retry when the server says the request must not be retried', async () => {
    fetchMock.mockResolvedValue(
      errorResponse(429, { error: { message: 'weekly usage limit exceeded' } }, { 'x-should-retry': 'false' }),
    );

    const { events, error } = await collectUntilThrow(makeProvider().createMessageStream(request()));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(retries(events)).toHaveLength(0);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).retryable).toBe(false);
    expect((error as ProviderError).message).toContain('weekly usage limit exceeded');
  });

  it('surfaces a limit whose requested wait exceeds what one request may hold', async () => {
    fetchMock.mockResolvedValue(errorResponse(429, { error: { message: 'quota' } }, { 'retry-after': '3600' }));

    const { error } = await collectUntilThrow(makeProvider().createMessageStream(request()));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
    expect((error as ProviderError).retryable).toBe(false);
  });

  it('marks the failure as retried to exhaustion once the budget is spent', async () => {
    fetchMock.mockImplementation(async () => errorResponse(503, { error: { message: 'down' } }));

    const { events, error } = await collectUntilThrow(makeProvider().createMessageStream(request()));

    expect(fetchMock).toHaveBeenCalledTimes(DEFAULT_RETRY.maxRetries + 1);
    expect(retries(events).map((r) => r.attempt)).toEqual(
      Array.from({ length: DEFAULT_RETRY.maxRetries }, (_, i) => i + 1),
    );
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).retriesExhausted).toBe(true);
    expect((error as ProviderError).statusCode).toBe(503);
  });

  it('reports a connection failure with no status and the underlying cause', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' }),
    });
    fetchMock.mockRejectedValueOnce(refused).mockResolvedValueOnce(sse(textEvents('ok')));

    const events = await collect(makeProvider().createMessageStream(request()));

    expect(retries(events)[0]).toMatchObject({ status: null, message: 'fetch failed (ECONNREFUSED)' });
  });
});

describe.each([
  ['AnthropicProvider', anthropic, anthropicText],
  ['OpenAiCompatProvider', openAi, openAiText],
] as const)('%s retry classification', (_name, makeProvider, textEvents) => {
  it('preserves a positive server retry hint when a non-default status exhausts the budget', async () => {
    fetchMock.mockImplementation(async () => errorResponse(400, { error: { message: 'temporarily busy' } }, { 'x-should-retry': 'true' }));
    const { error } = await collectUntilThrow(makeProvider().createMessageStream(request()));
    expect(error).toMatchObject({ statusCode: 400, retryable: true, retriesExhausted: true });
    expect(fetchMock).toHaveBeenCalledTimes(DEFAULT_RETRY.maxRetries + 1);
  });

  it('does not retry a custom cancellation reason from fetch', async () => {
    const controller = new AbortController();
    const reason = new Error('caller cancelled');
    fetchMock.mockImplementation(async () => { controller.abort(reason); throw reason; });
    const { events, error } = await collectUntilThrow(makeProvider().createMessageStream(request({ providerOptions: { signal: controller.signal } })));
    expect(error).toBe(reason);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(retries(events)).toEqual([]);
  });

  it('cancels pending stream reads without completing or retrying partial content', async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    fetchMock.mockResolvedValue(new Response(body));
    const pending = collectUntilThrow(makeProvider().createMessageStream(request({ providerOptions: { signal: controller.signal } })));
    await vi.waitFor(() => expect(body.locked).toBe(true));
    controller.abort(new Error('stop reading'));
    const { events, error } = await pending;
    expect(error).toMatchObject({ message: 'stop reading' });
    expect(events).toEqual([]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('stops before the next attempt if cancelled after a retry notice', async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValue(errorResponse(503, {}));
    const stream = makeProvider().createMessageStream(request({ providerOptions: { signal: controller.signal } }));
    expect((await stream.next()).value).toMatchObject({ type: 'retry', attempt: 1 });
    controller.abort(new Error('cancel retry'));
    await expect(stream.next()).rejects.toThrow('cancel retry');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('honors non-retryable HTTP headers even when its error body cannot be read', async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('body unavailable')); } });
    fetchMock.mockResolvedValue(new Response(body, { status: 503, headers: { 'x-should-retry': 'false' } }));
    const { error } = await collectUntilThrow(makeProvider().createMessageStream(request()));
    expect(error).toMatchObject({ statusCode: 503, retryable: false });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not mark a later HTTP refusal as pre-response evidence after a stream has already started', async () => {
    fetchMock.mockResolvedValueOnce(sse(textEvents('partial').slice(0, -2)))
      .mockResolvedValueOnce(errorResponse(400, { error: { message: 'max_tokens must be between 1 and 32' } }));
    const { error } = await collectUntilThrow(makeProvider().createMessageStream(request()));
    expect(error).toMatchObject({ statusCode: 400, requestRejected: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('marks a direct HTTP refusal as pre-response evidence', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(400, { error: { message: 'max_tokens must be between 1 and 32' } }));
    const { error } = await collectUntilThrow(makeProvider().createMessageStream(request()));
    expect(error).toMatchObject({ statusCode: 400, requestRejected: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not retry an authentication failure embedded in a successful HTTP stream', async () => {
    fetchMock.mockImplementation(async () => sse([{ type: 'error', error: { type: 'authentication_error', message: 'unauthorized' } }]));
    const { error } = await collectUntilThrow(makeProvider().createMessageStream(request()));
    expect(error).toMatchObject({ statusCode: 401, retryable: false });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('keeps SSE failures and HTTP failures on a single attempt counter', async () => {
    fetchMock.mockResolvedValueOnce(errorResponse(503, { error: { message: 'busy' } }))
      .mockResolvedValueOnce(sse([{ type: 'error', error: { type: 'api_error', message: 'stream busy' } }]))
      .mockResolvedValueOnce(sse(textEvents('recovered')));
    const events = await collect(makeProvider().createMessageStream(request()));
    expect(retries(events).map(({ attempt, status }) => [attempt, status])).toEqual([[1, 503], [2, 500]]);
    expect(events.at(-1)).toEqual({ type: 'message_stop' });
    expect(events.filter((event) => event.type === 'error')).toEqual([]);
  });
});

function queryConfig(overrides: Partial<QueryConfig> = {}): QueryConfig {
  return {
    model: 'm', maxTokens: 64, contextWindow: 200_000, maxTurns: 1, cwd: '/tmp', env: {},
    permissionMode: 'bypassPermissions', systemPrompt: 'Answer the question.',
    thinking: { type: 'disabled' }, abortSignal: new AbortController().signal,
    ...overrides,
  } as QueryConfig;
}

async function collectQuery(stream: AsyncGenerator<SDKMessage>): Promise<SDKMessage[]> {
  const messages: SDKMessage[] = [];
  for await (const message of stream) messages.push(message);
  return messages;
}

describe('real provider and query-loop retry boundary', () => {
  it('does not multiply ten HTTP retries followed by an SSE overload into a second budget', async () => {
    let calls = 0;
    fetchMock.mockImplementation(async () => ++calls % 11 === 0
      ? sse([{ type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } }])
      : errorResponse(503, { error: { message: 'busy' } }));
    const messages = await collectQuery(queryLoop(queryConfig(), anthropic(), [], 'hi'));
    expect(fetchMock).toHaveBeenCalledTimes(11);
    expect(messages.filter((message) => message.type === 'system' && message.subtype === 'api_retry')).toHaveLength(10);
    expect(messages.find((message) => message.type === 'result')).toMatchObject({ is_error: true, subtype: 'error_during_execution' });
    // Only the failure notice, never output of a failed attempt.
    expect(messages.filter((message) => message.type === 'assistant')).toEqual([
      expect.objectContaining({ error: 'server_error', message: expect.objectContaining({ model: '<synthetic>' }) }),
    ]);
  });

  it.each([
    ['Anthropic', anthropic, anthropicText], ['OpenAI', openAi, openAiText],
  ] as const)('switches %s to the fallback after an explicitly retryable HTTP 400 exhausts its budget', async (_name, makeProvider, textEvents) => {
    const models: string[] = [];
    fetchMock.mockImplementation(async (_url, init) => {
      const model = JSON.parse(init.body).model;
      models.push(model);
      return model === 'backup' ? sse(textEvents('backup answer'))
        : errorResponse(400, { error: { message: 'busy' } }, { 'x-should-retry': 'true' });
    });
    const messages = await collectQuery(queryLoop(queryConfig({ fallbackModel: 'backup' }), makeProvider(), [], 'hi'));
    expect(models).toEqual([...Array(11).fill('m'), 'backup']);
    expect(messages.filter((message) => message.type === 'system' && message.subtype === 'model_fallback')).toHaveLength(1);
    expect(messages.find((message) => message.type === 'result')).toMatchObject({ is_error: false, result: 'backup answer' });
  });

  it('never promotes truncated OpenAI text into a successful assistant response', async () => {
    fetchMock.mockImplementation(async () => sse(openAiText('partial').slice(0, 1)));
    const messages = await collectQuery(queryLoop(queryConfig(), openAi(), [], 'hi'));
    expect(fetchMock).toHaveBeenCalledTimes(11);
    const assistants = messages.filter((message) => message.type === 'assistant');
    expect(assistants).toEqual([expect.objectContaining({ error: expect.any(String), message: expect.objectContaining({ model: '<synthetic>' }) })]);
    expect(JSON.stringify(assistants)).not.toContain('partial');
    expect(messages.find((message) => message.type === 'result')).toMatchObject({ is_error: true });
  });

  it('resets text, thinking, tool buffers and usage before a successful OpenAI retry', async () => {
    fetchMock.mockResolvedValueOnce(sse([
      { id: 'failed', choices: [{ delta: { reasoning_content: 'discard thinking' } }] },
      { choices: [{ delta: { content: 'discard text' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'discard_tool', function: { name: 'never_run', arguments: '{' } }] } }] },
      { usage: { prompt_tokens: 999, completion_tokens: 999 } },
    ])).mockResolvedValueOnce(sse([
      ...openAiText('complete answer'),
      { choices: [], usage: { prompt_tokens: 13, completion_tokens: 7 } },
    ]));
    const messages = await collectQuery(queryLoop(queryConfig(), openAi(), [], 'hi'));
    const assistants = messages.filter((message) => message.type === 'assistant');
    expect(assistants.map(message => message.message.id)).toEqual(['failed', 'failed', 'c1']);
    expect(assistants.at(-1)).toMatchObject({ message: {
      id: 'c1', content: [{ type: 'text', text: 'complete answer' }],
    } });
    expect(messages.find(message => message.type === 'result')).toMatchObject({
      result: 'complete answer', usage: { input_tokens: 13, output_tokens: 7 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('OpenAI completion and usage tail', () => {
  it.each(['empty', 'role-only', 'partial-text', 'partial-tool', 'done-only'])('rejects %s EOF without finish_reason', async (kind) => {
    fetchMock.mockImplementation(async () => {
      if (kind === 'done-only') return new Response('data: [DONE]\n\n');
      if (kind === 'empty') return sse([]);
      const delta = kind === 'role-only' ? { role: 'assistant' }
        : kind === 'partial-text' ? { content: 'partial' }
        : { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Search', arguments: '{' } }] };
      return sse([{ choices: [{ delta }] }]);
    });
    const { events, error } = await collectUntilThrow(openAi().createMessageStream(request()));
    expect(events.some((event) => event.type === 'message_stop')).toBe(false);
    expect(error).toMatchObject({ retryable: true, retriesExhausted: true });
    expect(fetchMock).toHaveBeenCalledTimes(11);
  });

  it('accepts finish_reason even when the final choice has no delta', async () => {
    fetchMock.mockResolvedValue(sse([{ choices: [{ finish_reason: 'stop' }] }]));
    expect((await collect(openAi().createMessageStream(request()))).at(-1)).toEqual({ type: 'message_stop' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('reads delayed usage and cancels the still-open response body', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encode = (events: unknown[]) => new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
        controller.enqueue(encode(openAiText('answer')));
        setTimeout(() => controller.enqueue(encode([{ choices: [], usage: { prompt_tokens: 19, completion_tokens: 8 } }])), 100);
      },
      cancel,
    });
    fetchMock.mockResolvedValue(new Response(body));
    const pending = collect(openAi().createMessageStream(request()));
    await vi.advanceTimersByTimeAsync(100);
    const events = await pending;
    expect(events).toContainEqual({ type: 'message_delta', usage: { input_tokens: 19, output_tokens: 8 } });
    expect(events.at(-1)).toEqual({ type: 'message_stop' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('bounds optional tail waiting even when the provider sends endless keepalives and cancel never resolves', async () => {
    vi.useFakeTimers();
    let interval: ReturnType<typeof setInterval>;
    const cancel = vi.fn(() => { clearInterval(interval); return new Promise<void>(() => {}); });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(openAiText('answer').map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')));
        interval = setInterval(() => controller.enqueue(new TextEncoder().encode(': keepalive\n\n')), 50);
      },
      cancel,
    });
    fetchMock.mockResolvedValue(new Response(body));
    const pending = collect(openAi().createMessageStream(request()));
    await vi.advanceTimersByTimeAsync(1_000);
    const events = await pending;
    expect(events.at(-1)).toEqual({ type: 'message_stop' });
    expect(retries(events)).toEqual([]);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not turn caller cancellation during the usage tail into success', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(stream) { stream.enqueue(new TextEncoder().encode(openAiText('answer').map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''))); },
      cancel,
    });
    fetchMock.mockResolvedValue(new Response(body));
    const pending = collectUntilThrow(openAi().createMessageStream(request({ providerOptions: { signal: controller.signal } })));
    await vi.advanceTimersByTimeAsync(10);
    controller.abort(new Error('cancel usage wait'));
    const { events, error } = await pending;
    expect(error).toMatchObject({ message: 'cancel usage wait' });
    expect(events.some((event) => event.type === 'message_stop')).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not replay a completed response when the usage tail disconnects', async () => {
    vi.useFakeTimers();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(openAiText('answer').map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')));
        setTimeout(() => controller.error(new Error('tail disconnected')), 50);
      },
    });
    fetchMock.mockResolvedValue(new Response(body));
    const pending = collect(openAi().createMessageStream(request()));
    await vi.advanceTimersByTimeAsync(50);
    expect((await pending).at(-1)).toEqual({ type: 'message_stop' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe.each(['native', 'xml', 'json'] as const)('real %s adapter output contract', (mode) => {
  it.each([false, true])('keeps streamed text, assistant body and result consistent with partial messages %s', async (includePartialMessages) => {
    const text = '正文<thi';
    const content = '<think>中文推理</think>\n' + text;
    fetchMock.mockResolvedValue(sse([
      ...[...content].map((char) => ({ id: 'body', model: 'qwen-test', choices: [{ delta: { content: char } }] })),
      { choices: [{ finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 21, completion_tokens: 9 } },
    ]));
    const provider = mode === 'native' ? openAi() : new PromptToolCallingAdapter(openAi(), mode);
    const tool = { name: 'Unused', description: 'Unused test tool', inputSchema: { type: 'object' }, permissionLevel: 'none' as const,
      execute: vi.fn(async () => ({ content: '', isError: false })) };
    const messages = await collectQuery(queryLoop(queryConfig({ model: 'qwen-test', includePartialMessages }), provider, [tool], 'hi'));
    const assistants = messages.filter(message => message.type === 'assistant');
    expect(assistants.map(message => message.message.content)).toEqual([
      [{ type: 'thinking', thinking: '中文推理' }], [{ type: 'text', text }],
    ]);
    expect(new Set(assistants.map(message => message.message.id)).size).toBe(1);
    expect(messages.find((message) => message.type === 'result')).toMatchObject({
      is_error: false, result: text, usage: { input_tokens: 21, output_tokens: 9 },
    });
    const streamedText = messages.flatMap((message) => {
      if (message.type !== 'stream_event') return [];
      const event = message.event as unknown as { type: string; delta?: { type: string; text?: string } };
      return event.type === 'content_block_delta' && event.delta?.type === 'text_delta' ? [event.delta.text ?? ''] : [];
    }).join('');
    expect(streamedText).toBe(includePartialMessages ? text : '');
    expect(tool.execute).not.toHaveBeenCalled();
  });
});

describe('AnthropicProvider mid-stream failure', () => {
  /** A stream cut off after the first text delta, then a complete non-streaming answer. */
  function cutThenRecover(): void {
    fetchMock
      .mockResolvedValueOnce(sse(anthropicText('half an ans').slice(0, 3)))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: 'msg-2', model: 'm', content: [{ type: 'text', text: 'full answer' }], stop_reason: 'end_turn' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
  }

  it('announces the retry after the partial output and restarts from message_start', async () => {
    cutThenRecover();

    const events = await collect(anthropic().createMessageStream(request()));
    const retryAt = events.findIndex((e) => e.type === 'retry');

    expect(retryAt).toBeGreaterThan(0);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string).stream).toBe(false);
    expect(events[retryAt + 1].type).toBe('message_start');
  });

  it('keeps none of the failed attempt in the assembled response', async () => {
    cutThenRecover();

    const result = await anthropic().createMessage(request());

    expect(result.content).toEqual([{ type: 'text', text: 'full answer' }]);
  });

  it('keeps fallback thinking and body in both assistant and result after discarding a partial stream', async () => {
    fetchMock.mockResolvedValueOnce(sse(anthropicText('discard').slice(0, 3)))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'fallback', model: 'm', stop_reason: 'end_turn',
        content: [{ type: 'thinking', thinking: 'reasoning', signature: 'signature' }, { type: 'text', text: 'full body' }],
        usage: { input_tokens: 23, output_tokens: 12 },
      })));
    const messages = await collectQuery(queryLoop(queryConfig({ includePartialMessages: true }), anthropic(), [], 'hi'));
    const assistants = messages.filter(message => message.type === 'assistant');
    expect(assistants.map(message => message.message.content)).toEqual([
      [{ type: 'thinking', thinking: 'reasoning', signature: 'signature' }], [{ type: 'text', text: 'full body' }],
    ]);
    for (const message of assistants) expect(message.message).toMatchObject({
      id: 'fallback', stop_reason: 'end_turn', usage: { input_tokens: 23, output_tokens: 12 },
    });
    expect(messages.find((message) => message.type === 'result')).toMatchObject({ result: 'full body', is_error: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('preserves initial input/cache usage when later deltas only update output tokens', async () => {
    const events = anthropicText('answer');
    events[0] = { type: 'message_start', message: { id: 'cached', model: 'm', usage: {
      input_tokens: 17, output_tokens: 1, cache_creation_input_tokens: 7, cache_read_input_tokens: 11,
    } } };
    fetchMock.mockResolvedValue(sse(events));
    const messages = await collectQuery(queryLoop(queryConfig(), anthropic(), [], 'hi'));
    expect(messages.find((message) => message.type === 'assistant')).toMatchObject({ message: { usage: {
      input_tokens: 17, output_tokens: 1, cache_creation_input_tokens: 7, cache_read_input_tokens: 11,
    } } });
    expect(messages.find(message => message.type === 'result')).toMatchObject({ usage: {
      input_tokens: 17, output_tokens: 2, cache_creation_input_tokens: 7, cache_read_input_tokens: 11,
    } });
  });

  it('retries incomplete JSON fallback responses instead of synthesizing a successful message', async () => {
    fetchMock.mockResolvedValueOnce(sse(anthropicText('partial').slice(0, 3)))
      .mockImplementation(async () => new Response(JSON.stringify({ content: [] })));
    const { events, error } = await collectUntilThrow(anthropic().createMessageStream(request()));
    expect(error).toMatchObject({ retryable: true, retriesExhausted: true });
    expect(events.some((event) => event.type === 'message_stop')).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(11);
  });

  it('retries a transient failure of the non-streaming fallback within the same budget', async () => {
    fetchMock
      .mockResolvedValueOnce(sse(anthropicText('x').slice(0, 2)))
      .mockResolvedValueOnce(errorResponse(502, { error: { message: 'bad gateway' } }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: 'msg-4', model: 'm', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

    const events = await collect(anthropic().createMessageStream(request()));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(retries(events).map((r) => r.status)).toEqual([null, 502]);
  });
});

describe('AnthropicProvider overload', () => {
  const overloaded = () => errorResponse(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });

  it('shares the overload budget across HTTP and SSE without degrading valid SSE errors', async () => {
    let calls = 0;
    fetchMock.mockImplementation(async () => ++calls % 2
      ? overloaded()
      : sse([{ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]));
    const { error, events } = await collectUntilThrow(anthropic().createMessageStream(request({ providerOptions: { fallbackModelAvailable: true } })));
    expect(error).toBeInstanceOf(ModelFallbackError);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(retries(events).map((event) => event.status)).toEqual([529, 529, 529]);
    expect(fetchMock.mock.calls.every((call) => JSON.parse(call[1].body).stream)).toBe(true);
  });

  it('resets consecutive overloads when another failure intervenes', async () => {
    const responses = [overloaded(), overloaded(), errorResponse(503, {}), overloaded(), overloaded(), sse(anthropicText('ok'))];
    fetchMock.mockImplementation(async () => responses.shift());
    const events = await collect(anthropic().createMessageStream(request({ providerOptions: { fallbackModelAvailable: true } })));
    expect(events.at(-1)).toEqual({ type: 'message_stop' });
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('aborts background SSE overload without another request', async () => {
    fetchMock.mockResolvedValue(sse([{ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]));
    const { error, events } = await collectUntilThrow(anthropic().createMessageStream(request({ providerOptions: { querySource: 'background' } })));
    expect(error).toMatchObject({ statusCode: 529, retryable: true, retriesExhausted: true });
    expect(events).toEqual([]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('switches to the fallback model after the overload budget when one is available', async () => {
    fetchMock.mockImplementation(async () => overloaded());

    const { error } = await collectUntilThrow(
      anthropic().createMessageStream(request({ providerOptions: { fallbackModelAvailable: true } })),
    );

    expect(error).toBeInstanceOf(ModelFallbackError);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('keeps retrying overload on the ordinary budget when there is no fallback model', async () => {
    fetchMock.mockImplementation(async () => overloaded());

    const { error } = await collectUntilThrow(anthropic().createMessageStream(request()));

    expect(error).not.toBeInstanceOf(ModelFallbackError);
    expect((error as ProviderError).retriesExhausted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(DEFAULT_RETRY.maxRetries + 1);
  });
});
