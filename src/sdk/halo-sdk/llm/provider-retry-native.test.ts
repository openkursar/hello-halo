import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { AnthropicProvider, OpenAiCompatProvider } from '../index.js';
import type { ProviderRequest, StreamEvent } from '../types/provider.js';

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
    expect(events).toContainEqual(expect.objectContaining({ type: 'retry', attempt: 1, delayMs: 1000, status: 500 }));
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
    expect(events).toContainEqual(expect.objectContaining({ type: 'retry', attempt: 1, delayMs: 1000, status: 500 }));
    expect(events.at(-1)).toEqual({ type: 'message_stop' });
  }, 10_000);
});
