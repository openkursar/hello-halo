import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { queryLoop, resolveQueryConfig, createSdkMcpServer, tool, extractSdkMcpTools } from '../index.js';
import type { Tool } from '../types/tool.js';
import type { Options } from '../types/config.js';
import type { LlmProvider, ProviderRequest, StreamEvent } from '../types/provider.js';
import type { SDKMessage } from './query-types.js';

const directories: string[] = [];
const releases: Array<() => void> = [];
const controllers: AbortController[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const controller of controllers.splice(0)) controller.abort();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  releases.push(release);
  return { promise, release };
}
async function reached(promise: Promise<void>) {
  let timeout!: ReturnType<typeof setTimeout>;
  try { await Promise.race([promise, new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Expected execution boundary was not reached')), 5000); })]); }
  finally { clearTimeout(timeout); }
}
function* block(index: number, id: string, name: string, input: Record<string, unknown>): Generator<StreamEvent> {
  yield { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } };
  const json = JSON.stringify(input);
  yield { type: 'input_json_delta', index, partialJson: json.slice(0, 13) };
  yield { type: 'input_json_delta', index, partialJson: json.slice(13) };
  yield { type: 'content_block_stop', index };
}
const real = (name = 'operate') => `mcp__fixture__${name}`;
const wrapped = (index: number, id: string, label: string, mode = 'read', name = 'operate') =>
  block(index, id, 'CallTool', { tool: real(name), arguments: JSON.stringify({ label, mode }) });
function tools(handler: (input: Record<string, unknown>) => Promise<void>, write = false): Tool[] {
  const schema = { type: 'object', properties: { label: { type: 'string' }, mode: { type: 'string' } }, required: ['label', 'mode'] };
  return extractSdkMcpTools({ fixture: createSdkMcpServer({ name: 'fixture', tools: [
    tool('operate', 'Read a fixture.', schema, async input => { await handler(input); return { content: [{ type: 'text', text: String(input.label) }] }; },
      { annotations: { readOnlyHint: true } }),
    ...(write ? [tool('write', 'Write a fixture.', schema, async input => { await handler(input); return { content: [{ type: 'text', text: String(input.label) }] }; },
      { annotations: { readOnlyHint: false } })] : []),
  ] }) });
}
async function harness(pool: Tool[], produce: () => AsyncGenerator<StreamEvent>, overrides: Partial<Options> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'wrapped-concurrency-')); directories.push(cwd);
  const abortController = new AbortController(); controllers.push(abortController);
  const requests: ProviderRequest[] = [];
  let stopped = false;
  const provider: LlmProvider = {
    id: 'concurrency-fixture', name: 'Concurrency fixture',
    capabilities: () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: false,
      pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
    createMessage: async () => { throw new Error('Unexpected summary request'); },
    async *createMessageStream(request) {
      requests.push(structuredClone({ ...request, providerOptions: undefined }));
      const turn = requests.length;
      yield { type: 'message_start', id: `response-${turn}`, model: request.model, usage: { input_tokens: 0, output_tokens: 0 } };
      if (turn === 1) yield* block(0, 'discover', 'ToolSearch', { query: 'select:' + pool.map(item => item.name).join(' '), max_results: 10 });
      else if (turn === 2) yield* produce();
      else {
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Done.' } };
        yield { type: 'content_block_stop', index: 0 };
      }
      yield { type: 'message_delta', stopReason: turn <= 2 ? 'tool_use' : 'end_turn' };
      if (turn === 2) stopped = true;
      yield { type: 'message_stop' };
    },
  };
  const config = resolveQueryConfig({ model: 'fixture', cwd, env: { HOME: cwd, USERPROFILE: cwd },
    tools: [], settingSources: [], persistSession: false, systemPrompt: 'Follow the user request.',
    permissionMode: 'default', includePartialMessages: true, maxTurns: 5, abortController,
    canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }), turnEndChecks: { openWork: false, completion: false },
    toolDiscovery: { services: { fixture: { identity: 'installed', loading: 'deferred' } } }, ...overrides });
  const events: SDKMessage[] = [];
  const task = (async () => {
    for await (const event of queryLoop({ ...config, abortSignal: abortController.signal }, provider, pool, 'Operate the fixture.')) events.push(event);
    return events;
  })();
  return { task, requests, events, stopped: () => stopped };
}
function modelCalls(request: ProviderRequest) {
  return request.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === 'tool_use');
}

