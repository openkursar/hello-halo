import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_COMPACT_CHECKPOINT_BYTES, readHistory, readHistoryReport, readTranscriptPage } from './transcript-reader.js';
import { buildCompactCheckpointMessage } from './transcript.js';
import { repairToolResultPairing } from './messages.js';

let directory: string;
beforeEach(async () => { directory = await fs.mkdtemp(join(tmpdir(), 'sdk-history-')); });
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

describe('bounded history recovery', () => {
  it('retains only the latest handover and its subsequent tool exchange', async () => {
    const file = join(directory, 'compacted-history.jsonl');
    const summary = { role: 'user', content: 'Current task: verify the inventory totals.' };
    const call = { role: 'assistant', content: [{ type: 'tool_use', id: 'inventory-read', name: 'Read', input: { file_path: '/fixture/inventory.txt' } }] };
    const result = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'inventory-read', content: '12 items' }] };
    const answer = { role: 'assistant', content: 'The inventory total is 12.' };
    const records = [
      { type: 'user', message: { role: 'user', content: 'An obsolete task.' } },
      { type: 'system', subtype: 'compact_boundary' },
      { type: 'user', message: { role: 'user', content: 'An earlier handover.' } },
      { type: 'assistant', message: { role: 'assistant', content: 'Intermediate work.' } },
      { type: 'system', subtype: 'compact_boundary' },
      ...[summary, call, result, answer].map(message => ({ type: message.role, message })),
    ];
    await fs.writeFile(file, records.map(record => JSON.stringify(record)).join('\n') + '\n');
    const report = await readHistoryReport(file);
    expect(report.omitted).toBe(0);
    expect(report.damaged).toBe(0);
    expect(report.messages).toEqual([summary, call, result, answer]);
    expect(repairToolResultPairing(report.messages).changes).toEqual({
      duplicateCalls: 0, discardedResults: 0, lateResults: 0, missingResults: 0, emptyResponses: 0,
    });
  });

  it.each([false, true])('restores a checkpoint found in a bounded transcript tail (sidechain=%s)', async isSidechain => {
    const file = join(directory, 'tail-checkpoint.jsonl');
    const header = isSidechain ? { type: 'agent_task', version: 1, id: 'child' }
      : { type: 'user', message: { role: 'user', content: 'old main message' } };
    await fs.writeFile(file, JSON.stringify(header) + '\n');
    const handle = await fs.open(file, 'r+');
    await handle.truncate(70 * 1024 * 1024);
    await handle.close();
    const messages = [{ role: 'user' as const, content: 'tail summary' }];
    await fs.appendFile(file, '\n' + JSON.stringify({ ...buildCompactCheckpointMessage(messages, 'tail summary'), isSidechain }) + '\n');
    expect(await readHistoryReport(file)).toEqual({ messages, damaged: 0, omitted: 0 });
  });

  it('does not install an oversized checkpoint even when it fits the JSONL line limit', async () => {
    const file = join(directory, 'oversized-checkpoint.jsonl');
    const old = { role: 'user' as const, content: 'original history' };
    await fs.writeFile(file, JSON.stringify({ type: 'user', message: old }) + '\n' + JSON.stringify({
      ...buildCompactCheckpointMessage([{ role: 'user', content: 'x'.repeat(MAX_COMPACT_CHECKPOINT_BYTES) }], 'summary'),
    }) + '\n');
    expect(await readHistoryReport(file)).toEqual({ messages: [old], damaged: 1, omitted: 0 });
  });

  it('still bounds retained messages after a compact checkpoint', async () => {
    const file = join(directory, 'checkpoint-count.jsonl');
    await fs.writeFile(file, JSON.stringify(buildCompactCheckpointMessage(
      Array.from({ length: 4096 }, (_, index) => ({ role: 'user' as const, content: `kept-${index}` })), 'summary',
    )) + '\n' + JSON.stringify({ type: 'user', message: { role: 'user', content: 'later turn' } }) + '\n');
    const report = await readHistoryReport(file);
    expect(report.omitted).toBe(1);
    expect(report.messages).toHaveLength(4097);
    expect(report.messages[0].content).toContain('omitted');
    expect(report.messages[1].content).toBe('kept-1');
    expect(report.messages.at(-1)?.content).toBe('later turn');
  });

  it('recovers the tail of a huge broken record without allocating it', async () => {
    const file = join(directory, 'history.jsonl');
    const handle = await fs.open(file, 'w');
    await handle.truncate(1024 ** 3);
    await handle.close();
    await fs.appendFile(file, '\n' + JSON.stringify({ type: 'user', message: { role: 'user', content: 'latest durable message' } }) + '\n');
    const messages = await readHistory(file);
    expect(messages).toHaveLength(2);
    expect(messages![0].content).toContain('omitted');
    expect(messages![1].content).toBe('latest durable message');
  });

  it('limits retained record count while honoring an explicit earlier stop point', async () => {
    const file = join(directory, 'history.jsonl');
    await fs.writeFile(file, Array.from({ length: 6000 }, (_, index) => JSON.stringify({
      type: 'user', uuid: `record-${index}`, message: { role: 'user', content: `message-${index}` },
    })).join('\n'));
    const messages = await readHistory(file);
    expect(messages!.length).toBeLessThanOrEqual(4097);
    expect(messages!.at(-1)!.content).toBe('message-5999');
    const earlier = await readHistory(file, 'record-3');
    expect(earlier).toHaveLength(4);
    expect(earlier!.at(-1)!.content).toBe('message-3');
    await expect(readTranscriptPage(file, 'test')).rejects.toThrow('Supply limit and offset');
    expect((await readTranscriptPage(file, 'test', { offset: 5000, limit: 2 })).map(record => record.message))
      .toEqual([{ role: 'user', content: 'message-5000' }, { role: 'user', content: 'message-5001' }]);
  });

  it('stops a page read before a huge trailing record', async () => {
    const file = join(directory, 'page.jsonl');
    await fs.writeFile(file, JSON.stringify({ type: 'user', message: { role: 'user', content: 'first' } }) + '\n');
    const handle = await fs.open(file, 'r+');
    await handle.truncate(1024 ** 3);
    await handle.close();
    expect(await readTranscriptPage(file, 'test', { limit: 1 })).toHaveLength(1);
    await expect(readTranscriptPage(file, 'test', { limit: 2 })).rejects.toThrow('32 MiB');
  });
  it('restores a supported multi-image record within the provider image budget', async () => {
    const file = join(directory, 'images.jsonl');
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(6 * 1024 * 1024) } };
    await fs.writeFile(file, JSON.stringify({ type: 'user', message: { role: 'user', content: [image, image] } }) + '\n');
    const history = await readHistory(file);
    expect(history).toHaveLength(1);
    expect(history![0].content).toHaveLength(2);
    expect(await readTranscriptPage(file, 'test', { limit: 1 })).toHaveLength(1);
  });

});
