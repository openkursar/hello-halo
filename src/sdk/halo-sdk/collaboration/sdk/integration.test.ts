import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSession, query } from '../../index.js';
import { TEAM_LEAD_ADDRESS } from '../addressing.js';
import type { SessionCheckpoint } from '../../core/session-checkpoint.js';
import type { Options, LlmProvider, ProviderRequest, StreamEvent, SDKMessage } from '../../index.js';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'halo-collaboration-sdk-'));
  await writeFile(join(directory, 'facts.txt'), 'EVIDENCE_READ: 42');
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function fixture() {
  const requests: Array<{ child: boolean; request: ProviderRequest }> = [];
  let spawned = false;
  let read = false;
  let reported = false;
  let followupSent = false;
  let followupReported = false;
  let sequence = 0;
  const provider: LlmProvider = {
    id: 'collaboration-test', name: 'Scripted collaboration endpoint',
    capabilities: () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: false, pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
    async createMessage() { throw new Error('Unexpected summary in a small fixture'); },
    async *createMessageStream(request): AsyncGenerator<StreamEvent> {
      const child = JSON.stringify(request.systemPrompt).includes('You are collaborator');
      requests.push({ child, request });
      const history = JSON.stringify(request.messages);
      let call: { name: string; input: Record<string, unknown> } | undefined;
      let text = 'No additional action.';
      if (!child && !spawned) {
        spawned = true;
        call = { name: 'mcp__halo-team__spawn_agent', input: { name: 'reader', prompt: 'Read facts.txt and send the evidence to lead. Do not edit files.' } };
      } else if (child && !read) {
        read = true;
        call = { name: 'Read', input: { file_path: join(directory, 'facts.txt') } };
      } else if (child && !reported) {
        reported = true;
        call = { name: 'mcp__halo-team__team_send', input: { to: 'lead', message: history.includes('EVIDENCE_READ: 42') ? 'EVIDENCE_READ: 42; verified from the file.' : 'File evidence unavailable.' } };
      } else if (!child && history.includes('FOLLOWUP_REQUEST') && !followupSent) {
        followupSent = true;
        call = { name: 'mcp__halo-team__team_send', input: { to: 'reader', message: 'SECOND_ASSIGNMENT: recall the evidence you read before.' } };
      } else if (child && history.includes('SECOND_ASSIGNMENT') && !followupReported) {
        followupReported = true;
        call = { name: 'mcp__halo-team__team_send', input: { to: 'lead', message: history.includes('EVIDENCE_READ: 42') ? 'RESTORED_MEMBER_CONTEXT' : 'History unavailable.' } };
      } else if (!child && history.includes('RESTORED_MEMBER_CONTEXT')) text = 'CONTINUATION_VERIFIED';
      else if (!child && history.includes('EVIDENCE_READ: 42')) text = 'VERIFIED_FROM_MEMBER';
      else if (child) text = 'Report sent.';
      const id = String(++sequence);
      const usage = { input_tokens: 10, output_tokens: 10 };
      yield { type: 'message_start', id: `message-${id}`, model: request.model, usage };
      yield { type: 'content_block_start', index: 0, content_block: call
        ? { type: 'tool_use', id: `call-${id}`, name: call.name, input: call.input }
        : { type: 'text', text } };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', stopReason: call ? 'tool_use' : 'end_turn', usage };
      yield { type: 'message_stop' };
    },
  };
  const options: Options = {
    provider, model: 'fixture', cwd: directory,
    env: { HOME: directory, CLAUDE_CONFIG_DIR: join(directory, 'config') },
    systemPrompt: 'You are the source assistant.', settingSources: [],
    permissionMode: 'bypassPermissions', turnEndChecks: { openWork: false, completion: false },
    modelPricing: { fixture: { inputPerMtk: 1, outputPerMtk: 1, cacheCreationPerMtk: 1, cacheReadPerMtk: 1 } },
    collaboration: { mode: 'local', maxConcurrentTurns: 2, maxMembers: 4 },
  };
  return { options, requests };
}

