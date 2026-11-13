import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession, type SDKSession } from '../index.js';
import { getTranscriptPath } from './transcript.js';
import type { Options } from '../types/config.js';
import { readHistory } from './transcript-reader.js';
import type { SDKMessage } from './query-types.js';
import type { LlmProvider, ProviderRequest, StreamEvent } from '../types/provider.js';
import type { Tool } from '../types/tool.js';

const directories: string[] = [];
const sessions: SDKSession[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const session of sessions) session.close();
  await Promise.all(sessions.splice(0).map(session => session.flush()));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function provider(stream: (request: ProviderRequest) => AsyncGenerator<StreamEvent, void, undefined>): LlmProvider {
  return { id: 'mock', name: 'mock', capabilities: () => ({ streaming: true, toolCalling: true,
    thinking: false, imageInput: false, pdfInput: false, audioInput: false, videoInput: false,
    caching: false, systemPromptStyle: 'top_level' }),
    async createMessage() { throw new Error('stream only'); }, createMessageStream: stream };
}

async function* textResponse(): AsyncGenerator<StreamEvent, void, undefined> {
  yield { type: 'message_start', id: 'reused-id', model: 'test', usage: { input_tokens: 10, output_tokens: 2 } };
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'done' } };
  yield { type: 'content_block_stop', index: 0 };
  yield { type: 'message_delta', stopReason: 'end_turn' };
  yield { type: 'message_stop' };
}

async function* toolResponse(): AsyncGenerator<StreamEvent, void, undefined> {
  yield { type: 'message_start', id: 'reused-id', model: 'test', usage: { input_tokens: 10, output_tokens: 2 } };
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'working' } };
  yield { type: 'content_block_stop', index: 0 };
  yield { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call-one', name: 'Work', input: {} } };
  yield { type: 'content_block_stop', index: 1 };
}

async function fixture(source: LlmProvider, execute: Tool['execute'], overrides: Partial<Options> = {}, create = createSession) {
  const directory = await mkdtemp(join(tmpdir(), 'sdk-session-stream-'));
  directories.push(directory);
  const options = { model: 'test', cwd: directory, tools: [] as string[], systemPrompt: 'Test assistant.', maxTurns: 4,
    permissionMode: 'bypassPermissions' as const, allowDangerouslySkipPermissions: true,
    env: { SDK_STATE: join(directory, 'state'), HOME: directory }, conventions: { configDirEnv: 'SDK_STATE' },
    customTools: [{ name: 'Work', description: 'Test work', inputSchema: { type: 'object' }, permissionLevel: 'readonly' as const,
      execute }], ...overrides };
  const session = await create({ ...options, provider: source });
  sessions.push(session);
  const resume = async (source: LlmProvider) => {
    session.close();
    await session.flush();
    const next = await create({ ...options, provider: source, resume: session.sessionId });
    sessions.push(next);
    return next;
  };
  return { session, resume, options };
}

async function drain(session: SDKSession): Promise<SDKMessage[]> {
  const output: SDKMessage[] = [];
  for await (const message of session.stream()) {
    output.push(message);
    if (message.type === 'result') break;
  }
  return output;
}

const archivedText = 'ORIGINAL_DETAIL ' + 'old detail '.repeat(8_000);
const compactOptions = { contextWindow: 16_000, maxOutputTokens: 1024, customTools: [], thinking: { type: 'disabled' as const },
  turnEndChecks: { openWork: false, completion: false } };

function compactingProvider() {
  let calls = 0;
  const source = provider(async function* () {
    const text = calls++ === 0 ? archivedText : 'done';
    for await (const event of textResponse()) {
      yield event.type === 'content_block_start' ? { ...event, content_block: { type: 'text', text } } : event;
    }
  });
  source.createMessage = vi.fn(async () => ({ id: 'summary', model: 'test',
    content: [{ type: 'text', text: 'SUMMARY_SENTINEL' }], stopReason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 } }));
  return { source };
}

