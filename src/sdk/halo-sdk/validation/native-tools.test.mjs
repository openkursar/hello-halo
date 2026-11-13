import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const compiled = process.env.SDK_BEHAVIOR_TEST_ROOT ?? fileURLToPath(new URL('../dist', import.meta.url));
const sdk = await import(pathToFileURL(join(compiled, 'native/index.js')).href);
const { releaseNativeToolOwner } = await import(pathToFileURL(join(compiled, 'native/tools.js')).href);
const baseline = JSON.parse(await readFile(new URL('fixtures/native-tools-baseline.json', import.meta.url), 'utf8'));

test('native public tool pool retains ordering, instance boundaries and direct validation output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'halo-native-tools-'));
  const tools = sdk.getAllTools(), second = sdk.getAllTools();
  const context = { sessionId: `tools-${process.pid}`, cwd: root, env: { HOME: root }, abortSignal: new AbortController().signal,
    costTracker: new sdk.CostTracker('fixture'), currentTurn: 1, readFileState: new Map(), skillCatalog: [] };
  try {
    assert.deepEqual(tools.map(tool => tool.name), baseline.map(item => item.name));
    assert.notEqual(tools[0], second[0]); assert.equal(tools[0].inputSchema, second[0].inputSchema);
    assert.equal(tools.find(tool => tool.name === 'Bash'), second.find(tool => tool.name === 'Bash'));
    assert.equal(sdk.filterTools(tools), tools);
    assert.deepEqual(sdk.filterTools(tools, { allowedTools: ['Read', 'Write'], disallowedTools: ['Write'] }), [tools[0]]);
    assert.equal(sdk.findToolByName([tools[0], second[0]], 'Read'), tools[0]);
    for (const item of baseline) assert.deepEqual(await sdk.findToolByName(tools, item.name).execute({}, context), item.result, item.name);
  } finally { await releaseNativeToolOwner(context.sessionId); await rm(root, { recursive: true, force: true }); }
});

test('direct native file tools use the caller read map and direct shell calls retain session state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'halo-native-tools-')), tools = sdk.getAllTools();
  const path = join(root, 'file.txt'), state = new Map(), observed = [];
  const context = { sessionId: `direct-${process.pid}`, cwd: root, env: { HOME: root }, abortSignal: new AbortController().signal,
    costTracker: new sdk.CostTracker('fixture'), currentTurn: 1, readFileState: state, skillCatalog: [],
    recordFileChange(file, before, after) { assert.equal(file, path); assert.ok(Buffer.isBuffer(before) && Buffer.isBuffer(after)); observed.push(state.get(path)); } };
  const execute = (name, input, supplied = context) => sdk.findToolByName(tools, name).execute(input, supplied);
  try {
    await writeFile(path, 'original\n');
    const denied = await execute('Write', { file_path: path, content: 'unread' }); assert.equal(denied.isError, true);
    assert.equal(await readFile(path, 'utf8'), 'original\n');
    assert.equal((await execute('Read', { file_path: path })).isError, false); assert.ok(state.has(path));
    const written = await execute('Write', { file_path: path, content: 'changed\n' });
    assert.equal(written.isError, false, written.content);
    assert.equal(await readFile(path, 'utf8'), 'changed\n'); assert.equal(observed.length, 1); assert.equal(observed[0].content, 'changed\n');
    const aborted = new AbortController(); aborted.abort();
    assert.equal((await execute('Read', { file_path: path }, { ...context, abortSignal: aborted.signal })).isError, false);
    const first = await execute('Bash', { command: 'export FIXTURE_VALUE=retained' }); assert.equal(first.isError, false);
    const second = await execute('Bash', { command: 'printf "%s" "$FIXTURE_VALUE"' }); assert.equal(second.isError, false); assert.match(second.content, /retained/);
  } finally { await releaseNativeToolOwner(context.sessionId); await rm(root, { recursive: true, force: true }); }
});

