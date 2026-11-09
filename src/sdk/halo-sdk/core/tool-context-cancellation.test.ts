import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSession, type SDKSession } from './session.js';
import { createSdkMcpServer, tool } from '../tools/mcp/sdk-server.js';
import { getTranscriptPath, TranscriptWriter } from './transcript.js';
import { readHistoryReport } from './transcript-reader.js';
import { readToolContextSnapshot } from './tool-context/index.js';
import type { ContentBlock, LlmProvider, ProviderRequest, StreamEvent } from '../types/provider.js';
import type { Options } from '../types/config.js';
import type { SDKMessage } from './query-types.js';

const sessions: SDKSession[] = [];
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const session of sessions.splice(0)) await session.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const use = (id: string, name: string, input: Record<string, unknown>): ContentBlock => ({ type: 'tool_use', id, name, input });
const search = use('search', 'ToolSearch', { query: 'select:mcp__crm__lookup' });
const invoke = (id: string) => use(id, 'CallTool', { tool: 'mcp__crm__lookup', arguments: '{ "account": "42" }' });
const done: ContentBlock = { type: 'text', text: 'Done.' };
function script(replies: ContentBlock[][], onSummary?: () => Promise<void>) {
  const requests: ProviderRequest[] = [];
  const provider: LlmProvider = {
    id: 'cancellation-fixture', name: 'Cancellation fixture',
    capabilities: () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: false,
      pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
    createMessage: async request => {
      await onSummary?.();
      return { id: 'summary', model: request.model, content: [{ type: 'text', text: 'Continue the requested work.' }],
        stopReason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } };
    },
    async *createMessageStream(request): AsyncGenerator<StreamEvent> {
      const content = replies[requests.length] ?? [done];
      requests.push({ ...request, messages: structuredClone(request.messages), providerOptions: undefined });
      yield { type: 'message_start', id: `response-${requests.length}`, model: request.model, usage: { input_tokens: 0, output_tokens: 0 } };
      for (const [index, block] of content.entries()) {
        yield { type: 'content_block_start', index, content_block: block };
        yield { type: 'content_block_stop', index };
      }
      yield { type: 'message_delta', stopReason: content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn' };
      yield { type: 'message_stop' };
    },
  };
  return { provider, requests };
}
async function fixture(provider: LlmProvider, options: Partial<Options> = {}, large = false) {
  const cwd = await mkdtemp(join(tmpdir(), 'sdk-discovery-cancel-'));
  directories.push(cwd);
  const execute = vi.fn(async () => ({ content: [{ type: 'text' as const,
    text: large ? 'Verified customer evidence. '.repeat(220) : 'Saved customer receipt.' }] }));
  const config: Options = {
    model: 'fixture', provider, cwd, tools: [], settingSources: [], persistSession: true,
    env: { HOME: cwd, USERPROFILE: cwd, CLAUDE_CONFIG_DIR: join(cwd, 'records') },
    permissionMode: 'bypassPermissions', systemPrompt: 'Follow the requested task.', maxTurns: 20,
    contextWindow: 9000, maxOutputTokens: 512, toolResultBudget: 6000,
    turnEndChecks: { openWork: false, completion: false },
    mcpServers: { crm: createSdkMcpServer({ name: 'crm', instructions: 'Use the selected account.', tools: [
      tool('lookup', 'Find the complete customer order record.', { type: 'object',
        properties: { account: { type: 'string' } }, required: ['account'] }, execute),
    ] }) },
    toolDiscovery: { services: { crm: { identity: 'fixture-crm', loading: 'deferred', summary: 'Customer orders' } } },
    ...options,
  };
  const session = await createSession(config);
  sessions.push(session);
  return { session, config, execute, path: getTranscriptPath(session.sessionId, cwd, config) };
}
async function collect(stream: AsyncIterable<SDKMessage>, events: SDKMessage[] = []) {
  for await (const event of stream) { events.push(event); if (event.type === 'result') break; }
  return events;
}
async function reopen(config: Options, sessionId: string, next: ReturnType<typeof script>) {
  const session = await createSession({ ...config, provider: next.provider, resume: sessionId, strictResume: true, hooks: undefined });
  sessions.push(session);
  await session.send('Continue using the customer tool.');
  return collect(session.stream());
}