describe('session capacity calibration', () => {
  it('uses reported input across user turns, then invalidates it when the model changes', async () => {
    const requests: ProviderRequest[] = [];
    const source = provider(async function* (request) {
      requests.push(request);
      for await (const event of textResponse()) {
        yield event.type === 'message_start' ? { ...event, model: request.model, usage: { input_tokens: 100, output_tokens: 2 } } : event;
      }
    });
    source.createMessage = vi.fn(async () => ({ id: 'summary', model: 'test',
      content: [{ type: 'text', text: 'Report-only work remains pending.' }], stopReason: 'end_turn', usage: { input_tokens: 100, output_tokens: 10 } }));
    const { session } = await fixture(source, async () => ({ content: '' }), { ...compactOptions, contextWindow: 14_000 });
    await session.send('u'.repeat(28_000));
    expect((await drain(session)).find(event => event.type === 'result')).toMatchObject({ is_error: false });
    await session.send('v'.repeat(12_000));
    expect((await drain(session)).find(event => event.type === 'result')).toMatchObject({ is_error: false });
    expect(source.createMessage).not.toHaveBeenCalled();
    await session.setModel('another-model');
    await session.send('Report only, never edit.');
    expect((await drain(session)).find(event => event.type === 'result')).toMatchObject({ is_error: false });
    expect(source.createMessage).toHaveBeenCalledOnce();
    expect(requests.at(-1)?.model).toBe('another-model');
  });
});

describe('session compact persistence', () => {
  it('restarts with reduced history and a later turn while retaining the original transcript', async () => {
    const { source } = compactingProvider();
    const { session, resume, options } = await fixture(source, async () => ({ content: '' }), compactOptions);
    await session.send('original task');
    await drain(session);
    await session.send('compact now');
    const output = await drain(session);
    expect(output.some(message => message.type === 'system' && message.subtype === 'compact_boundary'), JSON.stringify(output.filter(message => message.type === 'result'))).toBe(true);
    await session.send('later turn');
    await drain(session);
    await session.flush();
    const path = getTranscriptPath(session.sessionId, options.cwd!, options);
    const raw = await readFile(path, 'utf8');
    expect(raw).toContain(archivedText);
    expect(raw).toContain('compact_checkpoint');
    const reduced = await readHistory(path);
    expect(JSON.stringify(reduced)).toContain('SUMMARY_SENTINEL');
    expect(JSON.stringify(reduced)).toContain('later turn');
    expect(JSON.stringify(reduced)).not.toContain('ORIGINAL_DETAIL');
    const requests: ProviderRequest[] = [];
    const restarted = await resume(provider(async function* (request) {
      requests.push(request);
      yield* textResponse();
    }));
    await restarted.send('after restart');
    await drain(restarted);
    const restored = JSON.stringify(requests[0].messages);
    expect(restored).toContain('SUMMARY_SENTINEL');
    expect(restored).toContain('later turn');
    expect(restored).not.toContain('ORIGINAL_DETAIL');
  });

  // Checkpoint write failure and cancellation ordering run against the real journal in
  // core::engine::persistence_tests::{checkpoint_write_failure_preserves_live_and_persisted_history,
  // interruption_during_checkpoint_write_installs_the_committed_history,
  // summary_cancellation_does_not_submit_a_checkpoint}.
});

