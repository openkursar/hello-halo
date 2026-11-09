import { afterEach, describe, expect, it } from 'vitest';
import { appendFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock, Message } from '../types/provider.js';
import { ensureToolResultPairing } from './messages.js';
import { MAX_COMPACT_CHECKPOINT_BYTES, readHistory, readHistoryReport, readTranscriptPage } from './transcript-reader.js';
import type { SDKAssistantMessage } from './query-types.js';
import { writeArchivedFixture } from '../validation/fixtures/archived-transcripts.mjs';
import { buildAssistantMetadataMessage, buildCompactCheckpointMessage, getLegacyRecordPath, TranscriptWriter } from './transcript.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'sdk-stream-history-'));
  directories.push(directory);
  const options = { env: { SDK_STATE: directory }, conventions: { configDirEnv: 'SDK_STATE', userConfigDirName: '.sdk' } };
  const writer = new TranscriptWriter('session', directory, options);
  return { directory, options, writer };
}

const first: ContentBlock = { type: 'tool_use', id: 'one', name: 'Read', input: { file_path: '/a' } };
const second: ContentBlock = { type: 'tool_use', id: 'two', name: 'Read', input: { file_path: '/b' } };
const assistant = (...content: ContentBlock[]): Message => ({ role: 'assistant', content });

async function writeCalls(writer: TranscriptWriter) {
  await writer.writeAssistantMessage(assistant(first), 'block-one', { responseUuid: 'response', strict: true });
  await writer.writeAssistantMessage(assistant(second), 'block-two', { responseUuid: 'response', strict: true });
}

function response(uuid: string, content: ContentBlock[], outputTokens: number): SDKAssistantMessage {
  return { type: 'assistant', uuid, session_id: 'session', parent_tool_use_id: null,
    message: { id: 'provider-id', type: 'message', role: 'assistant', model: 'test', content,
      usage: { input_tokens: 12, output_tokens: outputTokens }, stop_reason: 'tool_use', stop_sequence: null } };
}

