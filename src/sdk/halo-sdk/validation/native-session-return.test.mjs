import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const compiled = process.env.SDK_BEHAVIOR_TEST_ROOT ?? fileURLToPath(new URL('../dist', import.meta.url));
const { createSession } = await import(pathToFileURL(join(compiled, process.env.SDK_SESSION_ENTRY ?? 'native/session.js')).href);

test('returning an ordinary session iterator at tool progress prevents the announced write', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'halo-session-return-'));
  const file = join(root, 'effect.txt');
  let requests = 0;
  const provider = {
    id: 'return-fixture', name: 'Return fixture',
    capabilities: () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: false, pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
    async createMessage() { throw new Error('Unexpected completion request'); },
    async *createMessageStream(request) {
      const step = ++requests;
      const block = step === 1 ? { type: 'tool_use', id: 'write', name: 'Write', input: { file_path: file, content: 'effect happened' } } : { type: 'text', text: '' };
      yield { type: 'message_start', id: `return-${step}`, model: request.model, usage: { input_tokens: 1, output_tokens: 0 } };
      yield { type: 'content_block_start', index: 0, content_block: block };
      if (block.type === 'text') yield { type: 'text_delta', index: 0, text: 'Finished.' };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', stopReason: block.type === 'tool_use' ? 'tool_use' : 'end_turn', usage: { output_tokens: 1 } };
      yield { type: 'message_stop' };
    },
  };
  let session;
  let announced = false;
  try {
    session = await createSession({ model: 'fixture', provider, cwd: root, env: { HOME: root }, persistSession: false,
      tools: ['Write'], collaboration: false, permissionMode: 'bypassPermissions', systemPrompt: 'Iterator return fixture.', thinking: { type: 'disabled' } });
    await session.send('Write the evidence file.');
    for await (const event of session.stream()) {
      if (event.type === 'tool_progress' && event.tool_use_id === 'write' && event.elapsed_time_seconds === undefined) {
        announced = true;
        await delay(50);
        break;
      }
    }
    assert.equal(announced, true);
    await assert.rejects(readFile(file), { code: 'ENOENT' });
    assert.equal(requests, 1);
    await session.send('Respond without tools after the stopped turn.');
    const results = [];
    for await (const event of session.stream()) if (event.type === 'result') results.push(event);
    assert.equal(results.length, 1);
    assert.equal(results[0].subtype, 'success');
    assert.equal(results[0].result, 'Finished.');
    assert.equal(requests, 2);
    await assert.rejects(readFile(file), { code: 'ENOENT' });
  } finally { await session?.[Symbol.asyncDispose](); await rm(root, { recursive: true, force: true }); }
});

test('pausing at the running boundary starts no model request and a replacement stream retains the queued input', { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'halo-session-handoff-'));
  let requests = 0;
  const provider = {
    id: 'handoff-fixture', name: 'Handoff fixture',
    capabilities: () => ({ streaming: true, toolCalling: false, thinking: false, imageInput: false, pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
    async createMessage() { throw new Error('Unexpected completion request'); },
    async *createMessageStream(request) {
      requests++;
      assert.match(JSON.stringify(request.messages), /Keep this queued input/);
      yield { type: 'message_start', id: 'handoff', model: request.model, usage: { input_tokens: 1, output_tokens: 0 } };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
      yield { type: 'text_delta', index: 0, text: 'Input retained.' };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', stopReason: 'end_turn', usage: { output_tokens: 1 } };
      yield { type: 'message_stop' };
    },
  };
  const session = await createSession({ model: 'fixture', provider, cwd: root, env: { HOME: root }, persistSession: false,
    tools: [], collaboration: false, systemPrompt: 'Iterator handoff fixture.', thinking: { type: 'disabled' } });
  try {
    await session.send('Keep this queued input for the replacement stream.');
    const first = session.stream();
    const running = await first.next();
    assert.equal(running.value.state, 'running');
    await delay(50);
    assert.equal(requests, 0);
    const results = [];
    for await (const event of session.stream()) if (event.type === 'result') results.push(event);
    assert.equal(results.length, 1);
    assert.equal(results[0].result, 'Input retained.');
    assert.equal(requests, 1);
    assert.equal((await first.next()).done, true);
  } finally { await session[Symbol.asyncDispose](); await rm(root, { recursive: true, force: true }); }
});