describe('session streaming history', () => {
  it('records the complete call before execution and resumes one paired response', async () => {
    const done = deferred();
    let requests = 0;
    let calls = 0;
    const source = provider(async function* () {
      if (requests++ > 0) { yield* textResponse(); return; }
      yield* toolResponse();
      await done.promise;
      yield { type: 'message_delta', stopReason: 'tool_use' };
      yield { type: 'message_stop' };
    });
    const fixtureState = await fixture(source, async input => {
      calls++;
      input.changedByTool = true;
      const raw = await readFile(getTranscriptPath(fixtureState.session.sessionId, fixtureState.options.cwd, fixtureState.options), 'utf8');
      expect(raw).toContain('call-one');
      done.resolve();
      return { content: 'saved result' };
    });
    await fixtureState.session.send('work');
    const output = await drain(fixtureState.session);
    expect(output.find(message => message.type === 'result')).toMatchObject({ is_error: false });
    await fixtureState.session.flush();
    const transcriptPath = getTranscriptPath(fixtureState.session.sessionId, fixtureState.options.cwd, fixtureState.options);
    const history = await readHistory(transcriptPath);
    expect(history?.filter(message => message.role === 'assistant')).toHaveLength(2);
    expect(history?.filter(message => message.role === 'assistant')[0].content).toHaveLength(2);
    const firstFrame = output.find(message => message.type === 'assistant')!;
    const prefix = await readHistory(transcriptPath, firstFrame.uuid);
    expect(prefix?.filter(message => message.role === 'assistant')).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: 'working' }] },
    ]);
    const requestsAfterResume: ProviderRequest[] = [];
    const resumed = await fixtureState.resume(provider(async function* (request) {
      requestsAfterResume.push(structuredClone(request));
      yield* textResponse();
    }));
    await resumed.send('continue');
    await drain(resumed);
    const restored = JSON.stringify(requestsAfterResume[0].messages);
    expect(restored).toContain('saved result');
    expect(restored).not.toContain('changedByTool');
    expect(restored).not.toContain('No recorded output');
    expect(calls).toBe(1);
  });

  it('preserves completed tool output after a stream failure without replaying the call', async () => {
    const done = deferred();
    let calls = 0;
    let requests = 0;
    const fixtureState = await fixture(provider(async function* () {
      requests++;
      yield* toolResponse();
      await done.promise;
      yield { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'unfinished', name: 'Work', input: {} } };
      yield { type: 'input_json_delta', index: 2, partialJson: '{"unfinished":' };
      throw new Error('connection lost');
    }), async () => {
      calls++;
      done.resolve();
      return { content: 'saved before disconnect' };
    });
    await fixtureState.session.send('work');
    const output = await drain(fixtureState.session);
    expect(output.find(message => message.type === 'result')).toMatchObject({ is_error: true });
    expect(calls).toBe(1);
    expect(requests).toBe(1);
    const requestsAfterResume: ProviderRequest[] = [];
    const resumed = await fixtureState.resume(provider(async function* (request) {
      requestsAfterResume.push(structuredClone(request));
      yield* textResponse();
    }));
    await resumed.send('continue');
    await drain(resumed);
    const restored = JSON.stringify(requestsAfterResume[0].messages);
    expect(restored).toContain('saved before disconnect');
    expect(restored).not.toContain('unfinished');
    expect(restored).not.toContain('No recorded output');
  });

  it('releases session ownership even if cancellation result persistence fails', async () => {
    const fixtureState = await fixture(provider(async function* (request) {
      yield* toolResponse();
      const signal = request.providerOptions?.signal as AbortSignal;
      await new Promise<void>(resolve => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
    }), async () => ({ content: 'completed work' }));
    const transcript = getTranscriptPath(fixtureState.session.sessionId, fixtureState.options.cwd, fixtureState.options);
    await fixtureState.session.send('work');
    for await (const message of fixtureState.session.stream()) {
      if (message.type !== 'tool_progress' || message.elapsed_time_seconds === undefined) continue;
      await rm(transcript);
      await mkdir(transcript);
      fixtureState.session.close();
      break;
    }
    await expect(fixtureState.session.flush()).resolves.toBeUndefined();
    await rm(transcript, { recursive: true });
    const resumed = await fixtureState.resume(provider(textResponse));
    expect(resumed.sessionId).toBe(fixtureState.session.sessionId);
  });

  it('preserves a completed result when the consumer closes during the model stream', async () => {
    const fixtureState = await fixture(provider(async function* (request) {
      yield* toolResponse();
      const signal = request.providerOptions?.signal as AbortSignal;
      await new Promise<void>(resolve => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
    }), async () => ({ content: 'saved before consumer closed' }));
    await fixtureState.session.send('work');
    for await (const message of fixtureState.session.stream()) {
      if (message.type === 'tool_progress' && message.elapsed_time_seconds !== undefined) break;
    }
    const requestsAfterResume: ProviderRequest[] = [];
    const resumed = await fixtureState.resume(provider(async function* (request) {
      requestsAfterResume.push(structuredClone(request));
      yield* textResponse();
    }));
    await resumed.send('continue');
    await drain(resumed);
    const restored = JSON.stringify(requestsAfterResume[0].messages);
    expect(restored).toContain('saved before consumer closed');
    expect(restored).not.toContain('No recorded output');
  });
});
