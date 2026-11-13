import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession, type SDKSession } from '../index.js';
import type { LlmProvider, StreamEvent } from '../types/provider.js';

const sessions: SDKSession[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function provider(calls: { value: number }): LlmProvider {
  return {
    id: 'fixture', name: 'Fixture',
    capabilities: () => ({ streaming: true, toolCalling: false, thinking: false, imageInput: false,
      pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
    async createMessage() { throw new Error('Unexpected summary'); },
    async *createMessageStream(request): AsyncGenerator<StreamEvent> {
      calls.value++;
      yield { type: 'message_start', id: 'r', model: request.model, usage: { input_tokens: 1, output_tokens: 1 } };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'ok' } };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', stopReason: 'end_turn' };
      yield { type: 'message_stop' };
    },
  };
}

describe('native session input text', () => {
  it('rejects an unpaired UTF-16 surrogate explicitly without calling the provider', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'sdk-input-unicode-')); directories.push(cwd);
    const calls = { value: 0 };
    const session = await createSession({ model: 'fixture', provider: provider(calls), cwd,
      env: { HOME: cwd, CLAUDE_CONFIG_DIR: join(cwd, 'config') }, settingSources: [],
      persistSession: false, permissionMode: 'bypassPermissions', systemPrompt: 'Fixture.',
      tools: [], maxTurns: 2, turnEndChecks: { openWork: false, completion: false } });
    sessions.push(session);
    await expect(session.send('USER_\ud800')).rejects.toThrow(/unpaired UTF-16 surrogate/);
    expect(calls.value).toBe(0);
  });

  it('accepts a well-formed surrogate pair', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'sdk-input-unicode-')); directories.push(cwd);
    const calls = { value: 0 };
    const session = await createSession({ model: 'fixture', provider: provider(calls), cwd,
      env: { HOME: cwd, CLAUDE_CONFIG_DIR: join(cwd, 'config') }, settingSources: [],
      persistSession: false, permissionMode: 'bypassPermissions', systemPrompt: 'Fixture.',
      tools: [], maxTurns: 2, turnEndChecks: { openWork: false, completion: false } });
    sessions.push(session);
    await session.send('emoji: \u{1F600}');
    for await (const event of session.stream()) if (event.type === 'result') break;
    expect(calls.value).toBe(1);
  });
});