test('returning a one-shot query at init admits no model request', { timeout: 10_000 }, async () => {
  const { query } = await import(pathToFileURL(join(compiled, process.env.SDK_SESSION_ENTRY === 'index.js' ? 'index.js' : 'native/index.js')).href);
  const root = await mkdtemp(join(tmpdir(), 'halo-query-init-'));
  let requests = 0;
  const provider = {
    id: 'init-fixture', name: 'Init fixture',
    capabilities: () => ({ streaming: true, toolCalling: false, thinking: false, imageInput: false, pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
    async createMessage() { requests++; throw new Error('No completion request was admitted'); },
    async *createMessageStream() { requests++; throw new Error('No streaming request was admitted'); },
  };
  const stream = query({ prompt: 'Do not start before the consumer continues.', options: {
    model: 'fixture', provider, cwd: root, env: { HOME: root }, persistSession: false, tools: [], collaboration: false,
    systemPrompt: 'Query init fixture.', thinking: { type: 'disabled' },
  } });
  try {
    const first = await stream.next();
    assert.equal(first.value.type, 'system');
    assert.equal(first.value.subtype, 'init');
    await delay(50);
    await stream.return(undefined);
    assert.equal(requests, 0);
  } finally { await stream.return(undefined); await rm(root, { recursive: true, force: true }); }
});

test('replacing a pending read interrupts the stalled turn and processes queued input', { timeout: 10_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'halo-pending-read-'));
  let ready, session, requests = 0;
  const started = new Promise(resolve => { ready = resolve; });
  t.signal.addEventListener('abort', () => { ready(); session?.close(); }, { once: true });
  const provider = {
    id: 'fixture', name: 'Fixture',
    capabilities: () => ({ streaming: true, toolCalling: false, thinking: false, imageInput: false, pdfInput: false,
      audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
    async createMessage() { throw new Error('Unexpected summary request'); },
    async *createMessageStream(request) {
      requests++;
      if (requests === 1) {
        ready();
        await new Promise(resolve => {
          const signal = request.providerOptions.signal;
          if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true });
        });
        throw Object.assign(new Error('Fixture request aborted'), { name: 'AbortError' });
      }
      assert.equal(requests, 2);
      assert.match(JSON.stringify(request.messages), /REPLACEMENT_INPUT/);
      yield { type: 'message_start', id: 'replacement', model: request.model, usage: { input_tokens: 1, output_tokens: 0 } };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Replacement completed.' } };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', stopReason: 'end_turn', usage: { output_tokens: 1 } };
      yield { type: 'message_stop' };
    },
  };
  try {
    session = await createSession({ model: 'fixture', provider, cwd: root, env: { HOME: root }, persistSession: false,
      tools: [], skillCatalog: [], settingSources: [], collaboration: false, systemPrompt: 'Fixture instructions.',
      thinking: { type: 'disabled' }, turnEndChecks: { openWork: false, completion: false } });
    await session.send('Start a stalled request.');
    const first = session.stream();
    assert.equal((await first.next()).value.state, 'running');
    assert.equal((await first.next()).value.subtype, 'init');
    const pending = first.next();
    await started;
    t.signal.throwIfAborted();
    await session.send('REPLACEMENT_INPUT');
    const events = [];
    for await (const event of session.stream()) events.push(event);
    assert.equal(events.filter(event => event.type === 'result').length, 1);
    assert.equal(events.find(event => event.type === 'result').result, 'Replacement completed.');
    assert.equal(requests, 2);
    await pending;
    assert.equal((await first.next()).done, true);
  } finally { await session?.[Symbol.asyncDispose](); await rm(root, { recursive: true, force: true }); }
});

test('simultaneous stream replacements leave one reader and preserve queued input once', { timeout: 10_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'halo-stream-replacements-'));
  let session, requests = 0;
  t.signal.addEventListener('abort', () => session?.close(), { once: true });
  const provider = {
    id: 'fixture', name: 'Fixture',
    capabilities: () => ({ streaming: true, toolCalling: false, thinking: false, imageInput: false, pdfInput: false,
      audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
    async createMessage() { throw new Error('Unexpected summary request'); },
    async *createMessageStream(request) {
      requests++;
      assert.match(JSON.stringify(request.messages), /QUEUED_ONCE/);
      yield { type: 'message_start', id: 'once', model: request.model, usage: { input_tokens: 1, output_tokens: 0 } };
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Consumed once.' } };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', stopReason: 'end_turn', usage: { output_tokens: 1 } };
      yield { type: 'message_stop' };
    },
  };
  const drain = async stream => { const events = []; for await (const event of stream) events.push(event); return events; };
  try {
    session = await createSession({ model: 'fixture', provider, cwd: root, env: { HOME: root }, persistSession: false,
      tools: [], skillCatalog: [], settingSources: [], collaboration: false, systemPrompt: 'Fixture instructions.',
      thinking: { type: 'disabled' }, turnEndChecks: { openWork: false, completion: false } });
    await session.send('QUEUED_ONCE');
    const first = session.stream();
    assert.equal((await first.next()).value.state, 'running');
    const [replaced, latest] = await Promise.all([drain(session.stream()), drain(session.stream())]);
    assert.equal(replaced.filter(event => event.type === 'result').length, 0);
    assert.equal(latest.filter(event => event.type === 'result').length, 1);
    assert.equal(latest.find(event => event.type === 'result').result, 'Consumed once.');
    assert.equal(requests, 1);
    assert.equal((await first.next()).done, true);
  } finally { await session?.[Symbol.asyncDispose](); await rm(root, { recursive: true, force: true }); }
});