describe('compact checkpoints', () => {
  it('restores the latest reduced history without merging old or later responses and keeps the original public transcript', async () => {
    const { writer } = await fixture();
    await writer.writeUserMessage({ role: 'user', content: 'original request' });
    await writer.writeAssistantMessage(assistant({ type: 'text', text: 'original answer' }), 'original', { responseUuid: 'reused', strict: true });
    await writer.writeCompactCheckpoint([{ role: 'user', content: 'first summary' }], 'first summary');
    const reduced: Message[] = [{ role: 'user', content: 'latest summary', isMeta: true }, assistant({ type: 'text', text: 'retained answer' })];
    const checkpoint = writer.writeCompactCheckpoint(reduced, 'latest summary');
    reduced[0].content = 'mutated after submission';
    await checkpoint;
    await writer.writeAssistantMessage(assistant({ type: 'text', text: 'later answer' }), 'later', { responseUuid: 'reused', strict: true });
    await writer.writeUserMessage({ role: 'user', content: 'later turn' });
    const report = await readHistoryReport(writer.path);
    expect(report).toEqual({ damaged: 0, omitted: 0, messages: [
      { role: 'user', content: 'latest summary', isMeta: true }, assistant({ type: 'text', text: 'retained answer' }),
      assistant({ type: 'text', text: 'later answer' }), { role: 'user', content: 'later turn' },
    ] });
    expect(await readHistory(writer.path, 'original')).toEqual([
      { role: 'user', content: 'original request' }, assistant({ type: 'text', text: 'original answer' }),
    ]);
    expect(await readHistory(writer.path, 'later')).toEqual(report.messages.slice(0, -1));
    const entries = (await readFile(writer.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(entries[3]).toMatchObject({ type: 'compact_checkpoint', checkpointVersion: 1, parentUuid: 'original', timestamp: expect.any(String) });
    expect(entries[4].parentUuid).toBe('original');
    for (const includeSystemMessages of [false, true]) {
      const page = await readTranscriptPage(writer.path, 'session', { includeSystemMessages });
      expect(page.map(message => message.message)).toEqual([
        { role: 'user', content: 'original request' }, assistant({ type: 'text', text: 'original answer' }),
        assistant({ type: 'text', text: 'later answer' }), { role: 'user', content: 'later turn' },
      ]);
      expect(await readTranscriptPage(writer.path, 'session', { offset: 2, limit: 1, includeSystemMessages })).toEqual([page[2]]);
    }
  });

  it('does not replace history for a truncated, malformed, or unknown-version checkpoint', async () => {
    const { writer } = await fixture();
    const old = { role: 'user' as const, content: 'old history remains' };
    await writer.writeUserMessage(old);
    const checkpoint = buildCompactCheckpointMessage([{ role: 'user', content: 'not committed' }], 'summary');
    await appendFile(writer.path, [
      JSON.stringify({ ...checkpoint, checkpointVersion: 3 }),
      JSON.stringify({ ...checkpoint, messages: [{ role: 'user', content: [null] }] }),
      JSON.stringify(checkpoint).slice(0, -10),
    ].join('\n'));
    expect(await readHistoryReport(writer.path)).toEqual({ messages: [old], damaged: 3, omitted: 0, toolContextDamaged: true });
  });

  it('bounds checkpoint bytes and message count before appending and recovers after refusal', async () => {
    const { writer } = await fixture();
    const old = { role: 'user' as const, content: 'old history remains' };
    await writer.writeUserMessage(old);
    const before = await readFile(writer.path, 'utf8');
    await expect(writer.writeCompactCheckpoint([{ role: 'user', content: '字'.repeat(Math.ceil(MAX_COMPACT_CHECKPOINT_BYTES / 3)) }], 'summary'))
      .rejects.toThrow('16 MiB');
    await expect(writer.writeCompactCheckpoint(Array.from({ length: 4097 }, () => old), 'summary')).rejects.toThrow('4096');
    expect(await readFile(writer.path, 'utf8')).toBe(before);
    await writer.writeCompactCheckpoint([{ role: 'user', content: 'small recovery' }], 'summary');
    expect(await readHistory(writer.path)).toEqual([{ role: 'user', content: 'small recovery' }]);
  });

  it('reads ordinary tens-of-thousands-token checkpoints without hiding later pages', async () => {
    const { writer } = await fixture();
    await writer.writeUserMessage({ role: 'user', content: 'original' });
    const reduced: Message[] = [{ role: 'user', content: 'summary '.repeat(20_000) }];
    await writer.writeCompactCheckpoint(reduced, 'summary');
    await writer.writeUserMessage({ role: 'user', content: 'next' });
    expect(await readHistory(writer.path)).toEqual([...reduced, { role: 'user', content: 'next' }]);
    expect(await readTranscriptPage(writer.path, 'session', { offset: 1, limit: 1 })).toMatchObject([{ message: { content: 'next' } }]);
  });

  it('reads archived private checkpoints without joining responses across the replacement', async () => {
    const { directory, options } = await fixture();
    const path = getLegacyRecordPath('parent', 'child', directory, options);
    const reduced: Message[] = [{ role: 'user', content: 'child summary' }];
    await writeArchivedFixture(path, 'child', [
      { type: 'assistant', uuid: 'prior', responseUuid: 'reused', message: assistant({ type: 'text', text: 'old child answer' }) },
      { ...buildCompactCheckpointMessage(reduced, 'child summary'), parentUuid: 'prior' },
      { type: 'assistant', parentUuid: 'prior', responseUuid: 'reused', message: assistant({ type: 'text', text: 'new child answer' }) },
    ]);
    expect(await readHistory(path)).toEqual([...reduced, assistant({ type: 'text', text: 'new child answer' })]);
    const entries = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(entries[1]).toMatchObject({ type: 'compact_checkpoint', isSidechain: true, parentUuid: entries[0].uuid });
    expect(entries[2].parentUuid).toBe(entries[0].uuid);
    expect(await readTranscriptPage(path, 'child', { includeSystemMessages: true })).toHaveLength(2);
  });
});

describe('streamed assistant transcript', () => {
  it('stores final accounting once and enriches the last visible block without an extra message', async () => {
    const { writer } = await fixture();
    const firstFrame = response('block-one', [first], 1);
    const secondFrame = response('block-two', [second], 2);
    await writer.writeAssistantMessage(firstFrame.message, firstFrame.uuid, { responseUuid: 'response', strict: true });
    await writer.writeAssistantMessage(secondFrame.message, secondFrame.uuid, { responseUuid: 'response', strict: true });
    await writer.writeAssistantMetadata(response('response', [first, second], 37), 'response');
    const entries = (await readFile(writer.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(entries.map(entry => entry.type)).toEqual(['assistant', 'assistant', 'assistant_metadata']);
    expect(entries.filter(entry => entry.message.usage)).toHaveLength(1);
    expect(entries[2].message).not.toHaveProperty('content');
    expect(entries[2].message.usage).toEqual({ input_tokens: 12, output_tokens: 37 });
    expect(firstFrame.message.usage?.output_tokens).toBe(1);
    expect(await readHistory(writer.path)).toEqual([assistant(first, second)]);
    expect(await readHistory(writer.path, 'block-one')).toEqual([assistant(first)]);
    const page = await readTranscriptPage(writer.path, 'session');
    expect(page).toHaveLength(2);
    expect(page[0].message).not.toHaveProperty('usage');
    expect(page[1].message).toMatchObject({ content: [second], usage: { input_tokens: 12, output_tokens: 37 }, stop_reason: 'tool_use' });
    const tail = await readTranscriptPage(writer.path, 'session', { offset: 1, limit: 1 });
    expect(tail[0]).toEqual(page[1]);
    const prefix = await readTranscriptPage(writer.path, 'session', { limit: 1 });
    expect(prefix[0].message).not.toHaveProperty('usage');
    await writer.writeUserMessage({ role: 'user', content: 'next' });
    const withNext = (await readFile(writer.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(withNext[3].parentUuid).toBe('block-two');
  });

  it('reads archived final metadata without duplicating content or usage', async () => {
    const { directory, options } = await fixture();
    const path = getLegacyRecordPath('parent', 'child', directory, options);
    const firstFrame = response('block-one', [first], 1);
    const secondFrame = response('block-two', [second], 2);
    await writeArchivedFixture(path, 'child', [
      { ...firstFrame, responseUuid: 'response', message: { ...firstFrame.message, usage: undefined } },
      { ...secondFrame, responseUuid: 'response', message: { ...secondFrame.message, usage: undefined } },
      { ...buildAssistantMetadataMessage(response('response', [first, second], 37), 'response') },
    ]);
    const entries = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(entries.filter(entry => entry.message.usage)).toHaveLength(1);
    expect(entries[2].type).toBe('assistant_metadata');
    expect(entries[2].message).not.toHaveProperty('content');
    expect(await readHistory(path)).toEqual([assistant(first, second)]);
    const page = await readTranscriptPage(path, 'child', { offset: 1, limit: 1 });
    expect(page).toHaveLength(1);
    expect(page[0].message).toMatchObject({ content: [second], usage: { input_tokens: 12, output_tokens: 37 } });
  });
  it('restores completed blocks as one response without synthetic missing tool results', async () => {
    const { writer } = await fixture();
    await writeCalls(writer);
    await writer.writeUserMessage({ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'one', content: 'a' },
      { type: 'tool_result', tool_use_id: 'two', content: 'b' },
    ] });
    const history = await readHistory(writer.path);
    expect(history).toHaveLength(2);
    expect(history![0]).toEqual(assistant(first, second));
    expect(ensureToolResultPairing(history!)).toEqual(history);
    const raw = (await readFile(writer.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(raw.slice(0, 2).map(entry => entry.message.content.length)).toEqual([1, 1]);
    expect(raw[1].parentUuid).toBe('block-one');
  });

  it('restores an interrupted response and respects a block UUID resume boundary', async () => {
    const { writer } = await fixture();
    await writeCalls(writer);
    expect(await readHistory(writer.path, 'block-one')).toEqual([assistant(first)]);
    expect(await readHistory(writer.path)).toEqual([assistant(first, second)]);
    const page = await readTranscriptPage(writer.path, 'session', { offset: 1, limit: 1 });
    expect(page).toHaveLength(1);
    expect(page[0].uuid).toBe('block-two');
    expect(page[0].message).toEqual(assistant(second));
  });

  it('does not merge ordinary responses or blocks across a user message', async () => {
    const { writer } = await fixture();
    await writer.writeAssistantMessage(assistant(first), 'first', { responseUuid: 'response', strict: true });
    await writer.writeUserMessage({ role: 'user', content: 'continue' });
    await writer.writeAssistantMessage(assistant(second), 'second', { responseUuid: 'response', strict: true });
    await writer.writeAssistantMessage(assistant({ type: 'text', text: 'done' }), 'plain');
    await writer.writeAssistantMessage(assistant({ type: 'text', text: 'next' }), 'plain-next');
    expect(await readHistory(writer.path)).toHaveLength(5);
  });

  it('does not merge responses from different agent scopes or local attempts', async () => {
    const { directory } = await fixture();
    const path = join(directory, 'scope.jsonl');
    await writeFile(path, [
      { sessionId: 'one', responseUuid: 'response', parent_tool_use_id: null },
      { sessionId: 'one', responseUuid: 'response', parent_tool_use_id: 'parent' },
      { sessionId: 'two', responseUuid: 'response', parent_tool_use_id: 'parent' },
      { sessionId: 'two', responseUuid: 'another', parent_tool_use_id: 'parent' },
    ].map(scope => JSON.stringify({ type: 'assistant', message: assistant(first), ...scope })).join('\n') + '\n');
    expect(await readHistory(path)).toHaveLength(4);
  });

  it('rejects a failed strict checkpoint without poisoning later writes', async () => {
    const { writer } = await fixture();
    await mkdir(writer.path, { recursive: true });
    await expect(writer.writeAssistantMessage(assistant(first), 'failed', { responseUuid: 'response', strict: true })).rejects.toThrow();
    await expect(writer.flush()).resolves.toBeUndefined();
    await rm(writer.path, { recursive: true });
    await writer.writeAssistantMessage(assistant(second), 'saved', { responseUuid: 'next', strict: true });
    expect(await readHistory(writer.path)).toEqual([assistant(second)]);
  });

  it('honors grouping markers in archived related records', async () => {
    const { directory, options } = await fixture();
    const path = getLegacyRecordPath('parent', 'child', directory, options);
    await writeArchivedFixture(path, 'child', [
      { type: 'assistant', responseUuid: 'response', message: assistant(first) },
      { type: 'assistant', responseUuid: 'response', message: assistant(second) },
    ]);
    expect(await readHistory(getLegacyRecordPath('parent', 'child', directory, options))).toEqual([assistant(first, second)]);
  });
});
