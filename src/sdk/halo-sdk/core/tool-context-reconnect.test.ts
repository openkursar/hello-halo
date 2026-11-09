import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession, type SDKSession } from '../index.js';
import type { LlmProvider, ProviderRequest, ContentBlock, StreamEvent } from '../types/provider.js';
import type { Options } from '../types/config.js';
import type { SDKMessage } from './query-types.js';
import { getTranscriptPath } from './transcript.js';

const sessions: SDKSession[] = [];
const servers: Server[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
const realName = 'mcp__crm__lookup';
const search = (id: string): ContentBlock => ({ type: 'tool_use', id, name: 'ToolSearch', input: { query: `select:${realName}` } });
const call = (id: string, input: Record<string, unknown>): ContentBlock => ({ type: 'tool_use', id, name: 'CallTool',
  input: { tool: realName, arguments: JSON.stringify(input) } });
const direct = (id: string, input: Record<string, unknown>): ContentBlock => ({ type: 'tool_use', id, name: realName, input });
const done: ContentBlock = { type: 'text', text: 'Done.' };

function scripted(replies: ContentBlock[][]) {
  const requests: ProviderRequest[] = [];
  const provider: LlmProvider = {
    id: 'reconnect-fixture', name: 'Reconnect fixture',
    capabilities: () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: false, pdfInput: false,
      audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
    createMessage: async () => { throw new Error('Unexpected summary request'); },
    async *createMessageStream(request): AsyncGenerator<StreamEvent> {
      const content = replies[requests.length] ?? [done];
      requests.push(structuredClone({ ...request, providerOptions: undefined }));
      yield { type: 'message_start', id: `request-${requests.length}`, model: request.model, usage: { input_tokens: 0, output_tokens: 0 } };
      for (const [index, block] of content.entries()) {
        yield { type: 'content_block_start', index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : block };
        if (block.type === 'tool_use') yield { type: 'input_json_delta', index, partialJson: JSON.stringify(block.input) };
        yield { type: 'content_block_stop', index };
      }
      yield { type: 'message_delta', stopReason: content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn' };
      yield { type: 'message_stop' };
    },
  };
  return { provider, requests };
}

async function fixture(
  replies: ContentBlock[][],
  onPermission: (name: string, session: SDKSession) => Promise<void>,
  overrides: Partial<Options> = {},
  inputSchemaForVersion?: (version: number) => Record<string, unknown>,
) {
  const cwd = await mkdtemp(join(tmpdir(), 'tool-context-reconnect-'));
  directories.push(cwd);
  let version = 1;
  let handshakes = 0;
  const calls: { version: number; name: string; arguments: Record<string, unknown> }[] = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', data => { raw += data; });
    request.on('end', () => {
      const message = JSON.parse(raw);
      if (message.method === 'notifications/initialized') { response.writeHead(204); response.end(); return; }
      let result: unknown;
      if (message.method === 'initialize') {
        handshakes++;
        result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'crm', version: String(version) },
          instructions: `Order guide version ${version}.` };
      } else if (message.method === 'tools/list') {
        const parameter = version === 1 ? 'customer' : 'orderId';
        result = { tools: [{ name: 'lookup', description: `Order lookup definition version ${version}.`,
          inputSchema: inputSchemaForVersion?.(version) ?? {
            type: 'object', properties: { [parameter]: { type: 'string' } }, required: [parameter], additionalProperties: false,
          } }] };
      } else {
        calls.push({ version, ...message.params });
        result = { content: [{ type: 'text', text: 'Order found.' }] };
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
  const { provider, requests } = scripted(replies);
  let session!: SDKSession;
  const options: Options = {
    model: 'fixture', provider, cwd, env: { HOME: cwd, USERPROFILE: cwd, CLAUDE_CONFIG_DIR: join(cwd, 'records') },
    tools: [], settingSources: [], systemPrompt: 'Follow the user request.', permissionMode: 'default',
    canUseTool: async name => { await onPermission(name, session); return { behavior: 'allow', updatedInput: {} }; },
    turnEndChecks: { openWork: false, completion: false }, maxTurns: 12,
    mcpServers: { crm: { type: 'http', url } },
    toolDiscovery: { services: { crm: { identity: 'installed-crm', loading: 'deferred', summary: 'Customer orders.' } } },
    ...overrides,
  };
  session = await createSession(options);
  sessions.push(session);
  return { options, session, calls, requests, setVersion: (next: number) => { version = next; }, handshakes: () => handshakes };
}
async function run(session: SDKSession) {
  await session.send('Find the order.');
  const messages: SDKMessage[] = [];
  for await (const message of session.stream()) { messages.push(message); if (message.type === 'result') break; }
  return messages;
}
function toolResults(messages: SDKMessage[]) {
  return messages.filter(message => message.type === 'user').flatMap(message => message.message.content)
    .filter(block => block.type === 'tool_result');
}
function assertFixedTools(requests: ProviderRequest[]) {
  expect(requests[0].tools?.map(tool => tool.name)).toEqual(['ToolSearch', 'CallTool']);
  for (const request of requests) expect(request.tools).toEqual(requests[0].tools);
}

describe('session tool-context refresh at MCP boundaries', () => {
  it('keeps an already-issued eager response on its original execution snapshot during reconnect', async () => {
    let current!: Awaited<ReturnType<typeof fixture>>;
    current = await fixture([
      [{ type: 'tool_use', id: 'refresh', name: 'RefreshFixture', input: {} }, direct('issued-old', { customer: '42' })],
      [direct('fresh-next-step', { customer: '42' })], [done],
    ], async () => {}, {
      toolDiscovery: { services: { crm: { identity: 'installed-crm', loading: 'eager' } } },
      customTools: [{ name: 'RefreshFixture', description: 'Reconnect the fixture.', inputSchema: { type: 'object' }, permissionLevel: 'none',
        async execute() {
          current.setVersion(2);
          await current.session.query.reconnectMcpServer('crm');
          return { content: 'Fixture reconnected.', isError: false };
        },
      }],
    }, version => ({ type: 'object', properties: { customer: { type: 'string', minLength: version } },
      required: ['customer'], additionalProperties: false }));
    const messages = await run(current.session);
    expect(messages.at(-1)).toMatchObject({ is_error: false });
    expect(current.handshakes()).toBe(2);
    const results = toolResults(messages);
    const refused = results.find(result => result.tool_use_id === 'issued-old');
    expect(refused).toMatchObject({ is_error: true });
    expect(String(refused?.content)).toContain('stale call was not executed');
    const fresh = results.find(result => result.tool_use_id === 'fresh-next-step');
    expect(fresh).toMatchObject({ content: 'Order found.' });
    expect(fresh?.is_error).not.toBe(true);
    expect(current.calls).toEqual([{ version: 2, name: 'lookup', arguments: { customer: '42' } }]);
    expect(current.requests[0].tools?.map(tool => tool.name)).toEqual(['RefreshFixture', realName]);
    expect(current.requests[0].tools?.find(tool => tool.name === realName)).toMatchObject({
      description: 'Order lookup definition version 1.', input_schema: { properties: { customer: { minLength: 1 } } },
    });
    expect(current.requests[1].tools?.find(tool => tool.name === realName)).toMatchObject({
      description: 'Order lookup definition version 2.', input_schema: { properties: { customer: { minLength: 2 } } },
    });
    expect(current.requests[2].tools).toEqual(current.requests[1].tools);
  });

  it('refuses a stale prepared call, discovers the replacement schema and resumes the same task', async () => {
    let changed = false;
    const current = await fixture([
      [search('find-old')], [call('prepared-old', { customer: '42' })], [call('undiscovered-new', { orderId: '42' })],
      [direct('direct-new', { orderId: '42' })], [search('find-new')], [call('execute-new', { orderId: '42' })], [done],
    ], async (name, session) => {
      if (name !== realName || changed) return;
      changed = true;
      current.setVersion(2);
      await session.query.reconnectMcpServer('crm');
    });
    const messages = await run(current.session);
    expect(messages.at(-1)).toMatchObject({ is_error: false });
    expect(current.handshakes()).toBe(2);
    expect(current.calls).toEqual([{ version: 2, name: 'lookup', arguments: { orderId: '42' } }]);
    const results = toolResults(messages);
    expect(results.find(result => result.tool_use_id === 'prepared-old')).toMatchObject({ is_error: true });
    expect(String(results.find(result => result.tool_use_id === 'prepared-old')?.content)).toContain('stale call was not executed');
    expect(results.find(result => result.tool_use_id === 'undiscovered-new')).toMatchObject({ is_error: true });
    expect(results.find(result => result.tool_use_id === 'direct-new')).toMatchObject({ is_error: true });
    const old = JSON.parse(String(results.find(result => result.tool_use_id === 'find-old')?.content)).tools[0];
    const replacement = JSON.parse(String(results.find(result => result.tool_use_id === 'find-new')?.content)).tools[0];
    expect(old.input_schema.required).toEqual(['customer']);
    expect(replacement.input_schema.required).toEqual(['orderId']);
    expect(replacement.version).not.toBe(old.version);
    assertFixedTools(current.requests);
    expect(current.requests[1].messages.slice(0, current.requests[0].messages.length)).toEqual(current.requests[0].messages);
    expect(current.requests[6].messages.slice(0, current.requests[5].messages.length)).toEqual(current.requests[5].messages);
    await current.session.close();
    const raw = await readFile(getTranscriptPath(current.session.sessionId, current.options.cwd!, current.options), 'utf8');
    const baselines = raw.trim().split('\n').map(line => JSON.parse(line).message?.toolContext?.baseline).filter(Boolean);
    expect(new Set(baselines.map(baseline => baseline.generation)).size).toBe(2);
    expect(baselines.at(-1).definitions).toEqual([]);
  });

  it.each(['disable', 'remove'] as const)('does not execute or rediscover an old authorized tool after %s', async action => {
    let changed = false;
    const current = await fixture([[search('find-old')], [call('prepared-old', { customer: '42' })],
      [call('after-change', { customer: '42' })], [direct('direct-old', { customer: '42' })], [search('search-removed')], [done]],
    async (name, session) => {
      if (name !== realName || changed) return;
      changed = true;
      if (action === 'disable') await session.query.toggleMcpServer('crm', false);
      else await session.query.setMcpServers({});
    });
    const messages = await run(current.session);
    expect(messages.at(-1)).toMatchObject({ is_error: false });
    expect(current.calls).toEqual([]);
    expect(current.handshakes()).toBe(1);
    const results = toolResults(messages);
    expect(results.filter(result => ['prepared-old', 'after-change', 'direct-old', 'search-removed'].includes(result.tool_use_id)))
      .toHaveLength(4);
    for (const result of results.filter(result => result.tool_use_id !== 'find-old')) expect(result.is_error).toBe(true);
    assertFixedTools(current.requests);
    await current.session.close();
    const next = scripted([[call('after-resume', { customer: '42' })], [done]]);
    const resumed = await createSession({ ...current.options, provider: next.provider, resume: current.session.sessionId,
      strictResume: true, mcpServers: {}, canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }) });
    sessions.push(resumed);
    const restored = await run(resumed);
    expect(restored.at(-1)).toMatchObject({ is_error: false });
    expect(toolResults(restored).find(result => result.tool_use_id === 'after-resume')).toMatchObject({ is_error: true });
    expect(current.calls).toEqual([]);
  });
});
