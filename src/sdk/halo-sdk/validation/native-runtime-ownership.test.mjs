import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const compiled = process.env.SDK_BEHAVIOR_TEST_ROOT ?? fileURLToPath(new URL('../dist', import.meta.url));
const { NativeRuntime } = await import(pathToFileURL(join(compiled, 'native/runtime.js')).href);
const capabilities = () => ({ streaming: true, toolCalling: true, imageInput: false, thinking: false, pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' });
const provider = { id: 'fixture', name: 'Fixture', capabilities,
  async createMessage() { throw new Error('No model work is expected'); },
  async *createMessageStream() { throw new Error('No model work is expected'); } };

test('native runtimes refuse a live transcript owner and wait for its closing owner before replacement', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'halo-native-owner-'));
  const firstRuntime = new NativeRuntime(), secondRuntime = new NativeRuntime();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let closing;
  const started = new Promise(resolve => { closing = resolve; });
  const options = { sessionId: 'ownership-fixture', model: 'fixture', provider, cwd: root,
    env: { HOME: root, CLAUDE_CONFIG_DIR: join(root, 'state') }, collaboration: false, tools: [], systemPrompt: 'Fixture', thinking: { type: 'disabled' } };
  let first, replacement;
  try {
    first = await firstRuntime.createSession({ ...options, hooks: { SessionEnd: [{ hooks: [async () => { closing(); await gate; }] }] } });
    await assert.rejects(secondRuntime.createSession(options), /already|active|owned/i);
    first.close(); await started;
    let accepted = false;
    const next = secondRuntime.createSession(options).then(session => { accepted = true; return session; });
    await delay(30); assert.equal(accepted, false);
    release(); replacement = await next;
    await first[Symbol.asyncDispose](); first = undefined;
    assert.equal(replacement.sessionId, 'ownership-fixture');
    await replacement[Symbol.asyncDispose](); replacement = undefined;
  } finally {
    release(); await first?.[Symbol.asyncDispose](); await replacement?.[Symbol.asyncDispose]();
    await Promise.all([firstRuntime.close(), secondRuntime.close()]);
    await rm(root, { recursive: true, force: true });
  }
});
