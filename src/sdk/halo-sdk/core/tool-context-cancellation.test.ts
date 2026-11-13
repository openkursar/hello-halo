import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSession, createSdkMcpServer, tool, getSessionMessages, readSessionToolContextMode, type SDKSession } from '../index.js';
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
  return { session, config, execute, path: journalPath(session.sessionId, config) };
}
function journalPath(sessionId: string, config: Options): string {
  return join(config.env!.CLAUDE_CONFIG_DIR!, 'projects', config.cwd!.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
}
/** Public journal views; getSessionMessages exposes no private tool context. */
async function publicJournal(sessionId: string, config: Options) {
  const [page, mode, raw] = await Promise.all([
    getSessionMessages(sessionId, { cwd: config.cwd!, env: config.env }),
    readSessionToolContextMode(sessionId, { cwd: config.cwd!, env: config.env }),
    readFile(journalPath(sessionId, config), 'utf8'),
  ]);
  return { page, mode, raw };
}
/** Raw metadata records, read only after the public view accepted the journal. */
function records(raw: string) {
  return raw.split('\n').filter(Boolean).map(line => JSON.parse(line) as {
    type?: string; message?: { toolContext?: { baseline?: unknown; discoveries?: unknown[]; presentations?: unknown[] } } })
    .filter(record => record.message?.toolContext !== undefined);
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
      const journal = await publicJournal(session.sessionId, config);
      expect(journal.page.length).toBeGreaterThan(0);
      expect(journal.mode).toBe('deferred');
      expect(records(journal.raw).some(record => record.message?.toolContext?.presentations?.length || record.message?.toolContext?.discoveries?.length)).toBe(false);
      expect(journal.raw).not.toContain('input_schema');
      const next = script([[invoke('after-cancel')], [done]]);
      expect((await reopen(config, session.sessionId, next)).at(-1)).toMatchObject({ is_error: false });
      expect(execute).not.toHaveBeenCalled();
      expect(JSON.stringify(next.requests[1].messages)).toContain('not been discovered');
    } finally { release.resolve(); await draining; }
  }, 10000);

  // Cancellation around a discovery append needs a gate inside the journal, which JavaScript
  // cannot reach. These Rust tests cover it with a real session and a local HTTP MCP server:
  //   core::engine::discovery_append_tests::discovery_append_commits_when_cancellation_arrives_before_the_write
  //   core::engine::discovery_append_tests::discovery_append_commits_when_cancellation_arrives_after_the_write

  it('preserves a completed business result when cancellation interrupts its output hook', async () => {
    const entered = gate(), release = gate();
    const source = script([[search], [invoke('business')], [done]]);
    const { session, config, execute } = await fixture(source.provider, {
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
      const journal = await publicJournal(session.sessionId, config);
      expect(journal.page.some(message => JSON.stringify(message).includes('Saved customer receipt.'))).toBe(true);
      expect(records(journal.raw)).toContainEqual(expect.objectContaining({ message: expect.objectContaining({ toolContext: expect.objectContaining({
        discoveries: [expect.objectContaining({ callId: 'search' })],
      }) }) }));
      expect(execute).toHaveBeenCalledOnce();
    } finally { release.resolve(); await draining; }
  }, 10000);

  it('keeps the original journal when cancellation precedes compact checkpoint submission', async () => {
    const entered = gate(), release = gate();
    const source = script([[search], ...Array.from({ length: 8 }, (_, index) => [invoke(`call-${index}`)]), [done]],
      async () => { entered.resolve(); await release.promise; });
    const { session, config, path } = await fixture(source.provider, {}, true);
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
      expect(observed.some(event => event.type === 'system' && event.subtype === 'compact_boundary')).toBe(false);
      const after = await readFile(path, 'utf8');
      expect(after.startsWith(before)).toBe(true);
      expect(after.split('compact_checkpoint').length).toBe(before.split('compact_checkpoint').length);
      const journal = await publicJournal(session.sessionId, config);
      expect(journal.mode).toBe('deferred');
      expect(records(journal.raw).some(record => record.message?.toolContext?.discoveries?.length)).toBe(true);
    } finally { release.resolve(); await draining; }
  }, 10000);


});
