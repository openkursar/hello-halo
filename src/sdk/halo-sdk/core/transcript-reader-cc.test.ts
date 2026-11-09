/**
 * Resuming from transcripts Claude Code wrote. The fixtures are synthetic but
 * keep the record shapes of the named Claude Code versions; re-check them
 * against real transcripts before the host changes its recommended version.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readHistory } from './transcript-reader.js';
import { repairToolResultPairing, SYNTHETIC_TOOL_RESULT_PLACEHOLDER } from './messages.js';
import type { ContentBlock, Message } from '../types/provider.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/cc-transcripts/${name}`, import.meta.url));
const blocks = (message: Message) => message.content as ContentBlock[];
const types = (message: Message) => blocks(message).map(block => block.type);

let directory: string;
beforeEach(async () => { directory = await fs.mkdtemp(join(tmpdir(), 'sdk-cc-history-')); });
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

describe('Claude Code 2.1.89 transcripts', () => {
  it('restores a reply split per block and its parallel results without losing any result', async () => {
    const history = (await readHistory(fixture('cc-2.1.89-parallel-tools.jsonl')))!;
    expect(history.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    expect(types(history[1])).toEqual(['text', 'tool_use', 'tool_use', 'tool_use']);
    // Results first, as the API requires; the attached skill text follows them.
    expect(types(history[2])).toEqual(['tool_result', 'tool_result', 'tool_result', 'text']);

    const { messages, changes } = repairToolResultPairing(history);
    expect(changes).toEqual({ duplicateCalls: 0, discardedResults: 0, lateResults: 0, missingResults: 0, emptyResponses: 0 });
    const results = blocks(messages[2]).filter(block => block.type === 'tool_result');
    expect(results.map(block => (block as { content: string }).content).sort()).toEqual(['contents of a', 'contents of b', 'contents of c']);
    expect(JSON.stringify(messages)).not.toContain(SYNTHETIC_TOOL_RESULT_PLACEHOLDER);
  });
});

describe('Claude Code 2.1.310 transcripts', () => {
  it('rebuilds one reply from blocks interleaved with their results', async () => {
    const history = (await readHistory(fixture('cc-2.1.310-interleaved.jsonl')))!;
    expect(history.map(message => message.role)).toEqual(['user', 'user', 'assistant', 'user', 'assistant']);
    expect(types(history[2])).toEqual(['thinking', 'tool_use', 'tool_use']);
    expect(types(history[3])).toEqual(['tool_result', 'tool_result']);
    const { changes } = repairToolResultPairing(history);
    expect(changes.discardedResults + changes.missingResults).toBe(0);
  });
});

describe('Halo transcripts', () => {
  it('are restored message for message', async () => {
    const file = join(directory, 'halo.jsonl');
    const record = (type: 'user' | 'assistant', message: Message) => JSON.stringify({
      type, message, uuid: `${type}-${Math.random()}`, parentUuid: null, sessionId: 's', timestamp: '2026-10-29T00:00:00.000Z',
      isSidechain: false, userType: 'external', cwd: '/work', version: '1.0.0',
    });
    const written: Message[] = [
      { role: 'user', content: 'Find the config.' },
      { role: 'assistant', content: [{ type: 'text', text: 'Searching.' }, { type: 'tool_use', id: 't1', name: 'Grep', input: {} }, { type: 'tool_use', id: 't2', name: 'Glob', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a' }, { type: 'tool_result', tool_use_id: 't2', content: 'b' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Found it.' }] },
      { role: 'user', content: 'Open it.' },
    ];
    await fs.writeFile(file, written.map(message => record(message.role, message)).join('\n') + '\n');
    expect(await readHistory(file)).toEqual(written);
  });

  it('skips sidechain records written into the main file', async () => {
    const file = join(directory, 'sidechain.jsonl');
    await fs.writeFile(file, [
      { type: 'user', message: { role: 'user', content: 'main' } },
      { type: 'assistant', isSidechain: true, message: { role: 'assistant', content: 'side' } },
      { type: 'assistant', message: { role: 'assistant', content: 'answer' } },
    ].map(record => JSON.stringify(record)).join('\n'));
    expect(await readHistory(file)).toEqual([{ role: 'user', content: 'main' }, { role: 'assistant', content: 'answer' }]);
  });
});