test('foreground and managed background shells keep restored environment values out of argv', { skip: process.platform === 'win32', timeout: 30_000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'halo-shell-argv-')));
  const nested = join(root, 'nested'); await mkdir(nested);
  const marker = `synthetic-${randomUUID()}`, value = `${marker} quote'" $literal \`plain\`\nsecond line`;
  const expected = createHash('sha256').update(value).digest('hex');
  const child = join(root, 'child.cjs');
  await writeFile(child, `const fs = require('node:fs'), crypto = require('node:crypto');
process.stdin.resume();
process.stdin.once('end', () => {
  fs.writeFileSync(process.argv[2], JSON.stringify({ ppid: process.ppid, cwd: process.cwd(),
    hash: crypto.createHash('sha256').update(process.env.SDK_SYNTHETIC_SECRET || '').digest('hex'),
    retained: process.env.SDK_LOCAL_EXPORT === 'retained', stdinEnded: true,
    aliases: Object.keys(process.env).filter(key => key.startsWith('HALO_SHELL_RESTORE_')).length }));
  const started = Date.now();
  const timer = setInterval(() => { if (fs.existsSync(process.argv[3]) || Date.now() - started > 10000) clearInterval(timer); }, 10);
});`);
  const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
  const tools = sdk.getAllTools(), bash = sdk.findToolByName(tools, 'Bash'), output = sdk.findToolByName(tools, 'TaskOutput');
  let probeError, completed = 0;
  const probe = { name: 'Probe', description: 'Check shell invocation.', inputSchema: { type: 'object' }, permissionLevel: 'readonly',
    async execute(_input, context) {
      try {
        for (let step = 0; step < 3; step++) {
          const info = join(root, `info-${step}.json`), release = join(root, `release-${step}`);
          const command = `${step === 0 ? `export SDK_LOCAL_EXPORT=retained; cd ${quote(nested)}; ` : ''}${quote(process.execPath)} ${quote(child)} ${quote(info)} ${quote(release)}`;
          const pending = bash.execute({ command, run_in_background: step === 2 }, context);
          let launched;
          try {
            const deadline = Date.now() + 5000; let data;
            while (!data) {
              try { data = JSON.parse(await readFile(info, 'utf8')); }
              catch (error) { if (error.code !== 'ENOENT' || Date.now() > deadline) throw error; await delay(10); }
            }
            assert.equal(data.hash === expected, true); assert.equal(data.cwd, nested);
            assert.equal(data.retained, true); assert.equal(data.stdinEnded, true); assert.equal(data.aliases, 0);
            const argv = await promisify(execFile)('/bin/ps', ['-o', 'command=', '-p', String(data.ppid)], { encoding: 'utf8' });
            assert.equal(argv.stdout.includes(marker), false);
          } finally { await writeFile(release, 'release'); launched = await pending; }
          assert.equal(launched.isError, false);
          if (step === 2) {
            const result = await output.execute({ task_id: launched.metadata.task_id, block: true, timeout: 5000 }, context);
            assert.equal(result.isError, false); assert.equal(JSON.parse(result.content).task.status, 'completed');
          }
          completed++;
        }
        return { content: 'Shell checks passed.', isError: false };
      } catch (error) { probeError = error; throw error; }
    } };
  let calls = 0;
  const provider = { id: 'fixture', name: 'Fixture', capabilities: () => ({ streaming: true, toolCalling: true, imageInput: false, thinking: false, pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
    async createMessage() { throw new Error('Unexpected summary'); },
    async *createMessageStream(request) {
      const execute = ++calls === 1;
      yield { type: 'message_start', id: 'fixture', model: request.model, usage: { input_tokens: 10, output_tokens: 0 } };
      yield { type: 'content_block_start', index: 0, content_block: execute ? { type: 'tool_use', id: 'probe', name: 'Probe', input: {} } : { type: 'text', text: 'Done.' } };
      yield { type: 'content_block_stop', index: 0 }; yield { type: 'message_delta', stopReason: execute ? 'tool_use' : 'end_turn', usage: { output_tokens: 1 } }; yield { type: 'message_stop' };
    } };
  const session = await sdk.createSession({ model: 'fixture', provider, cwd: root, env: { HOME: root, AGENT_SHELL: '/bin/bash', SDK_SYNTHETIC_SECRET: value }, tools: [], customTools: [probe],
    collaboration: false, persistSession: false, permissionMode: 'bypassPermissions', systemPrompt: 'Fixture.', thinking: { type: 'disabled' } });
  try {
    await session.send('Run.'); for await (const _event of session.stream()) {}
    if (probeError) throw probeError;
    assert.equal(completed, 3); assert.equal(calls, 2);
  } finally { await session[Symbol.asyncDispose](); await rm(root, { recursive: true, force: true }); }
});

