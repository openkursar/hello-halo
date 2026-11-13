import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const compiled = process.env.SDK_BEHAVIOR_TEST_ROOT ?? fileURLToPath(new URL('../dist', import.meta.url));
const workerSource = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { readFile } = require('node:fs/promises');
const { setTimeout: delay } = require('node:timers/promises');
(async () => {
  const { createSession } = await import(workerData.module);
  const provider = {
    id: 'fixture', name: 'Fixture', capabilities: () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: false, pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
    createMessage: async () => { throw new Error('Unexpected nonstreaming request'); },
    async *createMessageStream(request) {
      const hold = workerData.mode === 'hold';
      yield { type: 'message_start', id: 'fixture', model: request.model, usage: { input_tokens: 10, output_tokens: 0 } };
      yield { type: 'content_block_start', index: 0, content_block: hold
        ? { type: 'tool_use', id: 'shell', name: 'Bash', input: { command: "printf '%s' $$ > child.pid; while :; do sleep 1; done" } }
        : { type: 'text', text: '' } };
      if (!hold) yield { type: 'text_delta', index: 0, text: 'ready after environment recreation' };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', stopReason: hold ? 'tool_use' : 'end_turn', usage: { output_tokens: 2 } };
      yield { type: 'message_stop' };
    },
  };
  const session = await createSession({ model: 'fixture', provider, cwd: workerData.root,
    env: { HOME: workerData.root, CLAUDE_CONFIG_DIR: workerData.root + '/state' }, persistSession: false,
    tools: workerData.mode === 'hold' ? ['Bash'] : [], collaboration: false,
    systemPrompt: 'Local fixture', thinking: { type: 'disabled' }, permissionMode: 'bypassPermissions' });
  if (workerData.mode === 'idle') {
    const reader = session.stream();
    const next = reader.next();
    await delay(20);
    await session.interrupt();
    const ended = await next;
    if (!ended.done) throw new Error('Idle reader did not finish on interruption');
  }
  let watching;
  if (workerData.mode === 'hold') {
    watching = setInterval(async () => {
      try { const pid = Number(await readFile(workerData.root + '/child.pid', 'utf8')); clearInterval(watching); parentPort.postMessage({ kind: 'started', pid }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }, 10);
  }
  await session.send('Run the local fixture.');
  let result;
  for await (const event of session.stream()) if (event.type === 'result') result = event;
  if (result?.subtype !== 'success') throw new Error('Native fixture did not complete successfully');
  await session[Symbol.asyncDispose]();
  clearInterval(watching);
  parentPort.postMessage({ kind: 'done' });
  parentPort.close();
})().catch(error => { parentPort.postMessage({ kind: 'error', message: String(error) }); process.exitCode = 1; });
`;

async function message(worker, kind) {
  const timeout = AbortSignal.timeout(15_000);
  while (true) {
    const [value] = await once(worker, 'message', { signal: timeout });
    if (value.kind === 'error') throw new Error(value.message);
    if (value.kind === kind) return value;
  }
}

function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }

async function childScenario(root) {
  const module = pathToFileURL(join(compiled, 'native/session.js')).href;
  const workers = [];
  const start = async (name, mode) => {
    const directory = join(root, name); await mkdir(directory);
    const worker = new Worker(workerSource, { eval: true, workerData: { module, root: directory, mode } });
    workers.push(worker); return worker;
  };
  const terminate = async worker => {
    const { pid } = await message(worker, 'started');
    assert.ok(Number.isInteger(pid) && pid > 0);
    await worker.terminate();
    const deadline = Date.now() + 5_000;
    while (alive(pid) && Date.now() < deadline) await delay(20);
    assert.equal(alive(pid), false, 'An SDK shell remained alive after its Worker environment was terminated');
  };
  let main;
  try {
    await terminate(await start('first', 'hold'));
    const second = await start('second', 'idle');
    const exited = once(second, 'exit');
    await message(second, 'done'); await exited;
    const { createSession } = await import(module);
    const { loadBinding } = await import(pathToFileURL(join(compiled, 'native/binding.js')).href);
    const provider = { id: 'main', name: 'Main', capabilities: () => ({ streaming: true, toolCalling: false, thinking: false, imageInput: false, pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
      createMessage: async () => { throw new Error('Unexpected nonstreaming request'); },
      async *createMessageStream() { yield { type: 'message_start', id: 'main', model: 'fixture', usage: { input_tokens: 1, output_tokens: 0 } }; yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }; yield { type: 'text_delta', index: 0, text: 'main survives' }; yield { type: 'content_block_stop', index: 0 }; yield { type: 'message_delta', stopReason: 'end_turn', usage: { output_tokens: 1 } }; yield { type: 'message_stop' }; } };
    main = await createSession({ model: 'fixture', provider, cwd: root, persistSession: false, tools: [], collaboration: false, systemPrompt: 'Local fixture', thinking: { type: 'disabled' }, env: { HOME: root } });
    await terminate(await start('third', 'hold'));
    await main.send('Still usable.');
    let result;
    for await (const event of main.stream()) if (event.type === 'result') result = event;
    assert.equal(result.subtype, 'success');
    assert.equal(JSON.parse(loadBinding().runtimeDiagnostics()).activeSessions, 1);
    await main[Symbol.asyncDispose](); main = undefined;
    assert.equal(JSON.parse(loadBinding().runtimeDiagnostics()).activeSessions, 0);
  } finally { await main?.[Symbol.asyncDispose](); await Promise.all(workers.map(worker => worker.terminate())); }
}

if (process.env.HALO_NATIVE_LIFECYCLE_CHILD === '1') {
  await childScenario(process.argv[2]);
  process.stdout.write('native-worker-lifecycle:passed\n');
} else {
  test('native Worker force-close retires only its owned resources and permits environment recreation', { timeout: 45_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'halo-native-env-'));
    try {
      const env = { HOME: root, USERPROFILE: root, TMPDIR: root, TEMP: root, TMP: root,
        SDK_BEHAVIOR_TEST_ROOT: compiled, HALO_NATIVE_LIFECYCLE_CHILD: '1' };
      for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'AGENT_GIT_BASH_PATH', 'CLAUDE_CODE_GIT_BASH_PATH']) if (process.env[key]) env[key] = process.env[key];
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), root], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let output = '', errors = '';
      child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
      const timer = setTimeout(() => child.kill(), 40_000);
      const [code] = await once(child, 'exit'); clearTimeout(timer);
      assert.equal(code, 0, errors);
      assert.match(output, /native-worker-lifecycle:passed/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
