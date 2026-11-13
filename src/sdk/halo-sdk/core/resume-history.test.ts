import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadResumeHistory } from './resume-history.js';
import { getTranscriptPath } from './transcript.js';
import { createSession } from '../index.js';
import { RESUME_HISTORY_UNAVAILABLE, isResumeHistoryError } from '../utils/errors.js';
import type { LlmProvider } from '../llm/provider.js';

let configDir: string;
let cwd: string;
beforeEach(async () => {
  configDir = await fs.mkdtemp(join(tmpdir(), 'sdk-resume-config-'));
  cwd = join(configDir, 'work');
});
afterEach(async () => { await fs.rm(configDir, { recursive: true, force: true }); });

const options = () => ({ env: { CLAUDE_CONFIG_DIR: configDir, HOME: configDir, USERPROFILE: configDir }, settingSources: [] });

async function writeHistory(sessionId: string, lines: Array<Record<string, unknown> | string>): Promise<void> {
  const path = getTranscriptPath(sessionId, cwd, options());
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, lines.map(line => typeof line === 'string' ? line : JSON.stringify(line)).join('\n') + '\n');
}

const user = (content: unknown) => ({ type: 'user', message: { role: 'user', content } });
const assistant = (id: string, content: unknown) => ({ type: 'assistant', message: { id, role: 'assistant', content } });
const call = (id: string) => ({ type: 'tool_use', id, name: 'Read', input: {} });
const result = (id: string) => ({ type: 'tool_result', tool_use_id: id, content: `output ${id}` });

async function refusal(sessionId: string): Promise<unknown> {
  return loadResumeHistory({ sessionId, cwd, options: options(), strict: true }).then(() => undefined, error => error);
}

describe('strict resume', () => {
  it('refuses a history that is not stored', async () => {
    const error = await refusal(randomUUID());
    expect(isResumeHistoryError(error)).toBe(true);
    expect(error).toMatchObject({ name: 'ResumeHistoryError', code: RESUME_HISTORY_UNAVAILABLE, reason: 'missing' });
  });

  it('refuses a history with no readable messages', async () => {
    const sessionId = randomUUID();
    await writeHistory(sessionId, [{ type: 'queue-operation' }]);
    expect(await refusal(sessionId)).toMatchObject({ reason: 'unreadable' });
  });

  it('refuses a history with damaged records', async () => {
    const sessionId = randomUUID();
    await writeHistory(sessionId, [user('hello'), '{"type":"assistant","mess', user('again')]);
    expect(await refusal(sessionId)).toMatchObject({ reason: 'incomplete' });
  });

  it('refuses a history whose recorded results cannot be paired with their calls', async () => {
    const sessionId = randomUUID();
    await writeHistory(sessionId, [
      user('go'),
      assistant('m1', [call('a')]),
      assistant('m2', [call('b')]),
      user([result('a')]),
      user([result('b')]),
      user('next'),
    ]);
    expect(await refusal(sessionId)).toMatchObject({ reason: 'incomplete' });
  });

  it('accepts calls whose result was never recorded, wherever they are', async () => {
    const sessionId = randomUUID();
    await writeHistory(sessionId, [
      user('go'), assistant('m1', [call('stopped')]),
      user('carry on'), assistant('m2', [{ type: 'text', text: 'ok' }]),
      user('once more'), assistant('m3', [call('running')]),
    ]);
    const messages = await loadResumeHistory({ sessionId, cwd, options: options(), strict: true });
    expect(JSON.stringify(messages)).toContain('stopped');
    expect(messages.at(-1)?.role).toBe('user');
  });

  it('keeps the earlier behavior without strictResume', async () => {
    expect(await loadResumeHistory({ sessionId: randomUUID(), cwd, options: options() })).toEqual([]);
    const sessionId = randomUUID();
    await writeHistory(sessionId, [user('hello'), '{broken', assistant('m1', [{ type: 'text', text: 'hi' }])]);
    expect(await loadResumeHistory({ sessionId, cwd, options: options() })).toHaveLength(2);
  });

  it('makes session creation reject so the host can continue from its own record', async () => {
    const provider = { id: 'unused', name: 'Unused', capabilities: () => ({}) } as unknown as LlmProvider;
    const creation = createSession({
      ...options(), provider, model: 'test-model', cwd,
      systemPrompt: 'test', resume: randomUUID(), strictResume: true,
    });
    await expect(creation).rejects.toMatchObject({ code: RESUME_HISTORY_UNAVAILABLE, reason: 'missing' });
  });
});