describe('tool discovery cancellation ordering', () => {
  it('persists a bounded search error when cancellation interrupts PostToolUse, without granting discovery', async () => {
    const entered = gate(), release = gate();
    const source = script([[search], [done]]);
    const { session, config, execute, path } = await fixture(source.provider, {
      hooks: { PostToolUse: [{ matcher: 'ToolSearch', hooks: [async () => { entered.resolve(); await release.promise; return {}; }] }] },
    });
    await session.send('Find the customer tool.');
    const draining = collect(session.stream());
    try {
      await Promise.race([entered.promise, draining.then(() => { throw new Error('Turn ended before the search hook'); })]);
      await session.interrupt();
      release.resolve();
      const events = await draining;
      expect(events.at(-1)).toMatchObject({ is_error: true });
      const results = events.flatMap(event => event.type === 'user' ? event.message.content : [])
        .filter(block => block.type === 'tool_result' && block.tool_use_id === 'search');
      expect(results).toEqual([expect.objectContaining({ is_error: true, content: expect.stringContaining('No new definitions were loaded') })]);
      expect(JSON.stringify(results)).not.toContain('input_schema');
      await session.close();
      const restored = await readHistoryReport(path);
      expect(restored.toolContextDamaged).toBeUndefined();
      expect(readToolContextSnapshot(restored.messages)?.definitions).toEqual([]);
      expect(restored.messages.some(message => message.toolContext?.presentations?.length || message.toolContext?.discoveries?.length)).toBe(false);
      const next = script([[invoke('after-cancel')], [done]]);
      expect((await reopen(config, session.sessionId, next)).at(-1)).toMatchObject({ is_error: false });
      expect(execute).not.toHaveBeenCalled();
      expect(JSON.stringify(next.requests[1].messages)).toContain('not been discovered');
    } finally { release.resolve(); await draining; }
  }, 10000);

  it.each(['before-write', 'after-write'] as const)('commits a submitted discovery result after cancellation arrives %s', async stage => {
    const entered = gate(), release = gate();
    const append = TranscriptWriter.prototype.writeUserMessage;
    vi.spyOn(TranscriptWriter.prototype, 'writeUserMessage').mockImplementation(async function (this: TranscriptWriter, message, options) {
      if (!message.toolContext?.discoveries?.length) return append.call(this, message, options);
      if (stage === 'before-write') { entered.resolve(); await release.promise; }
      const uuid = await append.call(this, message, options);
      if (stage === 'after-write') { entered.resolve(); await release.promise; }
      return uuid;
    });
    const source = script([[search], [done]]);
    const { session, config, execute, path } = await fixture(source.provider);
    await session.send('Find the customer tool.');
    const draining = collect(session.stream());
    try {
      await Promise.race([entered.promise, draining.then(() => { throw new Error('Turn ended before discovery append'); })]);
      expect(source.requests).toHaveLength(1);
      await session.interrupt();
      release.resolve();
      expect((await draining).at(-1)).toMatchObject({ is_error: true });
      await session.close();
      expect(readToolContextSnapshot((await readHistoryReport(path)).messages)?.definitions).toHaveLength(1);
      const next = script([[invoke('after-append')], [done]]);
      expect((await reopen(config, session.sessionId, next)).at(-1)).toMatchObject({ is_error: false });
      expect(execute).toHaveBeenCalledOnce();
      expect(next.requests).toHaveLength(2);
    } finally { release.resolve(); await draining; }
  }, 10000);

  it('preserves a completed business result when cancellation interrupts its output hook', async () => {
    const entered = gate(), release = gate();
    const source = script([[search], [invoke('business')], [done]]);
    const { session, path, execute } = await fixture(source.provider, {
      hooks: { PostToolUse: [{ matcher: 'mcp__crm__lookup', hooks: [async () => {
        entered.resolve(); await release.promise; return {};
      }] }] },
    });
    await session.send('Find and use the customer tool.');
    const draining = collect(session.stream());
    try {
      await Promise.race([entered.promise, draining.then(() => { throw new Error('Turn ended before the business output hook'); })]);
      expect(execute).toHaveBeenCalledOnce();
      await session.interrupt();
      release.resolve();
      const events = await draining;
      expect(events.at(-1)).toMatchObject({ is_error: true });
      const results = events.flatMap(event => event.type === 'user' ? event.message.content : [])
        .filter(block => block.type === 'tool_result' && block.tool_use_id === 'business');
      expect(results).toEqual([expect.objectContaining({ content: 'Saved customer receipt.' })]);
      expect(results.every(block => block.type === 'tool_result' && !block.is_error)).toBe(true);
      await session.close();
      const history = await readHistoryReport(path);
      expect(history.toolContextDamaged).toBeUndefined();
      expect(readToolContextSnapshot(history.messages)?.definitions).toHaveLength(1);
      expect(execute).toHaveBeenCalledOnce();
    } finally { release.resolve(); await draining; }
  }, 10000);

  it('keeps the original journal when cancellation precedes compact checkpoint submission', async () => {
    const entered = gate(), release = gate();
    const source = script([[search], ...Array.from({ length: 8 }, (_, index) => [invoke(`call-${index}`)]), [done]],
      async () => { entered.resolve(); await release.promise; });
    const checkpoint = vi.spyOn(TranscriptWriter.prototype, 'writeCompactCheckpoint');
    const { session, path } = await fixture(source.provider, {}, true);
    await session.send('Collect the customer evidence.');
    const observed: SDKMessage[] = [];
    const draining = collect(session.stream(), observed);
    try {
      await Promise.race([entered.promise, draining.then(() => { throw new Error('Turn ended before summarization'); })]);
      const before = await readFile(path, 'utf8');
      await session.interrupt();
      release.resolve();
      expect((await draining).at(-1)).toMatchObject({ is_error: true });
      await session.close();
      expect(checkpoint).not.toHaveBeenCalled();
      expect(observed.some(event => event.type === 'system' && event.subtype === 'compact_boundary')).toBe(false);
      expect((await readFile(path, 'utf8')).startsWith(before)).toBe(true);
      expect(readToolContextSnapshot((await readHistoryReport(path)).messages)?.definitions).toHaveLength(1);
    } finally { release.resolve(); await draining; }
  }, 10000);

  it.each(['before-write', 'after-write'] as const)('installs the same compact checkpoint when cancellation arrives %s after submission', async stage => {
    const entered = gate(), release = gate();
    const append = TranscriptWriter.prototype.writeCompactCheckpoint;
    vi.spyOn(TranscriptWriter.prototype, 'writeCompactCheckpoint').mockImplementation(async function (this: TranscriptWriter, messages, summary) {
      if (stage === 'before-write') { entered.resolve(); await release.promise; }
      await append.call(this, messages, summary);
      if (stage === 'after-write') { entered.resolve(); await release.promise; }
    });
    const source = script([[search], ...Array.from({ length: 8 }, (_, index) => [invoke(`call-${index}`)]), [done]]);
    const { session, config, execute, path } = await fixture(source.provider, {}, true);
    await session.send('Collect the customer evidence.');
    const observed: SDKMessage[] = [];
    const draining = collect(session.stream(), observed);
    try {
      await Promise.race([entered.promise, draining.then(() => { throw new Error('Turn ended before checkpoint append'); })]);
      const requests = source.requests.length;
      const effects = execute.mock.calls.length;
      expect(observed.some(event => event.type === 'system' && event.subtype === 'compact_boundary')).toBe(false);
      await session.interrupt();
      release.resolve();
      expect((await draining).at(-1)).toMatchObject({ is_error: true });
      expect(source.requests).toHaveLength(requests);
      expect(observed.some(event => event.type === 'system' && event.subtype === 'compact_boundary')).toBe(true);
      await session.close();
      const journal = await readFile(path, 'utf8');
      expect(journal).toContain('compact_checkpoint');
      expect(readToolContextSnapshot((await readHistoryReport(path)).messages)?.definitions).toHaveLength(1);
      const next = script([[invoke('after-checkpoint')], [done]]);
      expect((await reopen(config, session.sessionId, next)).at(-1)).toMatchObject({ is_error: false });
      expect(execute).toHaveBeenCalledTimes(effects + 1);
    } finally { release.resolve(); await draining; }
  }, 10000);
});
