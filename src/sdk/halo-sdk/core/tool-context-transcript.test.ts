import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, ToolUseBlock } from '../types/provider.js';
import type { SDKAssistantMessage } from './query-types.js';
import { AssistantHistoryRecorder } from './assistant-history.js';
import { buildAssistantMetadataMessage, buildCompactCheckpointMessage, TranscriptWriter } from './transcript.js';
import { isCompactCheckpoint, readHistoryReport, readTranscriptPage } from './transcript-reader.js';
import { loadResumeHistory } from './resume-history.js';
import { fingerprint } from './tool-context/catalog.js';
import { prepareToolContextCheckpoint, projectToolContextMessages, readToolContextSnapshot, type ToolContextRecord, type ToolDefinitionSnapshot } from './tool-context/index.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'tool-context-transcript-'));
  directories.push(directory);
  const options = { env: { SDK_STATE: directory }, conventions: { configDirEnv: 'SDK_STATE', userConfigDirName: '.sdk' } };
  const writer = new TranscriptWriter('session', directory, options);
  return { directory, options, writer };
}
const content = { server: 'service', identity: 'installed', originalName: 'lookup',
  definition: { name: 'mcp__service__lookup', description: 'Lookup', input_schema: { type: 'object' } } };
const definition: ToolDefinitionSnapshot = { ...content, version: fingerprint(content) };
function baseline(definitions: ToolDefinitionSnapshot[] = []): Message {
  return { role: 'user', content: 'Available services.', isMeta: true,
    toolContext: { version: 1, baselineAttachment: true, baseline: { version: 1, generation: 'generation', discoveryEntries: true, directory: 'Available services.', definitions } } };
}
function discovery(id = 'search'): Message {
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: JSON.stringify(definition) }],
    toolContext: { version: 1, discoveries: [{ callId: id, definitions: [definition] }] } };
}
function frame(id: string, argumentText = '{ "id": "42" }'): SDKAssistantMessage {
  return { type: 'assistant', uuid: id, session_id: 'session', parent_tool_use_id: null, message: {
    id: 'response', type: 'message', role: 'assistant', model: 'fixture', stop_reason: 'tool_use', stop_sequence: null,
    content: [{ type: 'tool_use', id, name: definition.definition.name, input: { id: '42' } }],
    toolContext: { version: 1, calls: [{ id, definitionVersion: definition.version,
      input: { tool: definition.definition.name, arguments: argumentText } }] },
  } };
}

