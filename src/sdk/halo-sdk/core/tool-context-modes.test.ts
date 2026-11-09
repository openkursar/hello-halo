import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession, createSdkMcpServer, tool, type SDKSession } from '../index.js';
import type { Options } from '../types/config.js';
import type { LlmProvider, ProviderRequest, ContentBlock, StreamEvent } from '../types/provider.js';
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
const target = 'mcp__records__lookup';
const initialArguments = '{ "label": "native\\u002dfirst" }';
const use = (id: string, name: string, input: Record<string, unknown>): ContentBlock => ({ type: 'tool_use', id, name, input });
const search = (id: string) => use(id, 'ToolSearch', { query: `select:${target}` });
const invoke = (id: string, label: string, raw?: string) => use(id, 'CallTool', {
  tool: target, arguments: raw ?? JSON.stringify({ label }),
});
const done: ContentBlock = { type: 'text', text: 'Done.' };
function promptCall(mode: 'xml' | 'json', label: string): ContentBlock {
  return { type: 'text', text: mode === 'xml'
    ? `<${target}>\n<param name="label" type="string">${label}</param>\n</${target}>`
    : '```json\n' + JSON.stringify([{ name: target, params: { label } }]) + '\n```' };
}
function scripted(replies: ContentBlock[][]) {
  const requests: ProviderRequest[] = [];
  const summaries: ProviderRequest[] = [];
  const provider: LlmProvider = {
    id: 'mode-fixture', name: 'Mode fixture',
    capabilities: () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: false,
      pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
    async createMessage(request) {
      summaries.push(structuredClone({ ...request, providerOptions: undefined }));
      return { id: `summary-${summaries.length}`, model: request.model,
        content: [{ type: 'text', text: 'Continue the requested work.' }], stopReason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } };
    },
    async *createMessageStream(request): AsyncGenerator<StreamEvent> {
      const content = replies[requests.length] ?? [done];
      requests.push(structuredClone({ ...request, providerOptions: undefined }));
      yield { type: 'message_start', id: `response-${requests.length}`, model: request.model,
        usage: { input_tokens: 0, output_tokens: 0 } };
      for (const [index, block] of content.entries()) {
        yield { type: 'content_block_start', index, content_block: block.type === 'tool_use'
          ? { ...block, input: {} } : block.type === 'text' ? { type: 'text', text: '' } : block };
        if (block.type === 'tool_use') yield { type: 'input_json_delta', index, partialJson: JSON.stringify(block.input) };
        else if (block.type === 'text') {
          yield { type: 'text_delta', index, text: block.text.slice(0, 9) };
          yield { type: 'text_delta', index, text: block.text.slice(9) };
        }
        yield { type: 'content_block_stop', index };
      }
      yield { type: 'message_delta', stopReason: content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn' };
      yield { type: 'message_stop' };
    },
  };
  return { provider, requests, summaries };
}
async function run(options: Options) {
  const session = await createSession(options); sessions.push(session);
  await session.send('Continue the record task.');
  const events: SDKMessage[] = [];
  for await (const event of session.stream()) { events.push(event); if (event.type === 'result') break; }
  await session.close();
  expect(events.at(-1)).toMatchObject({ is_error: false });
  return { session, events };
}
function blocks(request: ProviderRequest) {
  return request.messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
}
function assertPrivateFieldsAbsent(value: unknown) {
  if (Array.isArray(value)) { value.forEach(assertPrivateFieldsAbsent); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    expect(['toolContext', 'historicalDefinitions', 'discoveryEntries', 'definitionVersion'],
      `Unexpected ${key}: ${JSON.stringify(child)?.slice(0, 120)}`).not.toContain(key);
    assertPrivateFieldsAbsent(child);
  }
}

