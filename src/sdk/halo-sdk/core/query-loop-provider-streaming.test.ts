import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { AnthropicProvider } from '../llm/anthropic.js';
import { OpenAiCompatProvider } from '../llm/openai-compat.js';
import type { Tool } from '../types/tool.js';
import { queryLoop } from '../index.js';
import { resolveQueryConfig } from './context.js';
import type { SDKMessage } from './query-types.js';

const servers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const close of servers.splice(0)) await close();
});

/**
 * The loop calls its HTTP adapters from Rust, where a JavaScript `fetch` stub
 * cannot observe or script requests, so these cases serve bytes from a loopback server.
 */
async function loopback(handler: (request: { body: any; call: number; response: ServerResponse }) => Promise<void> | void) {
  let call = 0;
  const bodies: any[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      bodies.push(body);
      await handler({ body, call: call++, response });
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  servers.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, bodies };
}

function sse(response: ServerResponse, events: unknown[]) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
}

describe('native provider output allowances', () => {
  it.each(['anthropic', 'openai'] as const)('corrects a pre-content HTTP refusal through the real %s adapter', async protocol => {
    const endpoint = await loopback(({ call, response }) => {
      if (call === 0) {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'max_tokens must be between 1 and 393216' } }));
        return;
      }
      const events = protocol === 'anthropic' ? [
        { type: 'message_start', message: { id: 'done', model: 'fixture', usage: { input_tokens: 20, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Complete.' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ] : [
        { id: 'done', model: 'fixture', choices: [{ delta: { role: 'assistant', content: 'Complete.' }, finish_reason: null }] },
        { id: 'done', model: 'fixture', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 2 } },
      ];
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + (protocol === 'openai' ? 'data: [DONE]\n\n' : ''));
    });
    const bodies = endpoint.bodies;
    const provider = protocol === 'anthropic' ? new AnthropicProvider({ apiKey: 'fixture-only', baseUrl: endpoint.url })
      : new OpenAiCompatProvider({ id: 'fixture', name: 'Fixture', baseUrl: `${endpoint.url}/v1`, apiKey: 'fixture-only' });
    const cfg = resolveQueryConfig({ model: 'fixture', cwd: '/tmp', systemPrompt: 'Fixture', settingSources: [],
      contextWindow: 1_000_000, maxOutputTokens: 640_000, thinking: { type: 'disabled' },
      turnEndChecks: { openWork: false, completion: false } });
    const events: SDKMessage[] = [];
    for await (const event of queryLoop(cfg, provider, [], 'Hello.')) events.push(event);
    expect(events.at(-1)).toMatchObject({ is_error: false });
    expect(bodies.map(body => body.max_tokens)).toEqual([640_000, 393_216]);
    expect(bodies[1].messages).toEqual(bodies[0].messages);
    expect(cfg.maxTokens).toBe(640_000);
  });

  it.each(['text', 'thinking', 'tool_use'] as const)('does not replay a summary when the Anthropic stream fails after %s starts', async kind => {
    const endpoint = await loopback(({ response }) => {
      const block = kind === 'tool_use' ? { type: kind, id: 'never-run', name: 'work', input: {} }
        : kind === 'thinking' ? { type: kind, thinking: '' } : { type: kind, text: '' };
      sse(response, [
        { type: 'message_start', message: { id: 'partial', model: 'fixture', usage: { input_tokens: 20, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: block },
        { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens must be between 1 and 2048' } },
      ]);
    });
    const cfg = resolveQueryConfig({ model: 'fixture', cwd: '/tmp', systemPrompt: 'Fixture', settingSources: [],
      contextWindow: 40_000, maxOutputTokens: 300, thinking: { type: 'disabled' },
      turnEndChecks: { openWork: false, completion: false } });
    const history = Array.from({ length: 24 }, (_, index) => ({ role: index % 2 ? 'assistant' as const : 'user' as const,
      content: `Record ${index}: ${'verified evidence '.repeat(300)}` }));
    const checkpoint = vi.fn();
    const events: SDKMessage[] = [];
    for await (const event of queryLoop(cfg, new AnthropicProvider({ apiKey: 'fixture-only', baseUrl: endpoint.url }), [], history, { onCompact: checkpoint })) events.push(event);
    expect(events.at(-1)).toMatchObject({ is_error: true });
    expect(endpoint.bodies.length).toBe(1);
    expect(checkpoint).not.toHaveBeenCalled();
  });
});

describe('native provider streaming execution', () => {
  it.each([false, true])('executes before the HTTP stream ends and avoids replay after interruption=%s', async interrupted => {
    let release!: () => void;
    const executed = new Promise<void>(resolve => { release = resolve; });
    let requests = 0;
    let ended = false;
    const execute = vi.fn(async () => {
      expect(ended).toBe(false);
      release();
      return { content: 'Saved exactly once.', isError: false };
    });
    const fixture: Tool = { name: 'SaveFixture', description: 'Fixture', permissionLevel: 'write',
      inputSchema: { type: 'object' }, isConcurrencySafe: () => false, execute };
    const endpoint = await loopback(async ({ call, response }) => {
      const first = call === 0;
      const emit = (event: unknown) => response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      requests++;
      emit({ type: 'message_start', message: { id: `response-${requests}`, model: 'fixture',
        usage: { input_tokens: 20, output_tokens: 0 } } });
      if (first) {
        emit({ type: 'content_block_start', index: 0,
          content_block: { type: 'tool_use', id: 'save-1', name: fixture.name, input: {} } });
        emit({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } });
        emit({ type: 'content_block_stop', index: 0 });
        await executed;
        // Yield a complete tool result before terminating the transport.
        await new Promise<void>(resolve => setImmediate(resolve));
        if (interrupted) { response.end(); return; }
      } else {
        emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Complete.' } });
        emit({ type: 'content_block_stop', index: 0 });
      }
      ended = true;
      emit({ type: 'message_delta', delta: { stop_reason: first ? 'tool_use' : 'end_turn' },
        usage: { output_tokens: 10 } });
      emit({ type: 'message_stop' });
      response.end();
    });
    const config = resolveQueryConfig({ model: 'fixture', cwd: '/tmp', systemPrompt: 'Fixture',
      settingSources: [], permissionMode: 'bypassPermissions', maxTurns: 3,
      thinking: { type: 'disabled' }, turnEndChecks: { openWork: false, completion: false } });
    const messages: SDKMessage[] = [];
    for await (const message of queryLoop(config, new AnthropicProvider({ apiKey: 'fixture-only', baseUrl: endpoint.url }), [fixture], 'Save.')) {
      messages.push(message);
    }
    expect(execute).toHaveBeenCalledOnce();
    expect(requests).toBe(interrupted ? 1 : 2);
    expect(messages.at(-1)).toMatchObject({ type: 'result', is_error: interrupted });
    const results = messages.flatMap(message => message.type === 'user' ? message.message.content : [])
      .filter(block => block.type === 'tool_result');
    expect(results).toEqual([expect.objectContaining({ content: 'Saved exactly once.' })]);
  }, 2000);
});
