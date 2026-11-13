import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession, type SDKSession } from './session.js';
import { bindSessionCheckpoint, captureSessionCheckpoint } from './session-checkpoint.js';
import { TranscriptWriter } from './transcript.js';
import { query } from '../index.js';
import type { Options } from '../types/config.js';
import type { LlmProvider, ProviderRequest, StreamEvent } from '../types/provider.js';

let directory: string;
const sessions: SDKSession[] = [];
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'sdk-retained-history-')); });
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(async session => { session.close(); await session.flush(); }));
  await rm(directory, { recursive: true, force: true });
});

function options(persistSession = false) {
  const requests: ProviderRequest[] = [];
  const provider: LlmProvider = {
    id: 'checkpoint-fixture', name: 'Checkpoint fixture',
    capabilities: () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: false,
      pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
    async createMessage() { throw new Error('Unexpected summary'); },
    async *createMessageStream(request): AsyncGenerator<StreamEvent> {
      requests.push(request);
      const usage = { input_tokens: 10, output_tokens: 10 };
      yield { type: 'message_start', id: `message-${requests.length}`, model: request.model, usage };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Recorded.' } };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', stopReason: 'end_turn', usage };
      yield { type: 'message_stop' };
    },
  };
  const config: Options = { provider, model: 'fixture', cwd: directory, persistSession, collaboration: false,
    tools: [], settingSources: [], env: { HOME: directory, CLAUDE_CONFIG_DIR: join(directory, 'config') },
    turnEndChecks: { openWork: false, completion: false } };
  return { config, requests };
}

async function session(config: Options): Promise<SDKSession> {
  const instance = await createSession(config);
  sessions.push(instance);
  return instance;
}

async function turn(instance: SDKSession, input: string): Promise<void> {
  await instance.send(input);
  for await (const _message of instance.stream()) { /* consume the actual loop */ }
}

describe('retained SDK session state', () => {
  it('restores memory-only history and can establish a new durable checkpoint without replaying model work', async () => {
    const { config, requests } = options();
    const first = await session(config);
    first.setGoal({ objective: 'Retain this goal.' });
    await turn(first, 'ORIGINAL_CONTEXT');
    const checkpoint = captureSessionCheckpoint(first);
    first.close();
    await first.flush();
    await expect(access(join(directory, 'config', 'goals'))).rejects.toThrow();
    const resume = { ...config, sessionId: first.sessionId, persistSession: true };
    bindSessionCheckpoint(resume, checkpoint);
    const second = await session(resume);
    expect(second.getGoal()?.objective).toBe('Retain this goal.');
    await turn(second, 'Follow up.');
    expect(JSON.stringify(requests[1].messages)).toContain('ORIGINAL_CONTEXT');
    expect(requests).toHaveLength(2);
    second.close();
    await second.flush();
    const third = await session({ ...config, persistSession: true, resume: first.sessionId, strictResume: true });
    expect(third.getGoal()?.objective).toBe('Retain this goal.');
    await turn(third, 'Continue from disk.');
    expect(JSON.stringify(requests[2].messages)).toContain('ORIGINAL_CONTEXT');
    expect(JSON.stringify(requests[2].messages)).toContain('Follow up.');
  });

  it('rejects pending inputs and cross-identity checkpoint restoration', async () => {
    const { config } = options();
    const first = await session(config);
    await first.send('Pending input');
    expect(() => captureSessionCheckpoint(first)).toThrow(/settled idle/);
    for await (const _message of first.stream()) { /* consume */ }
    const checkpoint = captureSessionCheckpoint(first);
    const wrong = { ...config, sessionId: randomUUID() };
    bindSessionCheckpoint(wrong, checkpoint);
    await expect(createSession(wrong)).rejects.toThrow(/another identity/);
    first.close();
    await first.flush();
    expect(() => captureSessionCheckpoint(first)).toThrow(/settled idle/);
  });

  it('routes persisted working memory to each host configuration', async () => {
    const { config } = options(true);
    const first = await session(config);
    first.setGoal({ objective: 'Configured host goal.' });
    expect(JSON.parse(await readFile(join(directory, 'config', 'goals', `${first.sessionId}.json`), 'utf8')).current.objective).toBe('Configured host goal.');
  });

  it('records append failure so idle retirement retains the authoritative in-memory history', async () => {
    const { config } = options(true);
    const writer = new TranscriptWriter(randomUUID(), directory, config);
    await mkdir(writer.path, { recursive: true });
    await writer.writeUserMessage({ role: 'user', content: 'Retain me in memory.' });
    await writer.flush();
    expect(writer.hasCompleteHistory).toBe(false);
  });

  it('cleans an unstarted query without making a model request', async () => {
    const { config, requests } = options(true);
    const { query: publicQuery } = await import('../index.js');
    const operation = publicQuery({ prompt: 'Never started.', options: config });
    operation.setGoal({ objective: 'Disposable goal.' });
    await operation.return(undefined);
    expect(requests).toHaveLength(0);
    expect(operation.getGoal()).toBeNull();
  });
});
