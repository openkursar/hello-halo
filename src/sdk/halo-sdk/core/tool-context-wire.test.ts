import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession, query, createSdkMcpServer, tool } from '../index.js';
import type { SDKSession } from './session.js';
import type { SDKMessage } from './query-types.js';
import type { Options } from '../types/config.js';
import type { ContentBlock, LlmProvider } from '../types/provider.js';
import { AnthropicProvider } from '../llm/anthropic.js';
import { OpenAiCompatProvider } from '../llm/openai-compat.js';

type Protocol = 'messages' | 'chat';
type Reply = { name: string; id: string; input: Record<string, unknown> } | { text: string };
interface WireCall { id: string; type: string; function: { name: string; arguments: string } }
interface WireMessage {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: WireCall[];
}
interface WireRequest {
  model: string;
  stream: boolean;
  system?: unknown;
  messages: WireMessage[];
  tools?: Array<{ name?: string; function?: { name: string } }>;
}

const sessions: SDKSession[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const target = 'mcp__crm__lookup';
const lookupDescription = 'Complete lookup definition with shipment audit evidence.';
const notesDescription = 'Complete notes definition with customer contact evidence.';
const guide = 'Use the service receipt to distinguish a completed lookup from an empty answer.';
const rawArguments = String.raw`{
  "customer": "cust\u0034\u0032", "filters": { "includeArchived": false }, "tags": ["中文", "quote: \"value\""]
}`;
const parsedArguments = JSON.parse(rawArguments) as Record<string, unknown>;
const schema = {
  type: 'object',
  properties: {
    customer: { type: 'string', description: 'The complete customer reference.' },
    filters: { type: 'object', properties: { includeArchived: { type: 'boolean' } }, required: ['includeArchived'], additionalProperties: false },
    tags: { type: 'array', items: { type: 'string' }, description: 'Preserve each supplied label.' },
  },
  required: ['customer', 'filters', 'tags'], additionalProperties: false,
};
const search: Reply = { name: 'ToolSearch', id: 'search-lookup', input: { query: `select:${target}` } };
const searchNotes: Reply = { name: 'ToolSearch', id: 'search-notes', input: { query: 'select:mcp__crm__notes' } };
const invoke: Reply = { name: 'CallTool', id: 'invoke-lookup', input: { tool: target, arguments: rawArguments } };
const done: Reply = { text: 'The customer lookup completed.' };

function sse(response: ServerResponse, value: unknown) {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

function sendMessages(response: ServerResponse, reply: Reply, sequence: number, streaming: boolean) {
  const content: ContentBlock[] = 'text' in reply ? [{ type: 'text', text: reply.text }]
    : [{ type: 'tool_use', name: reply.name, id: reply.id, input: reply.input }];
  const message = { id: `response-${sequence}`, type: 'message', role: 'assistant', model: 'wire-fixture',
    content, stop_reason: 'text' in reply ? 'end_turn' : 'tool_use', stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20 } };
  if (!streaming) {
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(message));
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  sse(response, { type: 'message_start', message: { ...message, content: [], stop_reason: null } });
  if ('text' in reply) {
    sse(response, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    sse(response, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply.text } });
  } else {
    sse(response, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: reply.name, id: reply.id, input: {} } });
    const input = JSON.stringify(reply.input);
    for (const partial_json of [input.slice(0, 8), input.slice(8, 29), input.slice(29)]) {
      sse(response, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json } });
    }
  }
  sse(response, { type: 'content_block_stop', index: 0 });
  sse(response, { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 20 } });
  sse(response, { type: 'message_stop' });
  response.end();
}

