import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildWorker } from '../scripts/build-worker.mjs';
import { createWorkerRuntime, createSdkMcpServer, tool, readSessionToolContextMode, type WorkerRuntime, type WorkerSession } from './index.js';
import type { Options } from '../types/config.js';
import type { ProviderRequest } from '../types/provider.js';
import type { SDKMessage } from '../core/query-types.js';

let buildDirectory: string;
let directory: string;
const runtimes: WorkerRuntime[] = [];
beforeAll(async () => {
  buildDirectory = await mkdtemp(join(tmpdir(), 'tool-context-worker-build-'));
  await buildWorker(join(buildDirectory, 'entry.mjs'));
});
afterAll(async () => { await rm(buildDirectory, { recursive: true, force: true }); });
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'tool-context-worker-')); });
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  await rm(directory, { recursive: true, force: true });
});
function pool() {
  const runtime = createWorkerRuntime({ workerUrl: pathToFileURL(join(buildDirectory, 'entry.mjs')),
    maxWorkers: 1, warmWorkers: 0, startupTimeoutMs: 5000, closeTimeoutMs: 5000 });
  runtimes.push(runtime);
  return runtime;
}
const realName = 'mcp__crm_source__lookup_order';
const argumentsText = '{ "customer": "42" }';
const search = { id: 'find', name: 'ToolSearch', input: { query: `select:${realName}` } };
const invoke = (id: string) => ({ id, name: 'CallTool', input: { tool: realName, arguments: argumentsText } });
const setup = (requests: string, replies: unknown[]) => ({
  module: new URL('./fixtures/tool-context.mjs', import.meta.url).href, data: { requests, replies },
});
async function turn(session: WorkerSession) {
  await session.send('Find the customer order.');
  const messages: SDKMessage[] = [];
  for await (const message of session.stream()) { messages.push(message); if (message.type === 'result') break; }
  return messages;
}
async function requests(path: string): Promise<ProviderRequest[]> {
  return (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}
function options(handler: (input: Record<string, unknown>) => Promise<{ content: { type: 'text'; text: string }[] }>,
  canUseTool: Options['canUseTool']): Options {
  return {
    model: 'fixture', apiKey: 'fixture', cwd: directory,
    env: { HOME: directory, USERPROFILE: directory, CLAUDE_CONFIG_DIR: join(directory, 'records') },
    tools: [], settingSources: [], systemPrompt: 'Follow the user request.',
    maxTurns: 10, permissionMode: 'default', canUseTool, includePartialMessages: true,
    turnEndChecks: { openWork: false, completion: false },
    mcpServers: { 'configured.crm': createSdkMcpServer({ name: 'crm/source', description: 'Customer records',
      instructions: 'Check customer IDs.', tools: [tool('lookup/order', 'Complete private order lookup definition.',
        { type: 'object', properties: { customer: { type: 'string' } }, required: ['customer'], additionalProperties: false }, handler)] }) },
    toolDiscovery: { services: { 'configured.crm': { identity: 'installation', loading: 'deferred' } } },
  };
}

describe('client tool discovery through a real worker', () => {
  it('keeps tool arrays stable, maps permission callbacks to the real tool and restores discovery in a fresh worker', async () => {
    const handler = vi.fn(async (input: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text: JSON.stringify(input) }] }));
    const permission = vi.fn(async (name: string) => ({ behavior: 'allow' as const,
      updatedInput: name === realName ? { customer: 'approved' } : {} }));
    const config = options(handler, permission);
    const requestPath = join(directory, 'requests.jsonl');
    const firstPool = pool();
    const session = await firstPool.createSession(config, { setup: setup(requestPath, [search, invoke('initial')]) });
    const events = await turn(session);
    expect(events.at(-1)).toMatchObject({ is_error: false });
    expect(handler).toHaveBeenCalledWith({ customer: 'approved' }, expect.anything());
    expect(permission.mock.calls.map(call => call[0])).toEqual(['ToolSearch', realName]);
    expect(JSON.stringify(events)).not.toContain('toolContext');
    const calls = events.filter(event => event.type === 'assistant').flatMap(event => event.message.content)
      .filter(block => block.type === 'tool_use').map(block => block.name);
    expect(calls).toEqual(['ToolSearch', realName]);
    const first = await requests(requestPath);
    expect(first).toHaveLength(3);
    expect(first[0].tools?.map(tool => tool.name)).toEqual(['ToolSearch', 'CallTool']);
    for (const request of first) expect(request.tools).toEqual(first[0].tools);
    expect(JSON.stringify(first[0])).not.toContain('Complete private order lookup definition.');
    expect(JSON.stringify(first[1])).toContain('Complete private order lookup definition.');
    expect(first[1].messages.slice(0, first[0].messages.length)).toEqual(first[0].messages);
    expect(first[2].messages.flatMap(message => Array.isArray(message.content) ? message.content : []))
      .toContainEqual({ type: 'tool_use', id: 'initial', name: 'CallTool', input: invoke('initial').input });
    await session.close(); await session.flush();
    await firstPool.close();
    expect(await readSessionToolContextMode(session.sessionId, { cwd: directory, env: config.env })).toBe('deferred');
    const secondPool = pool();
    const resumed = await secondPool.createSession({ ...options(handler, permission), resume: session.sessionId, strictResume: true },
      { setup: setup(requestPath, [invoke('resumed')]) });
    expect(resumed.threadId).not.toBe(session.threadId);
    expect((await turn(resumed)).at(-1)).toMatchObject({ is_error: false });
    expect(handler).toHaveBeenCalledTimes(2);
    const all = await requests(requestPath);
    expect(all).toHaveLength(5);
    expect(all[3].tools).toEqual(first[0].tools);
    expect(all[3].messages.flatMap(message => Array.isArray(message.content) ? message.content : []))
      .toContainEqual({ type: 'tool_use', id: 'initial', name: 'CallTool', input: invoke('initial').input });
    expect(permission.mock.calls.map(call => call[0])).toEqual(['ToolSearch', realName, realName]);
  });

  it('cannot bypass a real-target permission denial through an allowed gateway name', async () => {
    const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'must not execute' }] }));
    const permission = vi.fn(async (name: string) => name === realName
      ? { behavior: 'deny' as const, message: 'Customer access denied.' }
      : { behavior: 'allow' as const, updatedInput: {} });
    const config = { ...options(handler, permission), allowedTools: ['CallTool'] };
    const path = join(directory, 'requests.jsonl');
    const session = await pool().createSession(config, { setup: setup(path, [search, invoke('denied')]) });
    const events = await turn(session);
    expect(handler).not.toHaveBeenCalled();
    expect(permission.mock.calls.map(call => call[0])).toEqual(['ToolSearch', realName]);
    expect(events.at(-1)).toMatchObject({ permission_denials: [{ tool_name: realName }] });
    const outgoing = await requests(path);
    expect(JSON.stringify(outgoing.at(-1)?.messages)).toContain('Customer access denied.');
  });
});