describe('tool context journal', () => {
  it('hides dedicated context attachments without hiding a summary carrying baseline metadata', async () => {
    const { writer } = await fixture();
    await writer.writeUserMessage(baseline(), { strict: true });
    const summary = baseline();
    summary.content = 'Keep the verified constraints and continue the task.';
    summary.toolContext!.baselineAttachment = false;
    await writer.writeUserMessage(summary, { strict: true });
    const page = await readTranscriptPage(writer.path, 'session');
    expect(page).toHaveLength(1);
    expect(page[0].message).toMatchObject({ content: summary.content });
    expect(page[0].message).not.toHaveProperty('toolContext');
  });

  it('restores discoveries and exact model call strings while respecting a block UUID boundary', async () => {
    const { writer } = await fixture();
    await writer.writeUserMessage(baseline(), { strict: true });
    const search: ToolUseBlock = { type: 'tool_use', id: 'search', name: 'ToolSearch', input: { query: 'lookup' } };
    await writer.writeAssistantMessage({ role: 'assistant', content: [search] }, 'search-block', { strict: true });
    const found = discovery();
    await writer.writeUserMessage(found, { strict: true });
    const one = frame('call-one');
    const two = frame('call-two', '{\n"id":"42"\n}');
    await writer.writeAssistantMessage(one.message, one.uuid, { responseUuid: 'calls', strict: true });
    await writer.writeAssistantMessage(two.message, two.uuid, { responseUuid: 'calls', strict: true });
    const report = await readHistoryReport(writer.path);
    expect(report.toolContextDamaged).toBeUndefined();
    expect(readToolContextSnapshot(report.messages)?.definitions).toEqual([definition]);
    const calls = report.messages.at(-1)!;
    expect(calls.toolContext?.calls).toHaveLength(2);
    expect(projectToolContextMessages([calls])[0].content).toEqual([one, two].map(item => ({
      type: 'tool_use', id: item.uuid, name: 'CallTool', input: item.message.toolContext!.calls![0].input,
    })));
    const before = await readHistoryReport(writer.path, 'search-block');
    expect(readToolContextSnapshot(before.messages)?.definitions).toEqual([]);
    const midway = await readHistoryReport(writer.path, 'call-one');
    expect(midway.messages.at(-1)?.toolContext?.calls?.map(call => call.id)).toEqual(['call-one']);
    const page = await readTranscriptPage(writer.path, 'session');
    expect(page).toHaveLength(4);
    expect(page.every(entry => !('toolContext' in (entry.message as object)))).toBe(true);
    expect(await readTranscriptPage(writer.path, 'session', { limit: 1 })).toEqual([page[0]]);
  });

  it('writes a self-contained v2 checkpoint and retains it in child journals', async () => {
    const { writer, directory, options } = await fixture();
    await writer.writeUserMessage({ role: 'user', content: 'Original work.' });
    const messages = [baseline([definition]), { role: 'user' as const, content: 'Summary without tool names.' }];
    await writer.writeCompactCheckpoint(messages, 'Summary without tool names.');
    const entries = (await readFile(writer.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(entries[1].checkpointVersion).toBe(2);
    expect(isCompactCheckpoint(entries[1])).toBe(true);
    expect((await readHistoryReport(writer.path)).messages).toEqual(messages);
    expect(readToolContextSnapshot((await readHistoryReport(writer.path)).messages)?.definitions).toEqual([definition]);
    const childWriter = new TranscriptWriter('child', directory, options);
    await childWriter.writeCompactCheckpoint(messages, 'Child summary');
    await childWriter.writeAssistantMessage(frame('child-call').message, 'child-call', { strict: true });
    await childWriter.flush();
    const path = childWriter.path;
    const child = await readHistoryReport(path);
    expect(child.toolContextDamaged).toBeUndefined();
    expect(child.messages.at(-1)?.toolContext?.calls?.[0].id).toBe('child-call');
    expect((await readTranscriptPage(path, 'child'))[0].uuid).toBe('child-call');
  });

  it('refuses damaged new metadata even when strict resume was not requested', async () => {
    const { writer, directory, options } = await fixture();
    await writer.writeUserMessage(baseline(), { strict: true });
    await appendFile(writer.path, JSON.stringify({ type: 'user', uuid: 'broken',
      message: { ...discovery(), toolContext: { version: 99 } } }) + '\n');
    expect((await readHistoryReport(writer.path)).toolContextDamaged).toBe(true);
    await expect(loadResumeHistory({ sessionId: 'session', cwd: directory, options, strict: false }))
      .rejects.toMatchObject({ reason: 'incomplete' });
  });

  it.each(['missing-baseline', 'missing-field', 'invalid-definition', 'truncated'] as const)('detects %s instead of treating it as legacy', async damage => {
    const { writer, directory, options } = await fixture();
    if (damage === 'missing-baseline') {
      await writer.writeUserMessage(discovery(), { strict: true });
    } else if (damage === 'missing-field') {
      await writer.writeUserMessage({ role: 'user', content: 'seed' });
      await writeFile(writer.path, JSON.stringify({ toolContextVersion: 1, type: 'user',
        message: { role: 'user', content: 'Definition removed.' } }) + '\n');
    } else if (damage === 'invalid-definition') {
      await writer.writeUserMessage(baseline(), { strict: true });
      const found = discovery();
      found.toolContext!.discoveries![0].definitions = [{ ...definition, version: 'wrong' }];
      await appendFile(writer.path, JSON.stringify({ type: 'user', message: found }) + '\n');
    } else {
      await writer.writeUserMessage(baseline(), { strict: true });
      const raw = await readFile(writer.path, 'utf8');
      await writeFile(writer.path, raw.slice(0, -8));
    }
    expect((await readHistoryReport(writer.path)).toolContextDamaged).toBe(true);
    await expect(loadResumeHistory({ sessionId: 'session', cwd: directory, options })).rejects.toMatchObject({ reason: 'incomplete' });
  });

  it('refuses v2 checkpoints with absent baselines and v1 checkpoints carrying new state', async () => {
    const checkpoint = buildCompactCheckpointMessage([baseline()], 'Summary');
    expect(isCompactCheckpoint({ ...checkpoint, messages: [{ role: 'user', content: 'State missing.' }] })).toBe(false);
    expect(isCompactCheckpoint({ ...checkpoint, checkpointVersion: 1 })).toBe(false);
    expect(() => buildCompactCheckpointMessage([discovery()], 'Missing baseline')).toThrow('missing its baseline');
  });

  it('does not duplicate private calls in advisory assistant metadata', () => {
    expect(buildAssistantMetadataMessage(frame('call'), 'response').message).not.toHaveProperty('toolContext');
  });

  it('treats a baseline lost to the retained-record bound as damaged new history', async () => {
    const { writer } = await fixture();
    await writer.writeUserMessage(baseline(), { strict: true });
    await appendFile(writer.path, Array.from({ length: 4096 }, (_, index) => JSON.stringify({ type: 'user',
      message: { role: 'user', content: `message-${index}` } })).join('\n') + '\n');
    const report = await readHistoryReport(writer.path);
    expect(report.omitted).toBeGreaterThan(0);
    expect(report.toolContextDamaged).toBe(true);
  });
});

describe('assistant history tool call origins', () => {
  it('installs origins after successful append and preserves them at aggregate finalization', async () => {
    const history: Message[] = [];
    const persist = vi.fn(async () => {});
    const recorder = new AssistantHistoryRecorder(persist, message => history.push(message));
    const one = frame('one');
    const two = frame('two');
    await recorder.recordBlock(one, 'response');
    await recorder.recordBlock(two, 'response');
    expect(history).toHaveLength(1);
    const record: ToolContextRecord = { version: 1, calls: [...one.message.toolContext!.calls!, ...two.message.toolContext!.calls!] };
    const complete = { ...one, uuid: 'response', message: { ...one.message,
      content: [...one.message.content, ...two.message.content], toolContext: record } };
    await recorder.recordMessage(complete);
    expect(history[0].toolContext).toEqual(record);
    expect(history[0].toolContext?.calls).toHaveLength(2);
    const rejected = new AssistantHistoryRecorder(async () => { throw new Error('disk full'); }, message => history.push(message));
    await expect(rejected.recordBlock(frame('failed'), 'failed-response')).rejects.toThrow('disk full');
    expect(history).toHaveLength(1);
  });
});

describe('tool context representation validation', () => {
  const callMessage = () => frame('called').message as Message;

  it.each(['missing-origin', 'wrong-name', 'wrong-version', 'missing-block', 'duplicate-id', 'invalid-arguments', 'changed-arguments'] as const)
    ('rejects %s in recorded tool calls', damage => {
      const message = callMessage();
      if (damage === 'missing-origin') delete message.toolContext;
      else if (damage === 'wrong-name') message.toolContext!.calls![0].input.tool = 'mcp__other__lookup';
      else if (damage === 'wrong-version') message.toolContext!.calls![0].definitionVersion = 'unknown';
      else if (damage === 'missing-block') message.content = [];
      else if (damage === 'duplicate-id') (message.content as ToolUseBlock[]).push((message.content as ToolUseBlock[])[0]);
      else if (damage === 'changed-arguments') message.toolContext!.calls![0].input.arguments = '{\"id\":\"different\"}';
      else message.toolContext!.calls![0].input.arguments = '[]';
      expect(() => readToolContextSnapshot([baseline([definition]), message])).toThrow();
    });

  it('allows a recorded rejection without inventing a CallTool wrapper', () => {
    const message = callMessage();
    message.toolContext = { version: 1, rejectedCalls: [{ id: 'called', name: definition.definition.name }] };
    const error: Message = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'called', content: 'Use CallTool.', is_error: true }] };
    expect(readToolContextSnapshot([baseline([definition]), message, error])?.definitions).toEqual([definition]);
    expect(projectToolContextMessages([message])[0].content).toEqual(message.content);
    (error.content as { is_error?: boolean }[])[0].is_error = false;
    expect(() => readToolContextSnapshot([baseline([definition]), message, error])).toThrow('successful result');
  });

  it('does not reinterpret an eager call after a configuration baseline removes its deferred identity', () => {
    const eager = callMessage();
    delete eager.toolContext;
    expect(readToolContextSnapshot([baseline([definition]), baseline(), eager])?.definitions).toEqual([]);
  });
});


