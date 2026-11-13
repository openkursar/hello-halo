import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession, createSdkMcpServer, tool, type LlmProvider, type ProviderRequest, type StreamEvent } from '../../index.js';
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
