import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession, createSdkMcpServer, tool, type SDKSession } from '../index.js';
import type { LlmProvider, ContentBlock, ProviderRequest, StreamEvent } from '../types/provider.js';
import type { Options } from '../types/config.js';
import type { SDKMessage } from './query-types.js';
import { getTranscriptPath } from './transcript.js';
import { readHistoryReport } from './transcript-reader.js';
import { readToolContextSnapshot } from './tool-context/index.js';

const sessions: SDKSession[] = [];
const directories: string[] = [];
afterEach(async () => {
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
    id: 'anchor-fixture', name: 'Anchor fixture',
    capabilities: () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: false,
      pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
    createMessage: async () => { throw new Error('Unexpected summary'); },
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
async function session(options: Options) {
  const current = await createSession(options); sessions.push(current); return current;
}
async function turn(current: SDKSession) {
  await current.send('Use the fixture.');
  const events: SDKMessage[] = [];
  for await (const event of current.stream()) { events.push(event); if (event.type === 'result') break; }
  return events;
}

describe('live discovery-result history anchors', () => {
  it('forks at the actual public result UUID and keeps the preceding assistant boundary undiscovered', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'discovery-anchor-')); directories.push(cwd);
    const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'Read complete.' }] }));
    const first = scripted([[search('initial-search')], [done]]);
    const options: Options = { model: 'fixture', provider: first.provider, cwd,
      env: { HOME: cwd, USERPROFILE: cwd, CLAUDE_CONFIG_DIR: join(cwd, 'records') },
      tools: [], settingSources: [], systemPrompt: 'Follow the user request.', permissionMode: 'bypassPermissions',
      maxTurns: 10, turnEndChecks: { openWork: false, completion: false },
      mcpServers: { fixture: createSdkMcpServer({ name: 'fixture', tools: [tool('lookup', 'Lookup record.', {}, handler)] }) },
      toolDiscovery: { services: { fixture: { identity: 'installation', loading: 'deferred' } } },
    };
    const parent = await session(options);
    const events = await turn(parent);
    const call = events.find(event => event.type === 'assistant' && event.message.content.some(block => block.type === 'tool_use' && block.id === 'initial-search'))!;
    const result = events.find(event => event.type === 'user' && event.message.content.some(block => block.type === 'tool_result' && block.tool_use_id === 'initial-search'))!;
    expect(call?.uuid).toBeTruthy(); expect(result?.uuid).toBeTruthy();
    await parent.close();
    const path = getTranscriptPath(parent.sessionId, cwd, options);
    const original = await readFile(path, 'utf8');
    const entries = original.trim().split('\n').map(line => JSON.parse(line));
    expect(entries.find(entry => entry.uuid === result.uuid)).toMatchObject({ type: 'user', message: {
      toolContext: { discoveries: [{ callId: 'initial-search' }] },
    } });
    const before = await readHistoryReport(path, call.uuid);
    const after = await readHistoryReport(path, result.uuid);
    expect(before.anchorFound).toBe(true); expect(after.anchorFound).toBe(true);
    expect(readToolContextSnapshot(before.messages)?.definitions).toEqual([]);
    expect(readToolContextSnapshot(after.messages)?.definitions.map(item => item.definition.name)).toEqual([target]);

    const known = scripted([[invoke('known-call')], [done]]);
    const afterFork = await session({ ...options, provider: known.provider, resume: parent.sessionId,
      forkSession: true, resumeSessionAt: result.uuid, strictResume: true });
    expect((await turn(afterFork)).at(-1)).toMatchObject({ is_error: false });
    expect(handler).toHaveBeenCalledOnce();
    await afterFork.close();

    const unknown = scripted([[invoke('too-early')], [search('fresh-search')], [invoke('fresh-call')], [done]]);
    const beforeFork = await session({ ...options, provider: unknown.provider, resume: parent.sessionId,
      forkSession: true, resumeSessionAt: call.uuid, strictResume: true });
    const earlierEvents = await turn(beforeFork);
    expect(earlierEvents.at(-1)).toMatchObject({ is_error: false });
    expect(earlierEvents.filter(event => event.type === 'user').flatMap(event => event.message.content))
      .toContainEqual(expect.objectContaining({ type: 'tool_result', tool_use_id: 'too-early', is_error: true }));
    expect(handler).toHaveBeenCalledTimes(2);
    expect(await readFile(path, 'utf8')).toBe(original);
  });
});
