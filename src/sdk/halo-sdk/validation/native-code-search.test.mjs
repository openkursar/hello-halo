import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';

const compiled = process.env.SDK_BEHAVIOR_TEST_ROOT ?? fileURLToPath(new URL('../dist', import.meta.url));
const searchEntry = pathToFileURL(join(compiled, process.env.SDK_SEARCH_ENTRY ?? 'index.js')).href;
const { createCodeSearchService, createCodeSearchTool, getCodeSearchDiagnostics, createSession } = await import(searchEntry);
const execute = promisify(execFile);

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'halo-native-search-'));
  const root = join(directory, 'source');
  await mkdir(root);
  await writeFile(join(root, 'auth.ts'), 'export const authorized = true;\n');
  const modulePath = join(directory, 'backend.mjs');
  await writeFile(modulePath, `
    import { join } from 'node:path';
    import { appendFile, writeFile } from 'node:fs/promises';
    const directory = ${JSON.stringify(directory)};
    export async function createZvecGrep(options) {
      let root;
      let indexes = 0;
      return {
        async index(config) {
          if (config.follow !== false || config.rootPaths[0].follow !== false) throw new Error('unsafe follow');
          root = config.rootPaths[0].absolutePath;
          indexes++;
          await appendFile(join(directory, 'trace.jsonl'), JSON.stringify({ kind: 'index', config, pid: process.pid }) + '\\n');
        },
        async context(input) {
          await appendFile(join(directory, 'trace.jsonl'), JSON.stringify({ kind: 'context', input, pid: process.pid }) + '\\n');
          if (input.query === 'blocked') {
            await writeFile(join(directory, 'blocked-' + process.pid), 'entered');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
          }
          if (input.query === 'async') {
            await new Promise(resolve => setTimeout(resolve, 40));
            await writeFile(join(directory, 'effect.txt'), 'backend asynchronous effect');
          }
          return { items: [{ file: { absolutePath: join(root, 'auth.ts') }, range: { kind: 'text', startLine: 1, endLine: 1 }, status: 'fresh',
            content: JSON.stringify({ pid: process.pid, indexes, embedding: options.embedding, query: input.query }) }] };
        },
        async close() {
          await new Promise(resolve => setTimeout(resolve, 40));
          await writeFile(join(directory, 'closed-' + process.pid), 'closed');
        },
      };
    }
  `);
  return { directory, root, options: { backend: 'zvec-grep', nodePath: process.execPath, modulePath,
    cachePath: join(directory, 'cache'), timeoutMs: 3000, idleTimeoutMs: 1000 } };
}

async function until(condition) {
  const end = performance.now() + 3000;
  while (performance.now() < end) { if (await condition()) return; await delay(5); }
  assert.ok(await condition(), 'the observed lifecycle boundary was not reached');
}
async function exists(path) { try { await access(path); return true; } catch { return false; } }
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } }
function details(result) { return JSON.parse(result.hits[0].snippet); }

test('public CodeSearch factory preserves omitted optional arguments and original result metadata', async () => {
  const returned = { exhaustive: false, freshness: 'fresh', hits: [] };
  let request;
  const tool = createCodeSearchTool({ async search(input) { request = input; return returned; }, async dispose() {} });
  const context = { cwd: '/workspace', abortSignal: new AbortController().signal };
  const result = await tool.execute({ query: 'location' }, context);
  assert.deepEqual(request, { root: context.cwd, query: 'location', limit: undefined, refresh: undefined,
    readDenyRoots: undefined, signal: context.abortSignal });
  assert.equal(result.isError, false);
  assert.equal(result.metadata.hits, returned.hits);
  assert.match(result.content, /not exhaustive/);
});