function sendChat(response: ServerResponse, reply: Reply, sequence: number) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = (delta: unknown, finish_reason: string | null = null) => sse(response, {
    id: `response-${sequence}`, object: 'chat.completion.chunk', model: 'wire-fixture',
    choices: [{ index: 0, delta, finish_reason }],
  });
  chunk({ role: 'assistant', content: '' });
  if ('text' in reply) chunk({ content: reply.text });
  else {
    const input = JSON.stringify(reply.input);
    chunk({ tool_calls: [{ index: 0, id: reply.id, type: 'function', function: { name: reply.name, arguments: input.slice(0, 8) } }] });
    chunk({ tool_calls: [{ index: 0, function: { arguments: input.slice(8, 29) } }] });
    chunk({ tool_calls: [{ index: 0, function: { arguments: input.slice(29) } }] });
  }
  chunk({}, 'text' in reply ? 'stop' : 'tool_calls');
  sse(response, { id: `response-${sequence}`, choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
  response.end('data: [DONE]\n\n');
}

async function endpoint(protocol: Protocol, replies: Reply[], interruptCall = false) {
  const requests: WireRequest[] = [];
  const paths: string[] = [];
  const failures: string[] = [];
  let step = 0;
  let interrupted = false;
  const server = createServer((request, response) => {
    void (async () => {
      paths.push(request.url ?? '');
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as WireRequest;
      requests.push(body);
      const reply = replies[step] ?? done;
      if (interruptCall && !interrupted && 'name' in reply && reply.name === 'CallTool' && body.stream) {
        interrupted = true;
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        sse(response, { type: 'message_start', message: { id: 'interrupted', model: 'wire-fixture', content: [], usage: { input_tokens: 100, output_tokens: 0 } } });
        sse(response, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'CallTool', id: reply.id, input: {} } });
        sse(response, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"tool":"mcp__crm' } });
        response.end();
        return;
      }
      step++;
      if (protocol === 'messages') sendMessages(response, reply, step, body.stream);
      else sendChat(response, reply, step);
    })().catch(error => {
      failures.push(String(error));
      if (!response.headersSent) response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Fixture protocol failure' } }));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const provider: LlmProvider = protocol === 'messages'
    ? new AnthropicProvider({ apiKey: 'local-wire-fixture', baseUrl })
    : new OpenAiCompatProvider({ id: 'wire-fixture', name: 'Wire fixture', apiKey: 'local-wire-fixture', baseUrl: `${baseUrl}/v1` });
  return { provider, requests, paths, failures };
}

async function fixture(provider: LlmProvider, overrides: Partial<Options> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'sdk-tool-context-wire-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const handler = vi.fn(async (input: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text: `Service receipt: ${JSON.stringify(input)}` }] }));
  const options: Options = {
    model: 'wire-fixture', provider, cwd: directory, tools: [], persistSession: false,
    env: { HOME: directory, USERPROFILE: directory, CLAUDE_CONFIG_DIR: join(directory, 'config') },
    settingSources: [], systemPrompt: 'Keep the original user constraints.',
    toolCallingMode: 'native', thinking: { type: 'disabled' }, maxTurns: 8, maxOutputTokens: 1024,
    contextWindow: 32000, includePartialMessages: true, turnEndChecks: { openWork: false, completion: false },
    permissionMode: 'default', canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }),
    customTools: [{ name: 'ResidentRead', description: 'Read a local fixture.', inputSchema: { type: 'object', properties: {} },
      permissionLevel: 'readonly', execute: async () => ({ content: 'Resident fixture.', isError: false }) }],
    mcpServers: { crm: createSdkMcpServer({ name: 'crm', instructions: guide, tools: [
      tool('lookup', lookupDescription, schema, handler), tool('notes', notesDescription, schema, handler),
    ] }) },
    toolDiscovery: { services: { crm: { identity: 'private-installation-identity', loading: 'deferred', summary: 'Customer orders and notes' } } },
    ...overrides,
  };
  return { options, handler };
}

async function run(options: Options, oneShot = false) {
  const events: SDKMessage[] = [];
  const session = oneShot ? null : await createSession(options);
  if (session) { sessions.push(session); await session.send('Look up customer 42.'); }
  const stream = session ? session.stream() : query({ prompt: 'Look up customer 42.', options });
  for await (const event of stream) { events.push(event); if (event.type === 'result') break; }
  expect(events.at(-1)).toMatchObject({ type: 'result', is_error: false });
  return events;
}

function calls(request: WireRequest) {
  return request.messages.flatMap(message => [
    ...(message.tool_calls ?? []).map(call => ({ id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) })),
    ...(Array.isArray(message.content) ? message.content.filter(block => block.type === 'tool_use') : []),
  ]);
}

function resultText(request: WireRequest, id: string): string {
  for (const message of request.messages) {
    if (message.role === 'tool' && message.tool_call_id === id) return String(message.content);
    if (Array.isArray(message.content)) {
      const block = message.content.find(block => block.type === 'tool_result' && block.tool_use_id === id);
      if (block) return typeof block.content === 'string' ? block.content
        : block.content.map((part: { text?: string }) => part.text ?? '').join('');
    }
  }
  throw new Error(`Missing wire result ${id}`);
}

function result(request: WireRequest, id: string): Record<string, unknown> {
  return JSON.parse(resultText(request, id));
}

function withoutCacheMarkers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheMarkers);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'cache_control').map(([key, item]) => [key, withoutCacheMarkers(item)]));
  return value;
}

