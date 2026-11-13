import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession, createSdkMcpServer, tool, type SDKSession } from '../index.js';
import type { Options } from '../types/config.js';
import type { ContentBlock, LlmProvider, ProviderRequest, StreamEvent } from '../types/provider.js';
import type { SDKMessage } from './query-types.js';
import { getTranscriptPath } from './transcript.js';
import { journalContext } from './tool-context-journal.fixture.js';

const sessions: SDKSession[] = [];
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const session of sessions.splice(0)) await session.close();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
const target = 'mcp__fixture__lookup';
const use = (id: string, name: string, input: Record<string, unknown>): ContentBlock => ({ type: 'tool_use', id, name, input });
const search = (id: string) => use(id, 'ToolSearch', { query: `select:${target}` });
const invoke = (id: string) => use(id, 'CallTool', { tool: target, arguments: '{}' });
const done: ContentBlock = { type: 'text', text: 'Done.' };
function scripted(replies: ContentBlock[][]) {
  const requests: ProviderRequest[] = [];
  const provider: LlmProvider = {
    id: 'clear-fixture', name: 'Clear fixture',
    capabilities: () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: false,
      pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
    createMessage: async () => { throw new Error('Clear must not call a model for a summary'); },
    async *createMessageStream(request): AsyncGenerator<StreamEvent> {
      const content = replies[requests.length] ?? [done];
      requests.push(structuredClone({ ...request, providerOptions: undefined }));
      yield { type: 'message_start', id: `response-${requests.length}`, model: request.model, usage: { input_tokens: 0, output_tokens: 0 } };
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
async function fixture(replies: ContentBlock[][] = [[search('before-search')], [invoke('before-call')], [done]]) {
  const cwd = await mkdtemp(join(tmpdir(), 'tool-context-clear-')); directories.push(cwd);
  const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'Read complete.' }] }));
  const model = scripted(replies);
  const options: Options = { cwd, model: 'fixture', provider: model.provider,
    env: { HOME: cwd, USERPROFILE: cwd, CLAUDE_CONFIG_DIR: join(cwd, 'records') }, tools: [], settingSources: [],
    permissionMode: 'bypassPermissions', systemPrompt: 'Follow the user request.', maxTurns: 10,
    turnEndChecks: { openWork: false, completion: false },
    mcpServers: { fixture: createSdkMcpServer({ name: 'fixture', tools: [tool('lookup', 'Private complete lookup definition.', {}, handler)] }) },
    toolDiscovery: { services: { fixture: { identity: 'installation', loading: 'deferred', summary: 'Fixture records.' } } },
  };
  const session = await createSession(options); sessions.push(session);
  return { session, options, handler, requests: model.requests };
}
async function turn(session: SDKSession, input: string) {
  await session.send(input);
  const events: SDKMessage[] = [];
  for await (const event of session.stream()) { events.push(event); if (event.type === 'result') break; }
  return events;
}
const path = (session: SDKSession, options: Options) => getTranscriptPath(session.sessionId, options.cwd!, options);
const persisted = (session: SDKSession, options: Options) =>
  journalContext(session.sessionId, path(session, options), { cwd: options.cwd!, env: options.env ?? {} });

describe('clear is durable for versioned tool context', () => {
  it.each([false, true])('does not restore cleared definitions, calls or user context (later input=%s)', async laterInput => {
    const current = await fixture();
    expect((await turn(current.session, 'BEFORE_CLEAR_CONTEXT')).at(-1)).toMatchObject({ is_error: false });
    expect(current.handler).toHaveBeenCalledOnce();
    const original = await readFile(path(current.session, current.options), 'utf8');
    expect((await turn(current.session, '/clear')).at(-1)).toMatchObject({ is_error: false });
    expect(current.requests).toHaveLength(3);
    if (laterInput) expect((await turn(current.session, 'AFTER_CLEAR_CONTEXT')).at(-1)).toMatchObject({ is_error: false });
    await current.session.close();
    const active = await persisted(current.session, current.options);
    expect(active.readable).toBe(true);
    expect(active.mode).toBe('deferred');
    expect(active.definitions).toEqual([]);
    expect(active.calls).toEqual([]);
    expect(active.discoveries).toEqual([]);
    expect(JSON.stringify(active.baselines)).not.toContain('BEFORE_CLEAR_CONTEXT');
    expect(JSON.stringify(active.baselines)).not.toContain('before-call');
    const stored = await readFile(path(current.session, current.options), 'utf8');
    expect(stored.startsWith(original)).toBe(true);
    expect(stored).toContain('compact_checkpoint');
    const next = scripted([[invoke('stale-after-reopen')], [search('new-search')], [invoke('new-call')], [done]]);
    const resumed = await createSession({ ...current.options, provider: next.provider, resume: current.session.sessionId, strictResume: true });
    sessions.push(resumed);
    const events = await turn(resumed, 'Use the tool for a new task.');
    expect(events.at(-1)).toMatchObject({ is_error: false });
    expect(events.filter(event => event.type === 'user').flatMap(event => event.message.content))
      .toContainEqual(expect.objectContaining({ type: 'tool_result', tool_use_id: 'stale-after-reopen', is_error: true }));
    expect(current.handler).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(next.requests[0].messages)).not.toContain('BEFORE_CLEAR_CONTEXT');
    expect(JSON.stringify(next.requests[0].messages)).not.toContain('Private complete lookup definition.');
    if (laterInput) expect(JSON.stringify(next.requests[0].messages)).toContain('AFTER_CLEAR_CONTEXT');
  });

  it('retains the prior live and durable state if the clear checkpoint fails', async () => {
    const current = await fixture([[search('before-search')], [done], [invoke('after-failed-clear')], [done]]);
    await turn(current.session, 'BEFORE_CLEAR_CONTEXT');
    const original = await readFile(path(current.session, current.options), 'utf8');
    const transcript = path(current.session, current.options);
    const retained = transcript + '.retained';
    await rename(transcript, retained);
    await mkdir(transcript);
    try {
      expect((await turn(current.session, '/clear')).at(-1)).toMatchObject({ is_error: true });
      expect(await readFile(retained, 'utf8')).toBe(original);
    } finally {
      await rm(transcript, { recursive: true });
      await rename(retained, transcript);
    }
    expect(await readFile(transcript, 'utf8')).toBe(original);
    expect((await turn(current.session, 'Continue after the refused clear.')).at(-1)).toMatchObject({ is_error: false });
    expect(current.handler).toHaveBeenCalledOnce();
    expect(JSON.stringify(current.requests[2].messages)).toContain('BEFORE_CLEAR_CONTEXT');
    await current.session.close();
    expect((await persisted(current.session, current.options)).definitions).toHaveLength(1);
  });

  it('keeps a versioned empty baseline when the resumed host omitted discovery options', async () => {
    const current = await fixture();
    await turn(current.session, 'BEFORE_CLEAR_CONTEXT'); await current.session.close();
    const next = scripted([[done]]);
    const resumed = await createSession({ ...current.options, toolDiscovery: undefined, provider: next.provider,
      resume: current.session.sessionId, strictResume: true });
    sessions.push(resumed);
    expect((await turn(resumed, '/clear')).at(-1)).toMatchObject({ is_error: false });
    await resumed.close();
    const report = await persisted(resumed, current.options);
    expect(report.readable).toBe(true);
    expect(report.baselines.at(-1)).toMatchObject({ definitions: [], discoveryEntries: false });
    expect(JSON.stringify(report.baselines)).not.toContain('BEFORE_CLEAR_CONTEXT');
  });


});
