import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
const compiled = process.env.SDK_BEHAVIOR_TEST_ROOT ?? fileURLToPath(new URL('../dist', import.meta.url));
const { createSession } = await import(pathToFileURL(join(compiled, 'native/session.js')).href);
const { loadBinding } = await import(pathToFileURL(join(compiled, 'native/binding.js')).href);

const capabilities = () => ({
  streaming: true, toolCalling: true, thinking: false, imageInput: false,
  pdfInput: false, audioInput: false, videoInput: false, caching: false,
  systemPromptStyle: 'top_level',
});

function provider(script) {
  const requests = [];
  return {
    id: 'native-fixture', name: 'Native fixture', capabilities, requests,
    async createMessage() { throw new Error('Unexpected non-streaming request'); },
    async *createMessageStream(request) {
      requests.push(structuredClone({ ...request, providerOptions: undefined }));
      const response = await script(request, requests.length);
      yield { type: 'message_start', id: `response-${requests.length}`, model: request.model,
        usage: { input_tokens: 20, output_tokens: 0 } };
      yield { type: 'content_block_start', index: 0, content_block: response.block };
      if (response.block.type === 'text') yield { type: 'text_delta', index: 0, text: response.text };
      yield { type: 'content_block_stop', index: 0 };
      await response.afterBlock?.();
      yield { type: 'message_delta', stopReason: response.block.type === 'tool_use' ? 'tool_use' : 'end_turn',
        usage: { output_tokens: 5 } };
      yield { type: 'message_stop' };
    },
  };
}

test('native library executes file and shell tools, records results, and restores history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'halo-native-smoke-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  let session;
  let resumed;
  try {
    const info = JSON.parse(loadBinding().runtimeInfo());
    assert.equal(info.implementation, 'rust');
    assert.equal(info.abiVersion, 1);
    const file = join(workspace, 'written.txt');
    const shellFile = join(workspace, 'shell-result.txt');
    const model = provider(async (request, step) => {
      if (step === 1) return {
        block: { type: 'tool_use', id: 'write-call', name: 'Write', input: { file_path: file, content: 'written-by-rust' } },
        afterBlock: async () => {
          const deadline = Date.now() + 3_000;
          while (true) {
            try { assert.equal(await readFile(file, 'utf8'), 'written-by-rust'); break; }
            catch (error) { if (Date.now() >= deadline) throw error; await delay(10); }
          }
        },
      };
      if (step === 2) {
        assert.ok(request.messages.some(message => Array.isArray(message.content) && message.content.some(block => block.tool_use_id === 'write-call')));
        return { block: { type: 'tool_use', id: 'shell-call', name: 'Bash', input: { command: "printf '%s' 'shell-ok' > shell-result.txt" } } };
      }
      assert.equal(await readFile(shellFile, 'utf8'), 'shell-ok');
      assert.ok(request.messages.some(message => Array.isArray(message.content) && message.content.some(block => block.tool_use_id === 'shell-call')));
      return { block: { type: 'text', text: '' }, text: 'Fixture completed' };
    });
    const options = { model: 'local-native', cwd: workspace,
      env: { HOME: root, CLAUDE_CONFIG_DIR: join(root, 'state') }, tools: ['Write', 'Read', 'Bash'],
      permissionMode: 'bypassPermissions', thinking: { type: 'disabled' }, systemPrompt: 'Local test', includePartialMessages: true };
    session = await createSession({ ...options, provider: model });
    let consumed = 0;
    await session.send('Create both files.', { onConsumed: () => consumed++ });
    const events = [];
    for await (const event of session.stream()) events.push(event);
    assert.equal(consumed, 1);
    assert.equal(events.filter(event => event.type === 'result').at(-1).subtype, 'success');
    assert.equal(events.at(-1).subtype, 'session_state_changed');
    assert.equal(events.at(-1).state, 'idle');
    assert.equal(model.requests.length, 3);
    assert.ok(events.some(event => event.type === 'stream_event'));
    const sessionId = session.sessionId;
    await session[Symbol.asyncDispose]();
    session = undefined;
    const nextModel = provider(async request => {
      assert.ok(JSON.stringify(request.messages).includes('write-call'));
      assert.ok(JSON.stringify(request.messages).includes('shell-call'));
      assert.ok(JSON.stringify(request.messages).includes('Fixture completed'));
      return { block: { type: 'text', text: '' }, text: 'Restored' };
    });
    resumed = await createSession({ ...options, provider: nextModel, resume: sessionId, strictResume: true });
    await resumed.send('Continue from saved history.');
    const restored = [];
    for await (const event of resumed.stream()) restored.push(event);
    assert.equal(restored.filter(event => event.type === 'result').at(-1).subtype, 'success');
    assert.equal(restored.at(-1).subtype, 'session_state_changed');
    assert.equal(restored.at(-1).state, 'idle');
    assert.equal(nextModel.requests.length, 1);
    await resumed[Symbol.asyncDispose]();
    resumed = undefined;
    assert.equal(JSON.parse(loadBinding().runtimeDiagnostics()).activeSessions, 0);
  } finally {
    await session?.[Symbol.asyncDispose]();
    await resumed?.[Symbol.asyncDispose]();
    await rm(root, { recursive: true, force: true });
  }
});

