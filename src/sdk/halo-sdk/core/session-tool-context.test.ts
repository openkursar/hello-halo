import { afterEach, describe, expect, it } from 'vitest';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSessionToolContextMode } from '../index.js';
import { readSessionToolContextMode as readWorkerMode } from '../worker/index.js';
import { TranscriptWriter } from './transcript.js';
import type { Message } from '../types/provider.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'session-tool-context-'));
  directories.push(cwd);
  const options = { cwd, env: { SDK_STATE: cwd }, conventions: { configDirEnv: 'SDK_STATE', userConfigDirName: '.sdk' } };
  return { options, writer: new TranscriptWriter('session', cwd, options) };
}
function baseline(discoveryEntries = true): Message {
  return { role: 'user', content: discoveryEntries ? 'Service directory.' : 'First user input.', isMeta: discoveryEntries,
    toolContext: { version: 1, baseline: { version: 1, generation: 'generation', directory: discoveryEntries ? 'Service directory.' : '',
      definitions: [], discoveryEntries } } };
}

describe('public session tool-context inspection', () => {
  it('exports the same reader from both public entry points', () => {
    expect(readWorkerMode).toBe(readSessionToolContextMode);
  });

  it('classifies legacy history without rewriting or creating records', async () => {
    const { options, writer } = await fixture();
    await writer.writeUserMessage({ role: 'user', content: 'Legacy history.' }, { strict: true });
    const before = await readFile(writer.path, 'utf8');
    expect(await readSessionToolContextMode('session', options)).toBe('full');
    expect(await readFile(writer.path, 'utf8')).toBe(before);
  });

  it.each([true, false])('recognizes new-format history independently of discovery entries (%s)', async entries => {
    const { options, writer } = await fixture();
    await writer.writeUserMessage(baseline(entries), { strict: true });
    expect(await readSessionToolContextMode('session', options)).toBe('deferred');
  });

  it('reads format at the requested anchor and refuses unknown anchors', async () => {
    const { options, writer } = await fixture();
    const earlier = await writer.writeUserMessage({ role: 'user', content: 'Legacy prefix.' }, { strict: true });
    const later = await writer.writeUserMessage(baseline(), { strict: true });
    expect(await readSessionToolContextMode('session', { ...options, resumeSessionAt: earlier })).toBe('full');
    expect(await readSessionToolContextMode('session', { ...options, resumeSessionAt: later })).toBe('deferred');
    await expect(readSessionToolContextMode('session', { ...options, resumeSessionAt: 'not-recorded' }))
      .rejects.toMatchObject({ reason: 'incomplete' });
  });

  it('reads a self-contained new-format compact checkpoint', async () => {
    const { options, writer } = await fixture();
    await writer.writeCompactCheckpoint([baseline(), { role: 'user', content: 'Summary.' }], 'Summary.');
    expect(await readSessionToolContextMode('session', options)).toBe('deferred');
  });

  it('does not infer format from visible text that resembles private metadata', async () => {
    const { options, writer } = await fixture();
    await writer.writeUserMessage({ role: 'user', content: JSON.stringify(baseline().toolContext) }, { strict: true });
    expect(await readSessionToolContextMode('session', options)).toBe('full');
  });

  it('refuses missing or damaged history instead of selecting a default mode', async () => {
    const { options, writer } = await fixture();
    await expect(readSessionToolContextMode('session', options)).rejects.toMatchObject({ reason: 'missing' });
    await writer.writeUserMessage(baseline(), { strict: true });
    await appendFile(writer.path, JSON.stringify({ toolContextVersion: 1, toolContextRecord: true,
      type: 'user', message: { role: 'user', content: 'Required metadata is missing.' } }) + '\n');
    await expect(readSessionToolContextMode('session', options)).rejects.toMatchObject({ reason: 'incomplete' });
  });

  it.each(['unknown-record', 'invalid-role'])('refuses a marked %s after a readable legacy prefix', async damage => {
    const { options, writer } = await fixture();
    await writer.writeUserMessage({ role: 'user', content: 'Readable prefix.' }, { strict: true });
    await appendFile(writer.path, JSON.stringify({ toolContextVersion: 1, toolContextRecord: true,
      type: damage === 'unknown-record' ? 'unknown' : 'user',
      message: { ...baseline(), ...(damage === 'invalid-role' ? { role: 'unknown' } : {}) } }) + '\n');
    await expect(readSessionToolContextMode('session', options)).rejects.toMatchObject({ reason: 'incomplete' });
  });
});
