import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { AnthropicProvider, OpenAiCompatProvider, PromptToolCallingAdapter, queryLoop } from '../../index.js';
import { providerHttpFixture } from './test-http.fixture.js';
import type { QueryConfig } from '../../types/config.js';
import type { SDKMessage } from '../../contracts/core/query-types.js';
import type { ProviderRequest, StreamEvent } from '../../types/provider.js';

const servers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of servers.splice(0)) await close(); });

async function loopback(handler: (call: number, response: ServerResponse) => void): Promise<string> {
  let call = 0;
  const server = createServer((_request, response) => { void (async () => { for await (const _chunk of _request) { /* drain */ } handler(call++, response); })(); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  servers.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

function retryThen(response: ServerResponse, call: number, events: unknown[]): void {
  if (call === 0) {
    response.writeHead(500, { 'Content-Type': 'application/json', 'retry-after': '1' });
    response.end(JSON.stringify({ error: { message: 'busy' } }));
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
}

function request(): ProviderRequest {
  return { model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 64, stream: true };
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe.each(['anthropic', 'openai'] as const)('%s native retry admission', (kind) => {
  const provider = (baseUrl: string) => kind === 'anthropic'
    ? new AnthropicProvider({ apiKey: 'k', baseUrl })
    : new OpenAiCompatProvider({ id: 'x', name: 'X', baseUrl: `${baseUrl}/v1`, apiKey: 'k' });

  it.each([
    [429, { 'x-should-retry': 'false' }, 'weekly usage limit exceeded'],
    [429, { 'retry-after': '3600' }, 'quota'],
    [400, {}, 'max_tokens must be between 1 and 32'],
  ] as const)('refuses HTTP %s without retrying or discarding the server message', async (status, headers, message) => {
    let calls = 0;
    const url = await loopback((_call, response) => {
      calls++;
      response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      response.end(JSON.stringify({ error: { message } }));
    });
    const events: StreamEvent[] = [];
    let failure: unknown;
    try { for await (const event of provider(url).createMessageStream(request())) events.push(event); }
    catch (error) { failure = error; }
    expect(failure).toMatchObject({ statusCode: status, retryable: false, requestRejected: true });
    expect((failure as Error).message).toContain(message);
    expect(events.filter(event => event.type === 'retry')).toEqual([]);
    expect(calls).toBe(1);
  });

  it('shares HTTP and SSE failures on one attempt counter', async () => {
    let calls = 0;
    const url = await loopback((_call, response) => {
      calls++;
      if (calls === 1) {
        response.writeHead(503, { 'Content-Type': 'application/json', 'retry-after': '1' });
        response.end('{"error":{"message":"busy"}}');
      } else {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end(calls === 2 ? 'data: {"type":"error","error":{"type":"api_error","message":"stream busy"}}\n\n'
          : kind === 'anthropic' ? [
            { type: 'message_start', message: { id: 'done', model: 'm', content: [], usage: { input_tokens: 1, output_tokens: 1 } } },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
            { type: 'message_stop' },
          ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
          : 'data: {"id":"done","choices":[{"delta":{"content":"recovered"},"finish_reason":"stop"}]}\n\n');
      }
    });
    const events = await collect(provider(url).createMessageStream(request()));
    expect(events.filter(event => event.type === 'retry').map(event => [event.attempt, event.status])).toEqual([[1, 503], [2, 500]]);
    expect(events.at(-1)).toEqual({ type: 'message_stop' });
    expect(events.filter(event => event.type === 'error')).toEqual([]);
    expect(calls).toBe(3);
  }, 15_000);

  it('does not multiply an exhausted provider budget and falls back once on a positive retry hint', async () => {
    const models: string[] = [];
    const fixture = await providerHttpFixture((_url, options) => {
      const body = JSON.parse(options.body as string);
      models.push(body.model);
      if (body.model === 'backup') return new Response(kind === 'anthropic' ? [
        { type: 'message_start', message: { id: 'backup', model: 'backup', content: [], usage: { input_tokens: 1, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'backup answer' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') : 'data: {"choices":[{"delta":{"content":"backup answer"},"finish_reason":"stop"}]}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
      return new Response('{"error":{"message":"busy"}}', { status: 400, headers: { 'Content-Type': 'application/json', 'x-should-retry': 'true', 'retry-after': '1' } });
    });
    servers.push(() => fixture.close());
    const config = { model: 'm', fallbackModel: 'backup', maxTokens: 64, contextWindow: 200_000, maxTurns: 1, cwd: '/tmp', env: {},
      permissionMode: 'bypassPermissions', systemPrompt: 'Answer the question.', thinking: { type: 'disabled' }, abortSignal: new AbortController().signal } as QueryConfig;
    const messages: SDKMessage[] = [];
    for await (const message of queryLoop(config, provider(fixture.baseUrl), [], 'hi')) messages.push(message);
    expect(models).toEqual([...Array(11).fill('m'), 'backup']);
    expect(messages.filter(message => message.type === 'system' && message.subtype === 'model_fallback')).toHaveLength(1);
    expect(messages.filter(message => message.type === 'system' && message.subtype === 'api_retry')).toHaveLength(10);
    expect(messages.find(message => message.type === 'result')).toMatchObject({ is_error: false, result: 'backup answer' });
  }, 20_000);

  it('does not classify a later HTTP refusal as evidence that no response started', async () => {
    let calls = 0;
    const url = await loopback((_call, response) => {
      calls++;
      if (calls === 1) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end(kind === 'anthropic'
          ? 'data: {"type":"message_start","message":{"id":"partial","model":"m","content":[],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n'
          : 'data: {"id":"partial","choices":[{"delta":{"content":"partial"}}]}\n\n');
      } else {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end('{"error":{"message":"max_tokens must be between 1 and 32"}}');
      }
    });
    let failure: unknown;
    try { await collect(provider(url).createMessageStream(request())); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ statusCode: 400, requestRejected: false });
    expect(calls).toBe(2);
  }, 10_000);

  it('classifies authentication failures embedded in HTTP-success streams as terminal', async () => {
    let calls = 0;
    const url = await loopback((_call, response) => {
      calls++;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end('data: {"type":"error","error":{"type":"authentication_error","message":"unauthorized"}}\n\n');
    });
    const events: StreamEvent[] = [];
    let failure: unknown;
    try { for await (const event of provider(url).createMessageStream(request())) events.push(event); }
    catch (error) { failure = error; }
    expect(failure).toMatchObject({ statusCode: 401, retryable: false });
    expect(events.filter(event => event.type === 'retry')).toEqual([]);
    expect(calls).toBe(1);
  });

  it('reports an actual refused connection with its cause and no HTTP status', async () => {
    const probe = createServer();
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
    const stream = provider(`http://127.0.0.1:${port}`).createMessageStream(request());
    try {
      expect((await stream.next()).value).toMatchObject({ type: 'retry', attempt: 1, status: null, message: kind === 'anthropic' ? 'error sending request' : 'fetch failed (ECONNREFUSED)' });
    } finally { await stream.return(undefined); }
  });

  it('cancels after an in-band retry notice without opening a second request', async () => {
    let calls = 0;
    const url = await loopback((_call, response) => {
      calls++;
      response.writeHead(503, { 'retry-after': '7', 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'upstream busy' } }));
    });
    const controller = new AbortController();
    const stream = provider(url).createMessageStream({ ...request(), providerOptions: { signal: controller.signal } });
    expect((await stream.next()).value).toMatchObject({
      type: 'retry', attempt: 1, maxRetries: 10, delayMs: 7000, status: 503, message: 'upstream busy',
    });
    controller.abort(new Error('cancel retry'));
    await expect(stream.next()).rejects.toThrow('cancel retry');
    expect(calls).toBe(1);
  });

  it('cancels a pending response read and closes its connection without retrying', async () => {
    let calls = 0;
    let connected!: () => void;
    let disconnected!: () => void;
    const opened = new Promise<void>(resolve => { connected = resolve; });
    const closed = new Promise<void>(resolve => { disconnected = resolve; });
    const url = await loopback((_call, response) => {
      calls++;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.flushHeaders();
      response.once('close', disconnected);
      connected();
    });
    const controller = new AbortController();
    const stream = provider(url).createMessageStream({ ...request(), providerOptions: { signal: controller.signal } });
    const pending = collect(stream);
    await opened;
    controller.abort(new Error('stop reading'));
    await expect(pending).rejects.toThrow('stop reading');
    await closed;
    expect(calls).toBe(1);
  }, 10_000);
});

describe.each(['native', 'xml', 'json'] as const)('%s public adapter output', mode => {
  it.each([false, true])('preserves thinking, text, usage and partial delivery %s', async includePartialMessages => {
    const text = '正文<thi';
    let executions = 0;
    const fixture = await providerHttpFixture(() => new Response([
      ...[...('<think>中文推理</think>\n' + text)].map(content => ({ id: 'body', model: 'qwen-test', choices: [{ delta: { content } }] })),
      { choices: [{ finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 21, completion_tokens: 9 } },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } }));
    servers.push(() => fixture.close());
    const base = new OpenAiCompatProvider({ id: 'x', name: 'X', baseUrl: `${fixture.baseUrl}/v1`, apiKey: 'k' });
    const provider = mode === 'native' ? base : new PromptToolCallingAdapter(base, mode);
    const config = {
      model: 'qwen-test', maxTokens: 64, contextWindow: 200_000, maxTurns: 1, cwd: '/tmp', env: {},
      permissionMode: 'bypassPermissions', systemPrompt: 'Answer the question.',
      thinking: { type: 'disabled' }, abortSignal: new AbortController().signal, includePartialMessages,
    } as QueryConfig;
    const tool = { name: 'Unused', description: 'Unused test tool', inputSchema: { type: 'object' }, permissionLevel: 'none' as const,
      execute: async () => { executions++; return { content: '', isError: false }; } };
    const messages: SDKMessage[] = [];
    for await (const message of queryLoop(config, provider, [tool], 'hi')) messages.push(message);
    const assistants = messages.filter(message => message.type === 'assistant');
    expect(assistants.map(message => message.message.content)).toEqual([
      [{ type: 'thinking', thinking: '中文推理' }], [{ type: 'text', text }],
    ]);
    expect(new Set(assistants.map(message => message.message.id)).size).toBe(1);
    expect(messages.find(message => message.type === 'result')).toMatchObject({
      is_error: false, result: text, usage: { input_tokens: 21, output_tokens: 9 },
    });
    const streamedText = messages.flatMap(message => {
      if (message.type !== 'stream_event') return [];
      const event = message.event as unknown as { type: string; delta?: { type: string; text?: string } };
      return event.type === 'content_block_delta' && event.delta?.type === 'text_delta' ? [event.delta.text ?? ''] : [];
    }).join('');
    expect(streamedText).toBe(includePartialMessages ? text : '');
    expect(executions).toBe(0);
  });
});

describe('Anthropic native fallback accounting', () => {
  it('retries a transient nonstreaming fallback on the same attempt counter', async () => {
    let calls = 0;
    const fixture = await providerHttpFixture(() => {
      calls++;
      if (calls === 1) return new Response('data: {"type":"message_start","message":{"id":"partial","model":"m","usage":{"input_tokens":1,"output_tokens":1}}}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
      if (calls === 2) return new Response('{"error":{"message":"bad gateway"}}', { status: 502, headers: { 'Content-Type': 'application/json', 'retry-after': '1' } });
      return new Response('{"id":"done","model":"m","content":[{"type":"text","text":"done"}],"stop_reason":"end_turn"}', { headers: { 'Content-Type': 'application/json' } });
    });
    servers.push(() => fixture.close());
    const events = await collect(new AnthropicProvider({ apiKey: 'k', baseUrl: fixture.baseUrl }).createMessageStream(request()));
    expect(calls).toBe(3);
    expect(events.filter(event => event.type === 'retry').map(event => [event.attempt, event.status])).toEqual([[1, null], [2, 502]]);
    expect(events.at(-1)).toEqual({ type: 'message_stop' });
  }, 10_000);

  it('preserves input and cache usage when later deltas only report output', async () => {
    const url = await loopback((_call, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end([
        { type: 'message_start', message: { id: 'cached', model: 'm', content: [], usage: {
          input_tokens: 17, output_tokens: 1, cache_creation_input_tokens: 7, cache_read_input_tokens: 11,
        } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'answer' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
    });
    const result = await new AnthropicProvider({ apiKey: 'k', baseUrl: url }).createMessage(request());
    expect(result.usage).toEqual({ input_tokens: 17, output_tokens: 2, cache_creation_input_tokens: 7, cache_read_input_tokens: 11 });
  });
  it('announces fallback after partial output and restarts the message boundary', async () => {
    let calls = 0;
    const fixture = await providerHttpFixture(() => {
      calls++;
      return calls === 1 ? new Response([
        { type: 'message_start', message: { id: 'partial', model: 'm', content: [], usage: { input_tokens: 1, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } },
      ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
        : new Response(JSON.stringify({ id: 'fallback', model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: 'full answer' }] }), { headers: { 'Content-Type': 'application/json' } });
    });
    servers.push(() => fixture.close());
    const events = await collect(new AnthropicProvider({ apiKey: 'k', baseUrl: fixture.baseUrl }).createMessageStream(request()));
    const retryAt = events.findIndex(event => event.type === 'retry');
    expect(retryAt).toBeGreaterThan(0);
    expect(events[retryAt + 1].type).toBe('message_start');
    expect(calls).toBe(2);
  }, 10_000);

  it.each(['collected', 'query'] as const)('discards partial output and retains fallback thinking, body and usage via %s', async mode => {
    const requests: Record<string, unknown>[] = [];
    const fixture = await providerHttpFixture((_url, options) => {
      const body = JSON.parse(options.body as string);
      requests.push(body);
      if (requests.length === 1) return new Response([
        { type: 'message_start', message: { id: 'failed', model: 'm', content: [], usage: { input_tokens: 0, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'discard' } },
      ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
      return new Response(JSON.stringify({ id: 'fallback', model: 'm', stop_reason: 'end_turn',
        content: [{ type: 'thinking', thinking: 'reasoning', signature: 'signature' }, { type: 'text', text: 'full body' }],
        usage: { input_tokens: 23, output_tokens: 12 } }), { headers: { 'Content-Type': 'application/json' } });
    });
    servers.push(() => fixture.close());
    const provider = new AnthropicProvider({ apiKey: 'k', baseUrl: fixture.baseUrl });
    if (mode === 'collected') {
      const result = await provider.createMessage(request());
      expect(result).toMatchObject({ id: 'fallback', stopReason: 'end_turn', usage: { input_tokens: 23, output_tokens: 12 },
        content: [{ type: 'thinking', thinking: 'reasoning', signature: 'signature' }, { type: 'text', text: 'full body' }] });
    } else {
      const config = { model: 'm', maxTokens: 64, contextWindow: 200_000, maxTurns: 1, cwd: '/tmp', env: {},
        permissionMode: 'bypassPermissions', systemPrompt: 'Answer the question.', thinking: { type: 'disabled' }, abortSignal: new AbortController().signal, includePartialMessages: true } as QueryConfig;
      const messages: SDKMessage[] = [];
      for await (const message of queryLoop(config, provider, [], 'hi')) messages.push(message);
      const assistants = messages.filter(message => message.type === 'assistant');
      expect(assistants.map(message => message.message.content)).toEqual([
        [{ type: 'thinking', thinking: 'reasoning', signature: 'signature' }], [{ type: 'text', text: 'full body' }],
      ]);
      for (const assistant of assistants) expect(assistant.message).toMatchObject({ id: 'fallback', stop_reason: 'end_turn', usage: { input_tokens: 23, output_tokens: 12 } });
      expect(messages.find(message => message.type === 'result')).toMatchObject({ result: 'full body', is_error: false });
    }
    expect(requests).toHaveLength(2);
    expect(requests.map(body => body.stream)).toEqual([true, false]);
    expect({ ...requests[1], stream: true }).toEqual(requests[0]);
  }, 10_000);
});

describe('public failed-attempt accounting', () => {
  it.each(['anthropic-overload', 'openai-truncated'] as const)('does not start a second loop retry budget after ten HTTP failures and %s', async kind => {
    let calls = 0;
    const fixture = await providerHttpFixture(() => {
      calls++;
      return calls === 11
        ? new Response(kind === 'anthropic-overload' ? 'data: {"type":"error","error":{"type":"overloaded_error","message":"overloaded"}}\n\n' : 'data: {"id":"partial","choices":[{"delta":{"content":"partial"}}]}\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
        : new Response('{"error":{"message":"busy"}}', { status: 503, headers: { 'Content-Type': 'application/json', 'retry-after': '1' } });
    });
    servers.push(() => fixture.close());
    const config = { model: 'm', maxTokens: 64, contextWindow: 200_000, maxTurns: 1, cwd: '/tmp', env: {},
      permissionMode: 'bypassPermissions', systemPrompt: 'Answer the question.', thinking: { type: 'disabled' }, abortSignal: new AbortController().signal } as QueryConfig;
    const messages: SDKMessage[] = [];
    for await (const message of queryLoop(config, kind === 'anthropic-overload'
      ? new AnthropicProvider({ apiKey: 'k', baseUrl: fixture.baseUrl })
      : new OpenAiCompatProvider({ id: 'x', name: 'X', baseUrl: `${fixture.baseUrl}/v1`, apiKey: 'k' }), [], 'hi')) messages.push(message);
    expect(calls).toBe(11);
    expect(messages.filter(message => message.type === 'system' && message.subtype === 'api_retry')).toHaveLength(10);
    expect(messages.find(message => message.type === 'result')).toMatchObject({ is_error: true, subtype: 'error_during_execution' });
    const assistants = messages.filter(message => message.type === 'assistant');
    expect(assistants).toEqual([
      expect.objectContaining({ error: kind === 'anthropic-overload' ? 'server_error' : expect.any(String), message: expect.objectContaining({ model: '<synthetic>' }) }),
    ]);
    expect(JSON.stringify(assistants)).not.toContain('partial');
  }, 20_000);
  it('retains interrupted usage exactly once while resetting OpenAI text, thinking and tools', async () => {
    let calls = 0;
    let executions = 0;
    const fixture = await providerHttpFixture(() => {
      calls++;
      const events = calls === 1 ? [
        { id: 'failed', choices: [{ delta: { reasoning_content: 'discard thinking' } }] },
        { choices: [{ delta: { content: 'discard text' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'discard_tool', function: { name: 'Unused', arguments: '{' } }] } }] },
        { usage: { prompt_tokens: 999, completion_tokens: 999 } },
      ] : [
        { id: 'success', choices: [{ delta: { content: 'complete answer' }, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 13, completion_tokens: 7 } },
      ];
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
    });
    servers.push(() => fixture.close());
    const provider = new OpenAiCompatProvider({ id: 'x', name: 'X', baseUrl: `${fixture.baseUrl}/v1`, apiKey: 'k' });
    const config = { model: 'm', maxTokens: 64, contextWindow: 200_000, maxTurns: 1, cwd: '/tmp', env: {},
      permissionMode: 'bypassPermissions', systemPrompt: 'Answer the question.', thinking: { type: 'disabled' }, abortSignal: new AbortController().signal } as QueryConfig;
    const messages: SDKMessage[] = [];
    const tool = { name: 'Unused', description: 'Unused test tool', inputSchema: { type: 'object' }, permissionLevel: 'none' as const,
      execute: async () => { executions++; return { content: '', isError: false }; } };
    for await (const message of queryLoop(config, provider, [tool], 'hi')) messages.push(message);
    expect(messages.filter(message => message.type === 'assistant').at(-1)).toMatchObject({ message: {
      id: 'success', content: [{ type: 'text', text: 'complete answer' }],
    } });
    expect(messages.find(message => message.type === 'result')).toMatchObject({ result: 'complete answer', usage: { input_tokens: 1012, output_tokens: 1006 } });
    expect(executions).toBe(0);
    expect(calls).toBe(2);
  }, 10_000);
});

describe('OpenAI native completion tail', () => {
  it.each(['delayed-usage', 'keepalive', 'disconnect', 'cancel'] as const)('handles %s without replaying the completed request', async kind => {
    let calls = 0;
    let connected!: () => void;
    const opened = new Promise<void>(resolve => { connected = resolve; });
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const url = await loopback((_call, response) => {
      calls++;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: {"id":"answer","choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}\n\n');
      connected();
      if (kind === 'delayed-usage') timers.push(setTimeout(() => response.write('data: {"choices":[],"usage":{"prompt_tokens":19,"completion_tokens":8}}\n\n'), 100));
      if (kind === 'disconnect') timers.push(setTimeout(() => response.destroy(), 50));
      if (kind === 'keepalive') {
        const interval = setInterval(() => response.write(': keepalive\n\n'), 50);
        response.once('close', () => clearInterval(interval));
      }
    });
    const controller = new AbortController();
    const events: StreamEvent[] = [];
    const pending = (async () => {
      for await (const event of new OpenAiCompatProvider({ id: 'x', name: 'X', baseUrl: `${url}/v1`, apiKey: 'k' })
        .createMessageStream({ ...request(), providerOptions: { signal: controller.signal } })) events.push(event);
    })();
    await opened;
    if (kind === 'cancel') {
      controller.abort(new Error('cancel usage wait'));
      await expect(pending).rejects.toThrow('cancel usage wait');
      expect(events.some(event => event.type === 'message_stop')).toBe(false);
    } else {
      await pending;
      expect(events.at(-1)).toEqual({ type: 'message_stop' });
      if (kind === 'delayed-usage') expect(events).toContainEqual({ type: 'message_delta', usage: { input_tokens: 19, output_tokens: 8 } });
    }
    for (const timer of timers) clearTimeout(timer);
    expect(events.filter(event => event.type === 'retry')).toEqual([]);
    expect(calls).toBe(1);
  }, 10_000);

  it('accepts a finish reason without a final delta', async () => {
    const url = await loopback((_call, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end('data: {"choices":[{"finish_reason":"stop"}]}\n\n');
    });
    const events = await collect(new OpenAiCompatProvider({ id: 'x', name: 'X', baseUrl: `${url}/v1`, apiKey: 'k' }).createMessageStream(request()));
    expect(events.at(-1)).toEqual({ type: 'message_stop' });
  });
});

describe('native provider retry path', () => {
  it('reports the server retry hint and then succeeds through the Anthropic adapter', async () => {
    const url = await loopback((call, response) => retryThen(response, call, [
      { type: 'message_start', message: { id: 'm1', model: 'm', content: [], usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]));
    const events = await collect(new AnthropicProvider({ apiKey: 'k', baseUrl: url }).createMessageStream(request()));
    expect(events[0]).toEqual({ type: 'retry', attempt: 1, maxRetries: 10, delayMs: 1000, status: 500, message: 'busy' });
    expect(events.some(event => event.type === 'text_delta')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'message_stop' });
  }, 10_000);

  it('does not retry a refusal when the body is unreadable but the header refuses retrying', async () => {
    let calls = 0;
    const server = createServer((request, response) => { void (async () => {
      calls++;
      for await (const _chunk of request) { /* drain */ }
      response.writeHead(503, { 'Content-Type': 'application/json', 'content-length': '100', 'x-should-retry': 'false' });
      response.flushHeaders();
      response.write('{"error":');
      setTimeout(() => response.destroy(), 20);
    })(); });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    servers.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const controller = new AbortController();
    const pending = collect(new AnthropicProvider({ apiKey: 'k', baseUrl: url }).createMessageStream({
      ...request(), providerOptions: { signal: controller.signal },
    })).catch(error => error);
    await new Promise(resolve => setTimeout(resolve, 1_500));
    const observed = calls;
    controller.abort();
    await pending;
    expect(observed).toBe(1);
  }, 10_000);

  it('reports the server retry hint and then succeeds through the OpenAI adapter', async () => {
    const url = await loopback((call, response) => retryThen(response, call, [
      { id: 'c1', model: 'm', choices: [{ delta: { content: 'ok' } }] },
      { id: 'c1', model: 'm', choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]));
    const events = await collect(new OpenAiCompatProvider({ id: 'x', name: 'X', baseUrl: `${url}/v1`, apiKey: 'k' }).createMessageStream(request()));
    expect(events[0]).toEqual({ type: 'retry', attempt: 1, maxRetries: 10, delayMs: 1000, status: 500, message: 'busy' });
    expect(events.some(event => event.type === 'text_delta')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'message_stop' });
  }, 10_000);
});
