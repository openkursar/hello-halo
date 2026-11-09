import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import * as queryLoopModule from '../../core/query-loop.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession, createSdkMcpServer, query, tool, type LlmProvider, type ProviderRequest, type StreamEvent, type Options, type SDKMessage, type Query } from '../../index.js';
import { TEAM_LEAD_ADDRESS } from '../addressing.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

async function fixture(persistSession: boolean, budget: number) {
  const cwd = await mkdtemp(join(tmpdir(), 'sdk-collaboration-discovery-'));
  directories.push(cwd);
  const calls: string[] = [];
  const requests: Array<{ child: boolean; request: ProviderRequest }> = [];
  const flags = new Set<string>();
  let sequence = 0;
  const target = 'mcp__records__lookup';
  const provider: LlmProvider = {
    id: 'collaboration-discovery', name: 'Local discovery fixture',
    capabilities: () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: false,
      pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
    async createMessage() { throw new Error('Unexpected summary for the bounded fixture'); },
    async *createMessageStream(request): AsyncGenerator<StreamEvent> {
      const child = JSON.stringify(request.systemPrompt).includes('You are collaborator');
      requests.push({ child, request: structuredClone(request) });
      const history = JSON.stringify(request.messages);
      const second = history.includes('REUSE_RECORD');
      const once = (key: string) => { if (flags.has(key)) return false; flags.add(key); return true; };
      let call: { name: string; input: Record<string, unknown> } | undefined;
      let text = child ? 'Report sent.' : history.includes('SECOND_DONE') ? 'FINISHED_SECOND' : history.includes('FIRST_DONE') ? 'FINISHED_FIRST' : 'The collaborator is working.';
      if (!child && once('spawn')) call = { name: 'mcp__halo-team__spawn_agent', input: { name: 'reader', prompt: 'Read a record and report FIRST_DONE to lead.' } };
      else if (child && !second && once('search')) call = { name: 'ToolSearch', input: { query: `select:${target}` } };
      else if (child && once(second ? 'second-call' : 'first-call')) call = { name: 'CallTool', input: { tool: target, arguments: JSON.stringify({ value: second ? 'second' : 'first' }) } };
      else if (child && once(second ? 'second-report' : 'first-report')) call = { name: 'mcp__halo-team__team_send', input: { to: TEAM_LEAD_ADDRESS, message: second ? 'SECOND_DONE' : 'FIRST_DONE' } };
      else if (!child && flags.has('first-report') && history.includes('FIRST_DONE') && once('parent-call')) call = { name: 'CallTool', input: { tool: target, arguments: '{"value":"undiscovered-parent"}' } };
      else if (!child && history.includes('SECOND_REQUEST') && once('send-second')) call = { name: 'mcp__halo-team__team_send', input: { to: 'reader', message: 'REUSE_RECORD: call the already discovered record tool and report SECOND_DONE.' } };
      const id = `frame-${++sequence}`;
      yield { type: 'message_start', id, model: request.model, usage: { input_tokens: 10, output_tokens: 10 } };
      yield { type: 'content_block_start', index: 0, content_block: call
        ? { type: 'tool_use', id, name: call.name, input: call.input } : { type: 'text', text } };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', stopReason: call ? 'tool_use' : 'end_turn' };
      yield { type: 'message_stop' };
    },
  };
  const session = await createSession({ cwd, env: { HOME: cwd, CLAUDE_CONFIG_DIR: join(cwd, 'records') },
    provider, model: 'fixture', tools: [], settingSources: [], persistSession, toolResultBudget: budget,
    permissionMode: 'bypassPermissions', maxTurns: 30, turnEndChecks: { completion: false, openWork: false },
    systemPrompt: 'You are the source assistant.', collaboration: { mode: 'local', maxIdleSessions: 0 },
    mcpServers: { records: createSdkMcpServer({ name: 'records', instructions: 'Keep the complete record guide.', tools: [
      tool('lookup', 'Complete record definition. '+ 'detail '.repeat(220), { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
        async ({ value }: { value: string }) => { calls.push(value); return { content: [{ type: 'text' as const, text: `Receipt ${value}` }] }; }),
    ] }) }, toolDiscovery: { services: { records: { identity: 'records-installation', loading: 'deferred', summary: 'Read records.' } } },
  });
  return { session, requests, calls, target };
}

async function continuationFixture(mode: 'query' | 'session', loading: 'deferred' | 'eager', changeDirectory = false) {
  const cwd = await mkdtemp(join(tmpdir(), 'sdk-source-discovery-'));
  directories.push(cwd);
  const requests: ProviderRequest[] = [];
  const calls: string[] = [];
  const frames: SDKMessage[] = [];
  const target = 'mcp__records__lookup';
  const prompt = 'Delegate a bounded task, then use the record tool.';
  let sequence = 0;
  let parentStep = 0;
  let releaseChild!: () => void;
  const childGate = new Promise<void>(resolve => { releaseChild = resolve; });
  let control!: Query;
  let server: Server | undefined;
  const loop = queryLoopModule.queryLoop;
  const histories: Parameters<typeof loop>[3][] = [];
  const spy = vi.spyOn(queryLoopModule, 'queryLoop').mockImplementation(async function* (...args) {
    const source = !JSON.stringify(args[0].systemPrompt).includes('You are collaborator');
    if (source) histories.push(structuredClone(args[3]));
    yield* loop(...args);
    // Deliver only after the real source loop exits, forcing automatic continuation.
    if (source) releaseChild();
  });
  const provider: LlmProvider = {
    id: 'source-discovery', name: 'Scripted source continuation',
    capabilities: () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: false,
      pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
    async createMessage() { throw new Error('Unexpected summary in a bounded continuation'); },
    async *createMessageStream(request): AsyncGenerator<StreamEvent> {
      const child = JSON.stringify(request.systemPrompt).includes('You are collaborator');
      if (child) await childGate;
      else requests.push(structuredClone(request));
      let call: { name: string; input: Record<string, unknown> } | undefined;
      if (!child) {
        const step = parentStep++;
        if (step === 0) call = { name: 'mcp__halo-team__spawn_agent', input: { name: 'reader', prompt: 'Report completion.' } };
        else if (step === 1 && loading === 'deferred') {
          if (changeDirectory) await control.toggleMcpServer('archive', false);
          call = { name: 'ToolSearch', input: { query: `select:${target}` } };
        } else if (step === (loading === 'deferred' ? 3 : 2)) call = loading === 'deferred'
          ? { name: 'CallTool', input: { tool: target, arguments: '{"value":"continued"}' } }
          : { name: target, input: { value: 'continued' } };
      }
      const id = `continuation-${++sequence}`;
      yield { type: 'message_start', id, model: request.model, usage: { input_tokens: 10, output_tokens: 10 } };
      yield { type: 'content_block_start', index: 0, content_block: call
        ? { type: 'tool_use', id, name: call.name, input: call.input }
        : { type: 'text', text: child ? 'Child completed.' : 'Source completed.' } };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', stopReason: call ? 'tool_use' : 'end_turn' };
      yield { type: 'message_stop' };
    },
  };
  const options: Options = {
    cwd, env: { HOME: cwd, CLAUDE_CONFIG_DIR: join(cwd, 'config') }, provider, model: 'fixture',
    tools: [], settingSources: [], persistSession: false, permissionMode: 'bypassPermissions', maxTurns: 12,
    turnEndChecks: { completion: false, openWork: false }, systemPrompt: 'You are the source assistant.',
    collaboration: { mode: 'local' },
    mcpServers: { records: createSdkMcpServer({ name: 'records', instructions: 'Keep the record guide.', tools: [
      tool('lookup', 'Read the complete record.', { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
        async ({ value }: { value: string }) => { calls.push(value); return { content: [{ type: 'text' as const, text: `Receipt ${value}` }] }; }),
    ] }) },
    toolDiscovery: { services: { records: { identity: 'records-installation', loading, summary: 'Read records.' } } },
  };
  let session: Awaited<ReturnType<typeof createSession>> | undefined;
  try {
    if (changeDirectory) {
      server = createServer((request, response) => {
        let raw = '';
        request.on('data', data => { raw += data; });
        request.on('end', () => {
          const message = JSON.parse(raw);
          if (message.method === 'notifications/initialized') { response.writeHead(204); response.end(); return; }
          const result = message.method === 'initialize'
            ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'archive', version: '1' } }
            : { tools: [{ name: 'read', description: 'Read archived records.', inputSchema: { type: 'object', properties: {} } }] };
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
        });
      });
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
      options.mcpServers!.archive = { type: 'http', url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp` };
      options.toolDiscovery!.services.archive = { identity: 'archive-installation', loading: 'deferred', summary: 'Read archives.' };
    }
    if (mode === 'session') {
      session = await createSession(options);
      await session.send(prompt);
      control = session.query;
      for await (const frame of session.stream()) frames.push(frame);
    } else {
      control = query({ prompt, options });
      for await (const frame of control) frames.push(frame);
    }
    return { requests, calls, frames, histories, prompt, target };
  } finally {
    releaseChild();
    spy.mockRestore();
    if (session) { session.close(); await session.flush(); }
    if (server) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server!.close(() => resolve()));
    }
  }
}

describe('source tool context across automatic collaboration continuation', () => {
  it.each(['query', 'session'] as const)('%s preserves discovered definitions and CallTool access', async mode => {
    const f = await continuationFixture(mode, 'deferred');
    expect(f.histories).toHaveLength(2);
    expect(f.calls).toEqual(['continued']);
    expect(f.frames.filter(frame => frame.type === 'result')).toMatchObject([{ subtype: 'success', num_turns: 5 }]);
    expect(JSON.stringify(f.requests[3].messages)).toContain('Read the complete record.');
    expect(JSON.stringify(f.requests[3].messages)).toContain('Keep the record guide.');
    expect(JSON.stringify(f.requests[4].messages)).toContain('Receipt continued');
    expect(JSON.stringify(f.requests[4].messages)).toContain('CallTool');
    for (const request of f.requests) expect(request.tools).toEqual(f.requests[0].tools);
  });

  it.each(['query', 'session'] as const)('%s retains the directory and its original prefix order', async mode => {
    const f = await continuationFixture(mode, 'deferred');
    expect(f.histories).toHaveLength(2);
    expect(f.requests.map(request => JSON.stringify(request.messages).includes('Available services'))).toEqual([true, true, true, true, true]);
    for (const request of f.requests) expect(request.messages.slice(0, f.requests[0].messages.length)).toEqual(f.requests[0].messages);
    expect(f.requests[0].messages.at(-1)?.content).toBe(f.prompt);
  });

  it.each(['query', 'session'] as const)('%s retains an empty baseline on the first user message without an extra message', async mode => {
    const f = await continuationFixture(mode, 'eager');
    expect(f.histories).toHaveLength(2);
    const continuation = f.histories[1];
    if (!Array.isArray(continuation)) throw new Error('Continuation must use the retained owner history');
    expect(continuation[0]).toMatchObject({ role: 'user', content: f.prompt,
      toolContext: { baselineAttachment: false, baseline: { directory: '', definitions: [] } } });
    expect(f.requests[0].messages.filter(message => !message.isMeta)).toEqual([{ role: 'user', content: f.prompt }]);
    expect(f.requests[0].messages.every(message => message.content !== '')).toBe(true);
    expect(f.calls).toEqual(['continued']);
  });

  it.each(['query', 'session'] as const)('%s retains directory changes in order without revoking unchanged discoveries', async mode => {
    const f = await continuationFixture(mode, 'deferred', true);
    expect(f.histories).toHaveLength(2);
    expect(f.calls).toEqual(['continued']);
    const changed = f.requests[3];
    expect(changed.messages.slice(0, f.requests[2].messages.length)).toEqual(f.requests[2].messages);
    const directories = changed.messages.filter(message => typeof message.content === 'string' && message.content.includes('Available services'));
    expect(directories).toHaveLength(2);
    expect(directories[0].content).toContain('Read archives.');
    expect(directories[1].content).not.toContain('Read archives.');
    expect(f.requests[4].messages.slice(0, changed.messages.length)).toEqual(changed.messages);
  });
});

describe('collaborator tool context', () => {
  it.each([false, true])('restores independent discoveries after idle retirement, persistent=%s', async persist => {
    const f = await fixture(persist, 8192);
    try {
      await f.session.send('Delegate the record lookup.');
      for await (const _frame of f.session.stream()) { /* consume the complete collaboration */ }
      expect(f.calls).toEqual(['first']);
      expect(f.requests.filter(item => !item.child).some(item => JSON.stringify(item.request.messages).includes('has not been discovered'))).toBe(true);
      await f.session.send('SECOND_REQUEST');
      for await (const _frame of f.session.stream()) { /* consume the continued collaboration */ }
      expect(f.calls).toEqual(['first', 'second']);
      const child = f.requests.filter(item => item.child);
      expect(child[0].request.tools?.some(tool => tool.name === f.target)).toBe(false);
      expect(child[0].request.tools?.map(tool => tool.name)).toEqual(expect.arrayContaining(['ToolSearch', 'CallTool']));
      const resumed = child.find(item => JSON.stringify(item.request.messages).includes('REUSE_RECORD'))!;
      expect(JSON.stringify(resumed.request.messages)).toContain('Complete record definition.');
      expect(JSON.stringify(resumed.request.messages)).toContain('Keep the complete record guide.');
    } finally { f.session.close(); await f.session.flush(); }
  });

  it('inherits the discovery result budget and refuses a partial definition', async () => {
    const f = await fixture(false, 512);
    try {
      await f.session.send('Delegate the record lookup.');
      for await (const _frame of f.session.stream()) { /* consume the bounded refusal */ }
      expect(f.calls).toEqual([]);
      const child = f.requests.filter(item => item.child);
      expect(child[0].request.tools?.map(tool => tool.name)).toContain('ToolSearch');
      expect(JSON.stringify(child.at(-1)?.request.messages)).not.toContain('Complete record definition.');
      expect(JSON.stringify(child.at(-1)?.request.messages)).toContain('fit');
    } finally { f.session.close(); await f.session.flush(); }
  });
});