function messageContent(messages: WireMessage[]): unknown {
  return messages.map(message => ({ ...withoutCacheMarkers(message) as WireMessage,
    ...(typeof message.content === 'string' ? { content: [{ type: 'text', text: message.content }] } : {}) }));
}

function assertPublicWire(request: WireRequest) {
  const forbidden = new Set(['toolContext', 'toolContextVersion', 'toolContextRecord', 'mcpSource', 'isMeta', 'defer_loading', 'halo_defer_loading',
    'discoveryEnvelope', 'payloadOffset', 'payloadLength']);
  const inspect = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(inspect); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) { expect(forbidden.has(key), `Private wire field ${key}`).toBe(false); inspect(child); }
  };
  inspect(request);
  expect(JSON.stringify(request)).not.toContain('private-installation-identity');
}

describe('tool context through native provider HTTP encoding', () => {
  it.each(['messages', 'chat'] as const)('keeps %s hook context inside the existing search result string', async protocol => {
    const wire = await endpoint(protocol, [search, invoke, done]);
    const { options, handler } = await fixture(wire.provider, { hooks: {
      PreToolUse: [{ matcher: 'ToolSearch', hooks: [async () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse',
        updatedInput: { query: `select:${target}`, max_results: 1 }, additionalContext: 'Host prefix context.',
      } })] }],
      PostToolUse: [{ matcher: 'ToolSearch', hooks: [async () => ({ additionalContext: 'Host suffix context.' })] }],
    } });
    await run(options);
    expect(wire.failures).toEqual([]);
    expect(handler).toHaveBeenCalledOnce();
    const text = resultText(wire.requests[1], 'search-lookup');
    expect(text).toContain('adjusted this call');
    expect(text).toContain('Host prefix context.\n\n');
    expect(text).toContain(JSON.stringify(schema));
    expect(text.endsWith('\n\nHost suffix context.')).toBe(true);
    for (const request of wire.requests) {
      expect(request.tools).toEqual(wire.requests[0].tools);
      assertPublicWire(request);
      expect(JSON.stringify(request.system ?? '')).not.toContain('Host prefix context.');
      expect(JSON.stringify(request.messages.filter(message => message.role === 'system'))).not.toContain('Host prefix context.');
    }
    if (protocol === 'chat') {
      expect(wire.requests[1].messages.find(message => message.tool_call_id === 'search-lookup')).toMatchObject({ role: 'tool', content: text });
    } else {
      expect(wire.requests[1].messages.some(message => message.role === 'user' && Array.isArray(message.content) &&
        message.content.some(block => block.type === 'tool_result' && block.tool_use_id === 'search-lookup' && block.content === text))).toBe(true);
    }
    expect(resultText(wire.requests[2], 'search-lookup')).toBe(text);
  });

  it.each(['messages', 'chat'] as const)('keeps the %s tool table fixed and replays the original wrapper after permission edits', async protocol => {
    const wire = await endpoint(protocol, [search, searchNotes, invoke, done]);
    const { options, handler } = await fixture(wire.provider, {
      canUseTool: async name => ({ behavior: 'allow', updatedInput: name === target ? { customer: 'approved-42' } : {} }),
    });
    const events = await run(options);
    expect(wire.failures).toEqual([]);
    expect(wire.paths).toEqual(Array(4).fill(protocol === 'messages' ? '/v1/messages' : '/v1/chat/completions'));
    expect(wire.requests).toHaveLength(4);
    const first = wire.requests[0];
    expect(first.tools?.map(tool => tool.name ?? tool.function?.name)).toEqual(['ResidentRead', 'ToolSearch', 'CallTool']);
    for (const request of wire.requests) { expect(request.tools).toEqual(first.tools); expect(request.system).toEqual(first.system); assertPublicWire(request); }
    expect(JSON.stringify(first)).not.toContain(lookupDescription);
    expect(JSON.stringify(first)).not.toContain(notesDescription);
    expect(JSON.stringify(first)).not.toContain(guide);
    expect(result(wire.requests[1], 'search-lookup')).toMatchObject({ invoke_via: 'CallTool', targets: [{ tool: target, description: lookupDescription, arguments_schema: schema, usage_guide: guide }] });
    expect(result(wire.requests[2], 'search-notes')).toMatchObject({ invoke_via: 'CallTool', targets: [{ tool: 'mcp__crm__notes', description: notesDescription, arguments_schema: schema }] });
    expect(JSON.stringify(wire.requests[3].messages).split(guide)).toHaveLength(2);
    for (let i = 1; i < wire.requests.length; i++) {
      // Anthropic wraps a string in a text block when placing its cache marker.
      expect(messageContent(wire.requests[i].messages.slice(0, wire.requests[i - 1].messages.length)))
        .toEqual(messageContent(wire.requests[i - 1].messages));
    }
    expect(calls(wire.requests[3])).toContainEqual(expect.objectContaining({ id: 'invoke-lookup', name: 'CallTool', input: invoke.input }));
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toEqual({ ...parsedArguments, customer: 'approved-42' });
    const names = events.flatMap(event => event.type === 'assistant' ? event.message.content : [])
      .filter(block => block.type === 'tool_use').map(block => block.name);
    expect(names).toEqual(['ToolSearch', 'ToolSearch', target]);
    expect(JSON.stringify(events)).not.toContain('toolContext');
  });

  it('keeps the wrapper and tool table through a genuine Anthropic stream-to-JSON fallback', async () => {
    const wire = await endpoint('messages', [search, invoke, done], true);
    const { options, handler } = await fixture(wire.provider);
    const events = await run(options);
    expect(wire.failures).toEqual([]);
    expect(wire.requests.map(request => request.stream)).toEqual([true, true, false, true]);
    expect(wire.requests[2]).toEqual({ ...wire.requests[1], stream: false });
    for (const request of wire.requests) { expect(request.tools).toEqual(wire.requests[0].tools); assertPublicWire(request); }
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toEqual(parsedArguments);
    expect(calls(wire.requests[3])).toContainEqual(expect.objectContaining({ name: 'CallTool', input: invoke.input }));
    expect(events.some(event => event.type === 'system' && event.subtype === 'api_retry')).toBe(true);
  }, 15000);

  it('uses the same wire representation from the one-shot query API', async () => {
    const wire = await endpoint('chat', [search, invoke, done]);
    const { options, handler } = await fixture(wire.provider);
    await run(options, true);
    expect(handler).toHaveBeenCalledOnce();
    expect(wire.requests).toHaveLength(3);
    for (const request of wire.requests) { expect(request.tools).toEqual(wire.requests[0].tools); assertPublicWire(request); }
    expect(calls(wire.requests[2])).toContainEqual(expect.objectContaining({ name: 'CallTool', input: invoke.input }));
  });

  it('replays saved Messages wrappers through Chat after reopening without repeating discovery or past effects', async () => {
    const original = await endpoint('messages', [search, invoke, done]);
    const { options, handler } = await fixture(original.provider, { persistSession: true });
    await run(options);
    const previous = sessions.at(-1)!;
    await previous.close();
    expect(handler).toHaveBeenCalledOnce();
    const nextCall: Reply = { ...invoke, id: 'resumed-lookup' };
    const next = await endpoint('chat', [nextCall, done]);
    await run({ ...options, provider: next.provider, resume: previous.sessionId, strictResume: true });
    expect(next.failures).toEqual([]);
    expect(next.requests).toHaveLength(2);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(calls(next.requests[0])).toContainEqual(expect.objectContaining({ id: 'invoke-lookup', name: 'CallTool', input: invoke.input }));
    expect(calls(next.requests[1])).toContainEqual(expect.objectContaining({ id: 'resumed-lookup', name: 'CallTool', input: invoke.input }));
    for (const request of next.requests) {
      expect(request.tools?.map(tool => tool.function?.name)).toEqual(['ResidentRead', 'ToolSearch', 'CallTool']);
      assertPublicWire(request);
    }
  });

  it.each(['xml', 'json'] as const)('keeps explicit %s mode on its existing full-tool prompt path', async mode => {
    const wire = await endpoint('chat', [done]);
    const { options, handler } = await fixture(wire.provider, { toolCallingMode: mode });
    await run(options);
    expect(wire.requests).toHaveLength(1);
    const request = wire.requests[0];
    expect(request.tools ?? []).toEqual([]);
    const system = JSON.stringify(request.messages.filter(message => message.role === 'system'));
    expect(system).toContain(lookupDescription);
    expect(system).toContain(notesDescription);
    expect(system).toContain(target);
    expect(system).not.toContain('ToolSearch');
    expect(system).not.toContain('CallTool');
    expect(handler).not.toHaveBeenCalled();
    assertPublicWire(request);
  });
});