test('normal sessions preserve duplicate custom declarations and execute the first implementation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'halo-native-duplicates-')); const effects = [];
  const base = { name: 'Duplicate', inputSchema: { type: 'object' }, permissionLevel: 'readonly' };
  const tools = ['first', 'second'].map(description => ({ ...base, description,
    async execute() { effects.push(description); return { content: description, isError: false }; } }));
  let calls = 0;
  const provider = { id: 'fixture', name: 'Fixture', capabilities: () => ({ streaming: true, toolCalling: true, imageInput: false, thinking: false, pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
    async createMessage() { throw new Error('Unexpected summary'); },
    async *createMessageStream(request) {
      assert.deepEqual(request.tools.map(tool => tool.description), ['first', 'second']);
      const first = ++calls === 1;
      yield { type: 'message_start', id: 'fixture', model: request.model, usage: { input_tokens: 10, output_tokens: 0 } };
      yield { type: 'content_block_start', index: 0, content_block: first ? { type: 'tool_use', id: 'duplicate', name: 'Duplicate', input: {} } : { type: 'text', text: 'Done.' } };
      yield { type: 'content_block_stop', index: 0 }; yield { type: 'message_delta', stopReason: first ? 'tool_use' : 'end_turn', usage: { output_tokens: 1 } }; yield { type: 'message_stop' };
    } };
  const session = await sdk.createSession({ model: 'fixture', provider, cwd: root, env: { HOME: root }, tools: [], customTools: tools,
    collaboration: false, persistSession: false, permissionMode: 'bypassPermissions', systemPrompt: 'Fixture.', thinking: { type: 'disabled' } });
  try { await session.send('Run.'); for await (const _event of session.stream()) {} assert.deepEqual(effects, ['first']); }
  finally { await session[Symbol.asyncDispose](); await rm(root, { recursive: true, force: true }); }
});

test('SDK tool contexts share state within a run and retain the previous cost after another send', async () => {
  const root = await mkdtemp(join(tmpdir(), 'halo-native-context-')), path = join(root, 'fixture.txt');
  await writeFile(path, 'context evidence');
  const contexts = [], builtin = sdk.findToolByName(sdk.getAllTools(), 'Read');
  const tool = { name: 'Inspect', description: 'Inspect fixture.', inputSchema: { type: 'object' }, permissionLevel: 'readonly',
    async execute(_input, context) { contexts.push(context); return builtin.execute({ file_path: path }, context); } };
  let count = 0;
  const provider = { id: 'fixture', name: 'Fixture', capabilities: () => ({ streaming: true, toolCalling: true, imageInput: false, thinking: false, pdfInput: false, audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
    async createMessage() { throw new Error('Unexpected summary'); },
    async *createMessageStream(request) {
      const step = ++count; const execute = step % 3 !== 0;
      yield { type: 'message_start', id: `response-${step}`, model: request.model, usage: { input_tokens: 10, output_tokens: 0 } };
      yield { type: 'content_block_start', index: 0, content_block: execute ? { type: 'tool_use', id: `call-${step}`, name: 'Inspect', input: {} } : { type: 'text', text: 'Finished.' } };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', stopReason: execute ? 'tool_use' : 'end_turn', usage: { output_tokens: 2 } }; yield { type: 'message_stop' };
    } };
  const session = await sdk.createSession({ model: 'fixture', provider, cwd: root, env: { HOME: root }, tools: [], customTools: [tool], collaboration: false,
    persistSession: false, systemPrompt: 'Fixture.', permissionMode: 'bypassPermissions', thinking: { type: 'disabled' } });
  try {
    await session.send('First.'); for await (const _event of session.stream()) {}
    assert.equal(contexts.length, 2); assert.equal(contexts[0].costTracker, contexts[1].costTracker); assert.equal(contexts[0].readFileState, contexts[1].readFileState);
    const cost = contexts[0].costTracker.totalTokens; assert.ok(cost > 0); assert.ok(contexts[0].readFileState.has(path));
    await session.send('Second.'); for await (const _event of session.stream()) {}
    assert.equal(contexts.length, 4); assert.notEqual(contexts[2].costTracker, contexts[0].costTracker);
    assert.equal(contexts[2].readFileState, contexts[0].readFileState); assert.equal(contexts[0].costTracker.totalTokens, cost);
  } finally { await session[Symbol.asyncDispose](); await rm(root, { recursive: true, force: true }); }
});