describe('SDK collaboration through real sessions and file tools', () => {
  for (const mode of ['query', 'session'] as const) it(`${mode}: dispatches, receives results and preserves context isolation without polling`, async () => {
    const f = fixture();
    const frames: SDKMessage[] = [];
    if (mode === 'query') {
      for await (const frame of query({ prompt: 'SOURCE_ONLY_PRIVATE_CONTEXT. Investigate the file with a collaborator.', options: f.options })) frames.push(frame);
    } else {
      const session = await createSession(f.options);
      try {
        await session.send('SOURCE_ONLY_PRIVATE_CONTEXT. Investigate the file with a collaborator.');
        for await (const frame of session.stream()) frames.push(frame);
      } finally { session.close(); await session.flush(); }
    }
    expect(frames.some(frame => frame.type === 'result' && frame.subtype === 'success' && frame.result.includes('VERIFIED_FROM_MEMBER'))).toBe(true);
    const terminal = frames.filter((frame): frame is Extract<SDKMessage, { type: 'result' }> => frame.type === 'result');
    expect(terminal).toHaveLength(1);
    expect(terminal[0].usage.input_tokens + terminal[0].usage.output_tokens).toBe(f.requests.length * 20);
    expect(terminal[0].total_cost_usd).toBeCloseTo(f.requests.length * 0.00002, 8);
    const children = f.requests.filter(entry => entry.child);
    expect(children.length).toBeGreaterThan(1);
    expect(children.every(entry => !JSON.stringify(entry.request.messages).includes('SOURCE_ONLY_PRIVATE_CONTEXT'))).toBe(true);
    expect(children.every(entry => entry.request.model === 'fixture')).toBe(true);
    expect(children[0].request.tools?.some(tool => tool.name === 'mcp__halo-team__spawn_agent')).toBe(true);
    const toolNames = f.requests.flatMap(entry => entry.request.tools?.map(tool => tool.name) ?? []);
    expect(toolNames).not.toContain('Agent');
    expect(toolNames).not.toContain('mcp__halo-team__team_wait');
    expect(toolNames).not.toContain('mcp__halo-team__team_complete');
  });

  it('charges source and member requests against one budget instead of granting a budget to each member', async () => {
    const f = fixture();
    const frames: SDKMessage[] = [];
    for await (const frame of query({ prompt: 'Investigate with a collaborator.', options: { ...f.options, maxBudgetUsd: 0.00004 } })) frames.push(frame);
    const results = frames.filter((frame): frame is Extract<SDKMessage, { type: 'result' }> => frame.type === 'result');
    expect(results).toHaveLength(1);
    expect(results[0].subtype).toBe('error_max_budget_usd');
    expect(f.requests.length).toBeLessThanOrEqual(3);
    expect(results[0].total_cost_usd).toBeCloseTo(f.requests.length * 0.00002, 8);
  });

  for (const mode of ['query', 'session'] as const) it(`${mode}: keeps one source turn limit across asynchronous continuations`, async () => {
    const f = fixture();
    const frames: SDKMessage[] = [];
    const options = { ...f.options, maxTurns: 2 };
    if (mode === 'query') {
      for await (const frame of query({ prompt: 'Delegate the investigation.', options })) frames.push(frame);
    } else {
      const session = await createSession(options);
      try {
        await session.send('Delegate the investigation.');
        for await (const frame of session.stream()) frames.push(frame);
        const result = frames.find((frame): frame is Extract<SDKMessage, { type: 'result' }> => frame.type === 'result')!;
        const costs = (await (session as unknown as { command(name: string): Promise<SessionCheckpoint> }).command('captureCheckpoint')).costs;
        expect(costs.totalCostUsd).toBeCloseTo(result.total_cost_usd, 8);
        expect(costs.tokens.input).toBe(result.usage.input_tokens);
        expect(costs.tokens.output).toBe(result.usage.output_tokens);
        expect(costs.numTurns).toBe(1);
        await session.send('/cost');
        const report: SDKMessage[] = [];
        for await (const frame of session.stream()) report.push(frame);
        expect(JSON.stringify(report)).toContain('Turns counted:** 1');
      } finally { session.close(); await session.flush(); }
    }
    const results = frames.filter((frame): frame is Extract<SDKMessage, { type: 'result' }> => frame.type === 'result');
    expect(results).toHaveLength(1);
    expect(results[0].subtype).toBe('error_max_turns');
    expect(results[0].num_turns).toBe(2);
    expect(f.requests.filter(request => !request.child)).toHaveLength(2);
    expect(results[0].total_cost_usd).toBeCloseTo(f.requests.length * 0.00002, 8);
  });

  it('restores the same member and its conversation after the source session closes', async () => {
    const f = fixture();
    const first = await createSession(f.options);
    await first.send('Investigate with a collaborator.');
    for await (const _frame of first.stream()) { /* consume the real execution */ }
    const sessionId = first.sessionId;
    first.close();
    await first.flush();
    const next = await createSession({ ...f.options, resume: sessionId });
    try {
      await next.send('FOLLOWUP_REQUEST: ask the same collaborator to recall its evidence.');
      const frames: SDKMessage[] = [];
      for await (const frame of next.stream()) frames.push(frame);
      expect(frames.some(frame => frame.type === 'result' && frame.subtype === 'success' && frame.result.includes('CONTINUATION_VERIFIED'))).toBe(true);
      const resumedChild = f.requests.find(entry => entry.child && JSON.stringify(entry.request.messages).includes('SECOND_ASSIGNMENT'));
      expect(JSON.stringify(resumedChild?.request.messages)).toContain('EVIDENCE_READ: 42');
    } finally { next.close(); await next.flush(); }
  });

  it('does not create local collaboration tools in an application-hosted SDK session', async () => {
    const f = fixture();
    const session = await createSession({ ...f.options, collaboration: { mode: 'hosted' } });
    try {
      await session.send('Inspect the available tools.');
      for await (const _frame of session.stream()) { /* consume */ }
      expect(f.requests[0].request.tools?.some(tool => tool.name.startsWith('mcp__halo-team__'))).toBe(false);
    } finally { session.close(); await session.flush(); }
  });
});