describe('checkpoint historical definitions', () => {
  it('keeps revoked definitions privately for retained wrappers without granting discovery', () => {
    const call = frame('old-call').message;
    const source = [baseline([definition]), call];
    const candidate = [baseline(), { role: 'user' as const, content: 'Summary.' }, call];
    const prepared = prepareToolContextCheckpoint(candidate, source);
    expect(prepared[0].toolContext?.baseline?.definitions).toEqual([]);
    expect(prepared[0].toolContext?.baseline?.historicalDefinitions).toEqual([definition]);
    expect(prepared[0].content).toBe(candidate[0].content);
    expect(candidate[0].toolContext?.baseline?.historicalDefinitions).toBeUndefined();
    expect(isCompactCheckpoint(buildCompactCheckpointMessage(prepared, 'Summary.'))).toBe(true);
    expect(readToolContextSnapshot(prepared)?.definitions).toEqual([]);
    expect(projectToolContextMessages(prepared).some(message => 'toolContext' in message)).toBe(false);
    const again = prepareToolContextCheckpoint(prepared, prepared);
    expect(again[0].toolContext?.baseline?.historicalDefinitions).toEqual([definition]);
    const withoutCall = prepareToolContextCheckpoint([baseline()], prepared);
    expect(withoutCall[0].toolContext?.baseline?.historicalDefinitions).toBeUndefined();
  });

  it('refuses a checkpoint whose retained wrapper has no definition snapshot', () => {
    expect(() => prepareToolContextCheckpoint([baseline(), frame('old-call').message], [baseline()]))
      .toThrow('definition is missing');
  });
});


it('stamps ordinary resumed records so a bounded tail cannot silently downgrade to legacy mode', async () => {
  const { writer, directory, options } = await fixture();
  await writer.writeUserMessage(baseline(), { strict: true });
  const resumed = new TranscriptWriter('session', directory, options);
  resumed.setToolContextMode();
  await resumed.writeUserMessage({ role: 'user', content: 'A later plain turn.' }, { strict: true });
  const lines = (await readFile(writer.path, 'utf8')).trim().split('\n');
  expect(JSON.parse(lines[0])).toMatchObject({ toolContextVersion: 1, toolContextRecord: true });
  expect(JSON.parse(lines[1])).toMatchObject({ toolContextVersion: 1, toolContextRecord: false });
  expect((await readHistoryReport(writer.path)).toolContextDamaged).toBeUndefined();
  await writeFile(writer.path, lines[1] + '\n');
  expect((await readHistoryReport(writer.path)).toolContextDamaged).toBe(true);
  await expect(loadResumeHistory({ sessionId: 'session', cwd: directory, options })).rejects.toMatchObject({ reason: 'incomplete' });
});