test('factory-owned declarations use the model catalog while caller edits and service execution stay authoritative', { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'halo-search-declaration-'));
  try {
    for (const edited of [false, true]) {
      let calls = 0;
      const requests = [];
      const tool = createCodeSearchTool({ async search() {
        calls++;
        return { exhaustive: false, freshness: 'fresh', hits: [] };
      }, async dispose() {} });
      if (edited) tool.description = 'Caller-owned declaration.';
      const provider = {
        id: 'search-declaration', name: 'Search declaration fixture',
        capabilities: () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: false, pdfInput: false,
          audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
        async createMessage() { throw new Error('Unexpected summary'); },
        async *createMessageStream(request) {
          requests.push(request);
          const content = requests.length === 1 ? { type: 'tool_use', id: 'search', name: 'CodeSearch', input: { query: 'auth' } }
            : { type: 'text', text: 'Inspected.' };
          yield { type: 'message_start', id: 'response', model: request.model, usage: { input_tokens: 10, output_tokens: 1 } };
          yield { type: 'content_block_start', index: 0, content_block: content };
          yield { type: 'content_block_stop', index: 0 };
          yield { type: 'message_delta', stopReason: requests.length === 1 ? 'tool_use' : 'end_turn' };
          yield { type: 'message_stop' };
        },
      };
      const session = await createSession({ model: 'fixture', provider, cwd: directory, env: { HOME: directory },
        systemPrompt: 'Fixture instructions.', persistSession: false, settingSources: [], collaboration: false,
        tools: [], customTools: [tool], permissionMode: 'bypassPermissions', turnEndChecks: { openWork: false, completion: false },
        harnessText: { models: { fixture: { 'tools.code_search.description': 'MODEL_SEARCH_DESCRIPTION',
          'tools.code_search.input_schema.fields.query.description': 'MODEL_QUERY_DESCRIPTION' } } } });
      try {
        await session.send('Search the fixture.');
        const frames = [];
        for await (const frame of session.stream()) frames.push(frame);
        assert.equal(frames.find(frame => frame.type === 'result').is_error, false);
        const definition = requests[0].tools.find(definition => definition.name === 'CodeSearch');
        assert.equal(definition.description, edited ? 'Caller-owned declaration.' : 'MODEL_SEARCH_DESCRIPTION');
        if (!edited) assert.equal(definition.input_schema.properties.query.description, 'MODEL_QUERY_DESCRIPTION');
        assert.equal(calls, 1);
      } finally { session.close(); await session.flush(); }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('default embedded search indexes lazily and shares ownership within one Node environment', { timeout: 10_000 }, async () => {
  const f = await fixture();
  const first = createCodeSearchService(f.options);
  const second = createCodeSearchService(f.options);
  try {
    assert.deepEqual(getCodeSearchDiagnostics(), { workers: 0, pending: 0, running: 0 });
    assert.equal(await exists(f.options.cachePath), false);
    await assert.rejects(first.search({ root: f.root, query: 'auth', readDenyRoots: [f.root] }), /read restrictions/);
    assert.equal(await exists(join(f.directory, 'trace.jsonl')), false);
    const a = await first.search({ root: f.root, query: 'first', limit: 2 });
    const b = await second.search({ root: f.root, query: 'second' });
    assert.equal(details(a).pid, details(b).pid);
    assert.equal(details(b).indexes, 1);
    assert.equal(details(b).embedding, 'local/potion-code-16m-v2');
    assert.equal(a.freshness, 'fresh');
    assert.equal(b.freshness, 'possibly_stale');
    await first.dispose();
    assert.equal(getCodeSearchDiagnostics().workers, 1);
    const c = await second.search({ root: f.root, query: 'refresh', refresh: true });
    assert.equal(details(c).pid, details(a).pid);
    assert.equal(details(c).indexes, 2);
    const trace = (await readFile(join(f.directory, 'trace.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(trace.filter(entry => entry.kind === 'index').length, 2);
    assert.deepEqual(trace.find(entry => entry.kind === 'context').input, { query: 'first', limit: 2, autoUpdate: false, follow: false });
    await second.dispose();
    await until(() => !alive(details(c).pid));
    assert.equal(await readFile(join(f.directory, `closed-${details(c).pid}`), 'utf8'), 'closed');
  } finally {
    await Promise.all([first.dispose(), second.dispose()]);
    await rm(f.directory, { recursive: true, force: true });
  }
  assert.deepEqual(getCodeSearchDiagnostics(), { workers: 0, pending: 0, running: 0 });
});

test('default embedded search cancels a synchronously blocked backend and dispose refuses new work immediately', { timeout: 10_000 }, async () => {
  const f = await fixture();
  const service = createCodeSearchService(f.options);
  try {
    const before = details(await service.search({ root: f.root, query: 'ready' }));
    const controller = new AbortController();
    const pending = service.search({ root: f.root, query: 'blocked', signal: controller.signal });
    const rejected = assert.rejects(pending, /cancelled/);
    await until(() => exists(join(f.directory, `blocked-${before.pid}`)));
    controller.abort();
    await rejected;
    await until(() => !alive(before.pid));
    const after = details(await service.search({ root: f.root, query: 'restarted' }));
    assert.notEqual(after.pid, before.pid);
    const blocked = service.search({ root: f.root, query: 'blocked' });
    const disposed = assert.rejects(blocked, /cancelled/);
    await until(() => exists(join(f.directory, `blocked-${after.pid}`)));
    const closing = service.dispose();
    await assert.rejects(service.search({ root: f.root, query: 'must not dispatch' }), /cancelled/);
    await Promise.all([closing, disposed]);
    await until(() => !alive(after.pid));
    assert.ok(!(await readFile(join(f.directory, 'trace.jsonl'), 'utf8')).includes('must not dispatch'));
  } finally { await service.dispose(); await rm(f.directory, { recursive: true, force: true }); }
  assert.deepEqual(getCodeSearchDiagnostics(), { workers: 0, pending: 0, running: 0 });
});

test('CodeSearch callback formatting retains the admitting model wording across an asynchronous model change', { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'halo-search-format-'));
  const requests = [];
  let serviceCalls = 0;
  let session;
  const contexts = [];
  const search = createCodeSearchTool({
    async search() {
      if (++serviceCalls === 1) await session.setModel('second');
      return { exhaustive: false, freshness: 'fresh', hits: [] };
    },
    async dispose() {},
  });
  const provider = {
    id: 'search-format', name: 'Search formatting fixture',
    capabilities: () => ({ streaming: true, toolCalling: true, thinking: false, imageInput: false, pdfInput: false,
      audioInput: false, videoInput: false, caching: false, systemPromptStyle: 'top_level' }),
    async createMessage() { throw new Error('Unexpected summary'); },
    async *createMessageStream(request) {
      const index = requests.length;
      requests.push(structuredClone(request));
      const content = index % 2 === 0 ? { type: 'tool_use', id: `search-${index}`, name: 'CodeSearch', input: { query: 'auth' } }
        : { type: 'text', text: 'Search inspected.' };
      yield { type: 'message_start', id: `response-${index}`, model: request.model, usage: { input_tokens: 10, output_tokens: 1 } };
      yield { type: 'content_block_start', index: 0, content_block: content };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', stopReason: index % 2 === 0 ? 'tool_use' : 'end_turn' };
      yield { type: 'message_stop' };
    },
  };
  try {
    session = await createSession({ cwd: directory, env: { HOME: directory }, persistSession: false, settingSources: [],
      provider, model: 'first', collaboration: false, tools: [], customTools: [{ ...search, execute(input, context) {
        contexts.push(context);
        return search.execute(input, context);
      } }], permissionMode: 'bypassPermissions',
      turnEndChecks: { completion: false, openWork: false }, harnessText: { templates: { 'tools.code_search.ranked': 'COMMON:{freshness}' },
        models: { first: { 'tools.code_search.ranked': 'FIRST:{freshness}' }, second: { 'tools.code_search.ranked': 'SECOND:{freshness}' } } } });
    await session.send('Search once.');
    for await (const _frame of session.stream()) {}
    await session.send('Search again.');
    for await (const _frame of session.stream()) {}
    assert.equal(serviceCalls, 2);
    assert.deepEqual(requests.map(request => request.model), ['first', 'first', 'second', 'second']);
    const results = request => request.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === 'tool_result');
    assert.match(results(requests[1]).at(-1).content, /^FIRST:fresh/);
    assert.match(results(requests[3]).at(-1).content, /^SECOND:fresh/);
    assert.equal(contexts.length, 2);
    const retained = await search.execute({ query: 'retained context' }, contexts[0]);
    assert.match(retained.content, /^FIRST:fresh/);
  } finally {
    if (session) { session.close(); await session.flush(); }
    await rm(directory, { recursive: true, force: true });
  }
});

test('terminating a Worker releases its blocked search backend without closing the main environment owner', { timeout: 15_000 }, async () => {
  const f = await fixture();
  const main = createCodeSearchService(f.options);
  let worker;
  try {
    const original = details(await main.search({ root: f.root, query: 'main' }));
    worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const { createCodeSearchService } = await import(workerData.entry);
        const search = createCodeSearchService(workerData.options);
        const result = await search.search({ root: workerData.root, query: 'worker' });
        parentPort.postMessage(JSON.parse(result.hits[0].snippet));
        await search.search({ root: workerData.root, query: 'blocked' });
      })().catch(error => { parentPort.postMessage({ error: String(error) }); });
    `, { eval: true, workerData: { entry: searchEntry, options: f.options, root: f.root } });
    const owned = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
    assert.equal(owned.error, undefined);
    assert.notEqual(owned.pid, original.pid);
    await until(() => exists(join(f.directory, `blocked-${owned.pid}`)));
    await worker.terminate();
    await until(() => !alive(owned.pid));
    assert.ok(alive(original.pid));
    const survived = details(await main.search({ root: f.root, query: 'survived' }));
    assert.equal(survived.pid, original.pid);
    assert.equal(survived.indexes, 1);
    assert.equal(getCodeSearchDiagnostics().workers, 1);
  } finally {
    if (worker) await worker.terminate();
    await main.dispose();
    await rm(f.directory, { recursive: true, force: true });
  }
  assert.deepEqual(getCodeSearchDiagnostics(), { workers: 0, pending: 0, running: 0 });
});

test('unused search exits naturally and active search retains asynchronous work through idle retirement', { timeout: 15_000 }, async () => {
  const f = await fixture();
  try {
    const options = { ...f.options, idleTimeoutMs: 20 };
    const prefix = `import { createCodeSearchService } from ${JSON.stringify(searchEntry)};
      import { writeFile } from 'node:fs/promises';
      const service = createCodeSearchService(${JSON.stringify(options)});`;
    await execute(process.execPath, ['--input-type=module', '-e', `${prefix} process.stdout.write('unused');`], { timeout: 4000 });
    assert.equal(await exists(f.options.cachePath), false);
    const script = `${prefix}
      const result = await service.search({ root: ${JSON.stringify(f.root)}, query: 'async' });
      await writeFile(${JSON.stringify(join(f.directory, 'consumed.json'))}, JSON.stringify(result));`;
    await execute(process.execPath, ['--input-type=module', '-e', script], { timeout: 5000 });
    assert.equal(await readFile(join(f.directory, 'effect.txt'), 'utf8'), 'backend asynchronous effect');
    const result = JSON.parse(await readFile(join(f.directory, 'consumed.json'), 'utf8'));
    const backend = details(result);
    assert.equal(await readFile(join(f.directory, `closed-${backend.pid}`), 'utf8'), 'closed');
    await until(() => !alive(backend.pid));
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