describe('wrapped calls use the real tool scheduler', () => {
  it('starts each completed wrapper before the provider ends and overlaps read-only MCP calls', async () => {
    const first = gate(); const both = gate(); const finishFirst = gate(); const finishSecond = gate();
    const active = new Set<string>();
    const beforeStop: boolean[] = [];
    let current!: Awaited<ReturnType<typeof harness>>;
    const pool = tools(async input => {
      active.add(String(input.label)); beforeStop.push(!current.stopped());
      if (active.size === 2) both.release();
      first.release();
      await (input.label === 'one' ? finishFirst.promise : finishSecond.promise);
      active.delete(String(input.label));
    });
    current = await harness(pool, async function* () {
      yield* wrapped(0, 'one', 'one');
      await first.promise;
      yield { type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'Reading the second record.' } };
      yield { type: 'content_block_stop', index: 1 };
      yield* wrapped(2, 'two', 'two');
      await both.promise;
    });
    await reached(both.promise);
    expect([...active]).toEqual(['one', 'two']);
    expect(beforeStop).toEqual([true, true]);
    expect(current.requests).toHaveLength(2);
    finishSecond.release(); finishFirst.release();
    const events = await current.task;
    expect(events.at(-1)).toMatchObject({ is_error: false });
    expect(current.requests[2].tools).toEqual(current.requests[0].tools);
    expect(modelCalls(current.requests[2]).filter(call => call.name === 'CallTool').map(call => call.id)).toEqual(['one', 'two']);
  });

  it('keeps an unsafe real MCP tool between the preceding and following reads', async () => {
    const start = { one: gate(), write: gate(), two: gate() };
    const finish = { one: gate(), write: gate(), two: gate() };
    const order: string[] = [];
    const pool = tools(async input => {
      const label = input.label as keyof typeof start;
      order.push(`start:${label}`); start[label].release();
      await finish[label].promise;
      order.push(`end:${label}`);
    }, true);
    const current = await harness(pool, async function* () {
      yield* wrapped(0, 'one', 'one'); yield* wrapped(1, 'write', 'write', 'write', 'write'); yield* wrapped(2, 'two', 'two');
    });
    await reached(start.one.promise); await tick();
    expect(order).toEqual(['start:one']);
    finish.one.release(); await reached(start.write.promise); await tick();
    expect(order).toEqual(['start:one', 'end:one', 'start:write']);
    finish.write.release(); await reached(start.two.promise);
    finish.two.release();
    expect((await current.task).at(-1)).toMatchObject({ is_error: false });
    expect(order).toEqual(['start:one', 'end:one', 'start:write', 'end:write', 'start:two', 'end:two']);
  });

  it('uses permission-adjusted input for concurrency while preserving original wrapper arguments', async () => {
    const first = gate(); const second = gate(); const finishFirst = gate(); const finishSecond = gate();
    const order: string[] = [];
    let checkedSecond!: () => void;
    const secondChecked = new Promise<void>(resolve => { checkedSecond = resolve; });
    const check = vi.fn((input: Record<string, unknown>) => {
      if (input.label === 'two' && input.mode === 'write') checkedSecond();
      return input.mode === 'read';
    });
    const pool = tools(async input => {
      order.push(`${input.label}:${input.mode}`);
      (input.label === 'one' ? first : second).release();
      await (input.label === 'one' ? finishFirst.promise : finishSecond.promise);
    }).map(tool => ({ ...tool, isConcurrencySafe: check }));
    const current = await harness(pool, async function* () { yield* wrapped(0, 'one', 'one'); yield* wrapped(1, 'two', 'two'); }, {
      canUseTool: async (name, input) => ({ behavior: 'allow', updatedInput: name === real() && input.label === 'two' ? { mode: 'write' } : {} }),
    });
    await reached(first.promise);
    expect(order).toEqual(['one:read']);
    await reached(secondChecked);
    expect(check.mock.calls.some(([input]) => input.label === 'two' && input.mode === 'write')).toBe(true);
    finishFirst.release(); await reached(second.promise); finishSecond.release();
    expect((await current.task).at(-1)).toMatchObject({ is_error: false });
    expect(order).toEqual(['one:read', 'two:write']);
    expect(modelCalls(current.requests[2]).find(call => call.id === 'two')?.input.arguments).toBe(JSON.stringify({ label: 'two', mode: 'read' }));
  });

  it('allows overlap when permission changes a real input from unsafe to safe', async () => {
    const both = gate(); const finish = gate();
    let active = 0;
    const pool = tools(async () => { active++; if (active === 2) both.release(); await finish.promise; active--; })
      .map(tool => ({ ...tool, isConcurrencySafe: (input: Record<string, unknown>) => input.mode === 'read' }));
    const current = await harness(pool, async function* () { yield* wrapped(0, 'one', 'one', 'write'); yield* wrapped(1, 'two', 'two', 'write'); }, {
      canUseTool: async name => ({ behavior: 'allow', updatedInput: name === real() ? { mode: 'read' } : {} }),
    });
    await reached(both.promise); expect(active).toBe(2); finish.release();
    expect((await current.task).at(-1)).toMatchObject({ is_error: false });
    expect(modelCalls(current.requests[2]).filter(call => call.name === 'CallTool').every(call => String(call.input.arguments).includes('write'))).toBe(true);
  });

  it('keeps hook preparation serialized and checks the real hook-adjusted input', async () => {
    const first = gate(); const second = gate(); const finishFirst = gate(); const finishSecond = gate();
    const seenHooks: string[] = [];
    const check = vi.fn((input: Record<string, unknown>) => input.mode === 'read');
    const pool = tools(async input => {
      (input.label === 'one' ? first : second).release();
      await (input.label === 'one' ? finishFirst.promise : finishSecond.promise);
    }).map(tool => ({ ...tool, isConcurrencySafe: check }));
    const current = await harness(pool, async function* () { yield* wrapped(0, 'one', 'one'); yield* wrapped(1, 'two', 'two'); }, {
      hooks: { PreToolUse: [{ matcher: real(), hooks: [async input => {
        const label = String((input as { tool_input: Record<string, unknown> }).tool_input.label);
        seenHooks.push(label);
        return { updatedInput: { mode: label === 'two' ? 'write' : 'read' } };
      }] }] },
    });
    await reached(first.promise); await tick(); expect(seenHooks).toEqual(['one']);
    finishFirst.release(); await reached(second.promise);
    expect(seenHooks).toEqual(['one', 'two']);
    expect(check.mock.calls.some(([input]) => input.label === 'two' && input.mode === 'write')).toBe(true);
    finishSecond.release(); expect((await current.task).at(-1)).toMatchObject({ is_error: false });
    expect(modelCalls(current.requests[2]).find(call => call.id === 'two')?.input.arguments).toBe(JSON.stringify({ label: 'two', mode: 'read' }));
  });

  it('returns malformed-wrapper errors while continuing other complete calls', async () => {
    const effect = vi.fn(async () => {});
    const current = await harness(tools(effect), async function* () {
      yield* block(0, 'malformed', 'CallTool', { tool: real(), arguments: '{' });
      yield* wrapped(1, 'valid', 'valid');
    });
    const events = await current.task;
    expect(events.at(-1)).toMatchObject({ is_error: false });
    expect(effect).toHaveBeenCalledOnce();
    expect(events.filter(event => event.type === 'user').flatMap(event => event.message.content))
      .toContainEqual(expect.objectContaining({ type: 'tool_result', tool_use_id: 'malformed', is_error: true }));
  });

  it.each(['duplicate-id', 'retry'] as const)('does not replay a completed real effect after %s', async failure => {
    const finished = gate();
    const effect = vi.fn(async () => { finished.release(); });
    const current = await harness(tools(effect), async function* () {
      yield* wrapped(0, 'effect', 'effect');
      await finished.promise; await tick();
      if (failure === 'duplicate-id') yield* wrapped(1, 'effect', 'again');
      else yield { type: 'retry', attempt: 1, maxRetries: 2, delayMs: 0, status: 503, message: 'Injected retry after execution' };
    });
    const events = await current.task;
    expect(events.at(-1)).toMatchObject({ is_error: true });
    expect(current.requests).toHaveLength(2);
    expect(effect).toHaveBeenCalledOnce();
    expect(events.filter(event => event.type === 'user').flatMap(event => event.message.content))
      .toContainEqual(expect.objectContaining({ type: 'tool_result', tool_use_id: 'effect', content: 'effect' }));
  });
});