describe('persisted native and prompt-tool mode transitions', () => {
  it.each([
    ['xml', false], ['json', false], ['xml', true], ['json', true],
  ] as const)('returns from %s mode with valid history and fresh discovery (compact=%s)', async (mode, compact) => {
    const cwd = await mkdtemp(join(tmpdir(), 'tool-context-modes-')); directories.push(cwd);
    const effects: string[] = [];
    const handler = vi.fn(async (input: Record<string, unknown>) => {
      effects.push(String(input.label));
      return { content: [{ type: 'text' as const, text: compact && String(input.label).startsWith('alternate-')
        ? 'Recorded evidence. '.repeat(270) : `Recorded ${input.label}.` }] };
    });
    const permission = vi.fn(async (name: string, input: Record<string, unknown>) => name === target && input.label === 'denied'
      ? { behavior: 'deny' as const, message: 'Record permission denied.' }
      : { behavior: 'allow' as const, updatedInput: {} });
    const base: Options = { model: 'fixture', cwd,
      env: { HOME: cwd, USERPROFILE: cwd, CLAUDE_CONFIG_DIR: join(cwd, 'records') },
      tools: [], settingSources: [], systemPrompt: 'Follow the user request.', permissionMode: 'default', canUseTool: permission,
      maxTurns: 25, contextWindow: 11000, maxOutputTokens: 512, toolResultBudget: 6000,
      turnEndChecks: { openWork: false, completion: false },
      mcpServers: { records: createSdkMcpServer({ name: 'records', instructions: 'Use a record label.', tools: [
        tool('lookup', 'Complete record lookup schema.', { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] }, handler),
        tool('unused', 'Unused complete record schema.', { type: 'object', properties: { untouched: { type: 'boolean' } } }, handler),
      ] }) },
      toolDiscovery: { services: { records: { identity: 'record-installation', loading: 'deferred', summary: 'Record operations.' } } },
    };
    const native = scripted([[search('native-search')], [invoke('native-first', 'native-first', initialArguments)], [done]]);
    const first = await run({ ...base, provider: native.provider, toolCallingMode: 'native' });
    const path = getTranscriptPath(first.session.sessionId, cwd, base);
    const original = await readFile(path, 'utf8');
    const alternateCount = compact ? 10 : 1;
    const alternate = scripted([...Array.from({ length: alternateCount }, (_, index) => [promptCall(mode, `alternate-${index}`)]), [done]]);
    const middle = await run({ ...base, provider: alternate.provider, toolCallingMode: mode, resume: first.session.sessionId, strictResume: true });
    expect(effects).toEqual(['native-first', ...Array.from({ length: alternateCount }, (_, index) => `alternate-${index}`)]);
    for (const request of [...alternate.requests, ...alternate.summaries]) {
      expect(request.tools ?? []).toEqual([]);
      const system = JSON.stringify(request.systemPrompt);
      expect(system).toContain('Complete record lookup schema.');
      expect(system).toContain('Unused complete record schema.');
      expect(system).not.toContain('ToolSearch');
      expect(system).not.toContain('CallTool');
      assertPrivateFieldsAbsent(request);
    }
    if (compact) {
      expect(alternate.summaries.length).toBeGreaterThan(0);
      expect(middle.events.some(event => event.type === 'system' && event.subtype === 'compact_boundary')).toBe(true);
    }
    const middleHistory = await readHistoryReport(path);
    expect(middleHistory.toolContextDamaged).toBeUndefined();
    expect(readToolContextSnapshot(middleHistory.messages)).toMatchObject({ definitions: [], discoveryEntries: false });
    expect((await readFile(path, 'utf8')).startsWith(original)).toBe(true);
    const returning = scripted([[invoke('stale-native', 'not-discovered')], [search('return-search')],
      [invoke('native-return', 'native-return')], [invoke('denied-native', 'denied')], [done]]);
    const final = await run({ ...base, provider: returning.provider, toolCallingMode: 'native', resume: first.session.sessionId, strictResume: true });
    expect(effects).toEqual(['native-first', ...Array.from({ length: alternateCount }, (_, index) => `alternate-${index}`), 'native-return']);
    const results = final.events.filter(event => event.type === 'user').flatMap(event => event.message.content)
      .filter(block => block.type === 'tool_result');
    expect(results.find(result => result.tool_use_id === 'stale-native')).toMatchObject({ is_error: true });
    expect(results.find(result => result.tool_use_id === 'denied-native')).toMatchObject({ is_error: true });
    expect(final.events.at(-1)).toMatchObject({ permission_denials: [{ tool_name: target }] });
    for (const request of returning.requests) {
      expect(request.tools).toEqual(native.requests[0].tools);
      assertPrivateFieldsAbsent(request);
    }
    if (!compact) expect(blocks(returning.requests[0])).toContainEqual(invoke('native-first', 'native-first', initialArguments));
    expect(permission.mock.calls.some(call => call[0] === 'CallTool')).toBe(false);
    expect((await readHistoryReport(path)).toolContextDamaged).toBeUndefined();
    expect(JSON.stringify([...first.events, ...middle.events, ...final.events])).not.toContain('toolContext');
  });
});