test('native hooks thread inputs, apply host permission, preserve real effects and close callbacks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'halo-native-hooks-'));
  let session;
  let ended = 0;
  const hooksSeen = [];
  try {
    const file = join(root, 'hook-adjusted.txt');
    const model = provider(async (request, step) => {
      if (step === 1) {
        assert.match(JSON.stringify(request.messages), /context from submit/);
        return { block: { type: 'tool_use', id: 'hook-write', name: 'Write', input: { file_path: 'wrong-path', content: 'before' } } };
      }
      assert.equal(await readFile(file, 'utf8'), 'from permission');
      const result = request.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).find(block => block.tool_use_id === 'hook-write');
      assert.match(result.content, /a PreToolUse hook and permission callback adjusted/);
      assert.match(result.content, /pre context/);
      assert.match(result.content, /replacement output\n\npost context/);
      return { block: { type: 'text', text: '' }, text: 'Done' };
    });
    session = await createSession({ model: 'fixture', provider: model, cwd: root,
      env: { HOME: root, CLAUDE_CONFIG_DIR: join(root, 'state') }, tools: ['Write'],
      systemPrompt: 'Local fixture', thinking: { type: 'disabled' },
      hooks: {
        UserPromptSubmit: [{ hooks: [async () => ({ additionalContext: 'context from submit' })] }],
        PreToolUse: [{ matcher: 'Write', hooks: [
          async input => { hooksSeen.push(input.tool_input.content); return { updatedInput: { file_path: file, content: 'from first' } }; },
          async input => { hooksSeen.push(input.tool_input.content); return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'pre context' } }; },
        ] }],
        PostToolUse: [{ matcher: 'Write', hooks: [async input => {
          assert.equal(input.tool_input.content, 'from permission');
          assert.equal(await readFile(file, 'utf8'), 'from permission');
          return { updatedMCPToolOutput: 'replacement output', additionalContext: 'post context' };
        }] }],
        SessionEnd: [{ hooks: [async input => { assert.equal(input.reason, 'other'); ended++; return {}; }] }],
      },
      canUseTool: async (name, input) => {
        assert.equal(name, 'Write'); assert.equal(input.content, 'from first');
        return { behavior: 'allow', updatedInput: { content: 'from permission' } };
      },
    });
    await session.send('Write a file');
    const events = [];
    for await (const event of session.stream()) events.push(event);
    assert.equal(events.filter(event => event.type === 'result').at(-1).subtype, 'success');
    assert.equal(events.at(-1).subtype, 'session_state_changed');
    assert.equal(events.at(-1).state, 'idle');
    assert.deepEqual(hooksSeen, ['before', 'from first']);
    assert.equal(events.filter(event => event.type === 'tool_progress').length, 2);
    await session[Symbol.asyncDispose](); session = undefined;
    assert.equal(ended, 1);
  } finally {
    await session?.[Symbol.asyncDispose]();
    await rm(root, { recursive: true, force: true });
  }
});


test('native session waits for stream consumption and retires an interrupted idle reader', async () => {
  const root = await mkdtemp(join(tmpdir(), 'halo-native-lazy-stream-'));
  let session;
  try {
    const model = provider(async () => ({ block: { type: 'text', text: '' }, text: 'read after stream starts' }));
    session = await createSession({ model: 'fixture', provider: model, cwd: root, env: { HOME: root },
      tools: [], persistSession: false, collaboration: false, systemPrompt: 'Local fixture', thinking: { type: 'disabled' } });
    const idle = session.stream();
    const waiting = idle.next();
    await delay(20);
    await session.interrupt();
    assert.deepEqual(await waiting, { done: true, value: undefined });
    await session.send('Wait for the reader.');
    await delay(30);
    assert.equal(model.requests.length, 0);
    const events = [];
    for await (const event of session.stream()) events.push(event);
    assert.equal(model.requests.length, 1);
    assert.equal(events[0].subtype, 'session_state_changed');
    assert.equal(events[0].state, 'running');
    assert.equal(events.filter(event => event.type === 'result').at(-1).subtype, 'success');
    assert.equal(events.at(-1).state, 'idle');
  } finally { await session?.[Symbol.asyncDispose](); await rm(root, { recursive: true, force: true }); }
});
