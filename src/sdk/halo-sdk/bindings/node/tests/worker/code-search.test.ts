import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, access, readFile, copyFile, realpath, symlink } from 'node:fs/promises';
import { join, toNamespacedPath } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { createWorkerRuntime, type WorkerRuntime, type WorkerSession } from '../../worker/index.js';
import { createSession, query, getCodeSearchDiagnostics, type Options, type SDKSession } from '../../index.js';
import type { SDKMessage } from '../../contracts/core/query-types.js';
import { buildWorker } from '../../../../scripts/build-worker.mjs';
import { setup as directSetup } from '../../worker/fixtures/code-search-setup.mjs';
import { createSessionCodeSearchService } from '../../core/code-search.js';

let directory: string;
let workspace: string;
let buildDirectory: string;
const runtimes: WorkerRuntime[] = [];
const directSessions: SDKSession[] = [];
const setup = { module: new URL('../../worker/fixtures/code-search-setup.mjs', import.meta.url).href };
const backend = fileURLToPath(new URL('../../worker/fixtures/code-search.cjs', import.meta.url));

beforeAll(async () => {
  buildDirectory = await mkdtemp(join(tmpdir(), 'sdk-search-worker-build-'));
  await buildWorker(join(buildDirectory, 'entry.mjs'));
});
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'sdk-search-bridge-'));
  workspace = join(directory, 'workspace');
  await mkdir(workspace);
  await writeFile(join(workspace, 'sample.ts'), 'export const sample = true;\n');
});
afterEach(async () => {
  await Promise.all(directSessions.splice(0).map(async session => { session.close(); await session.flush(); }));
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  expect(getCodeSearchDiagnostics()).toEqual({ workers: 0, pending: 0, running: 0 });
  await rm(directory, { recursive: true, force: true });
});
afterAll(async () => { await rm(buildDirectory, { recursive: true, force: true }); });

function options(extra: Partial<Options> = {}): Options {
  return {
    model: 'fixture', apiKey: 'fixture', cwd: workspace,
    env: { HOME: directory, CLAUDE_CONFIG_DIR: directory },
    systemPrompt: 'Fixture.', persistSession: false, tools: ['CodeSearch'], settingSources: [],
    turnEndChecks: { openWork: false, completion: false },
    codeSearch: { backend: 'zvec-grep', nodePath: process.execPath, modulePath: backend,
      workerPath: backend,
      cachePath: join(directory, 'cache'), timeoutMs: 5000, idleTimeoutMs: 5000 },
    ...extra,
  };
}

function runtime(extra = {}) {
  const pool = createWorkerRuntime({ workerUrl: pathToFileURL(join(buildDirectory, 'entry.mjs')),
    warmWorkers: 2, maxWorkers: 2, startupTimeoutMs: 5000, closeTimeoutMs: 5000, ...extra });
  runtimes.push(pool);
  return pool;
}

function searchData(query = 'locate sample') { return { tools: [{ name: 'CodeSearch', input: { query } }] }; }
function session(pool: WorkerRuntime, extra: Partial<Options> = {}, data: Record<string, unknown> = searchData()) {
  return pool.createSession(options(extra), { setup: { ...setup, data } });
}
async function collect(stream: AsyncIterable<SDKMessage>): Promise<SDKMessage[]> {
  const messages: SDKMessage[] = [];
  for await (const message of stream) messages.push(message);
  return messages;
}
async function turn(current: WorkerSession | SDKSession): Promise<SDKMessage[]> {
  await current.send('Find the implementation.');
  return collect(current.stream());
}
function resultText(messages: SDKMessage[]): string {
  for (const message of messages) if (message.type === 'user') {
    for (const block of message.message.content) if (block.type === 'tool_result' && typeof block.content === 'string') return block.content;
  }
  throw new Error('No tool result');
}
async function expectSampleHit(text: string, expectedPath: string): Promise<void> {
  const suffix = ':1-1';
  const location = text.split('\n').find(line => line.endsWith(suffix));
  if (!location) throw new Error(`CodeSearch did not return the fixture location:\n${text}`);
  const actualPath = location.slice(0, -suffix.length);
  const [actual, expected] = await Promise.all([realpath(actualPath), realpath(expectedPath)]);
  expect(actual, `CodeSearch returned ${actualPath}; expected the file at ${expectedPath}`).toBe(expected);
}

function backendDetails(messages: SDKMessage[]): { pid: number; indexes: number } {
  const text = resultText(messages);
  const details = text.split('\n').find(line => line.startsWith('{'));
  if (!details) throw new Error(`CodeSearch did not return fixture details:\n${text}`);
  return JSON.parse(details);
}
async function eventually(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 4000;
  while (!await check()) { if (Date.now() > deadline) throw new Error('Condition timed out'); await delay(10); }
}

describe('host-owned CodeSearch across SDK workers', () => {
  it('launches a backend in a spaced directory through its native absolute path', async () => {
    const scripts = join(directory, 'backend space 测试');
    await mkdir(scripts);
    const workerPath = join(scripts, 'fixture worker.cjs');
    await copyFile(backend, workerPath);
    const configured = options();
    configured.codeSearch = { ...configured.codeSearch!, workerPath: toNamespacedPath(workerPath), modulePath: toNamespacedPath(workerPath) };
    const current = await session(runtime(), configured);
    const messages = await turn(current);
    const details = backendDetails(messages);
    expect(details.indexes).toBe(1);
    expect(details.pid).toBeGreaterThan(0);
    await expectSampleHit(resultText(messages), join(workspace, 'sample.ts'));
  });

  it('runs the generated adapter and returns the real indexed candidate', async () => {
    const modulePath = join(directory, 'strategy fixture.mjs');
    const supervisorPath = join(directory, 'generated adapter loader.cjs');
    await writeFile(supervisorPath, `const c = JSON.parse(process.argv[2]); require(c.workerPath);`);
    await writeFile(modulePath, `
      import { readFile } from 'node:fs/promises';
      import { join } from 'node:path';
      export async function createZvecGrep() {
        let source;
        return {
          async index(options) { source = join(options.rootPaths[0].absolutePath, 'sample.ts'); },
          async context() { return {items: [{file: {absolutePath: source}, range: {kind: 'text', startLine: 1, endLine: 1}, content: (await readFile(source, 'utf8')).trim(), status: 'fresh'}]}; },
          async close() {},
        };
      }
    `);
    const configured = options();
    configured.codeSearch = { ...configured.codeSearch!, workerPath: undefined, modulePath: toNamespacedPath(modulePath), supervisorPath: toNamespacedPath(supervisorPath) };
    const alias = join(directory, 'source-alias');
    await symlink(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const current = await session(runtime(), { ...configured, cwd: alias });
    const text = resultText(await turn(current));
    if (Number(process.versions.node.split('.')[0]) < 22) {
      expect(text).toContain('requires a Node 22 or newer executable');
    } else {
      await expectSampleHit(text, join(alias, 'sample.ts'));
      expect(text).toContain('export const sample = true;');
    }
  });

  it('reports a long backend launch path without rewriting it into a different file', async () => {
    const scripts = join(directory, 'segment'.repeat(18), 'segment'.repeat(19));
    await mkdir(toNamespacedPath(scripts), { recursive: true });
    const workerPath = join(scripts, 'fixture.cjs');
    expect(workerPath.length).toBeGreaterThan(260);
    await copyFile(backend, toNamespacedPath(workerPath));
    const configured = options();
    configured.codeSearch = { ...configured.codeSearch!, workerPath: toNamespacedPath(workerPath), modulePath: toNamespacedPath(workerPath) };
    const current = await session(runtime(), configured);
    const messages = await turn(current);
    if (process.platform === 'win32') {
      expect(resultText(messages)).toContain('cannot be represented as a standard path under 260 UTF-16 code units');
    } else {
      expect(backendDetails(messages).indexes).toBe(1);
      await expectSampleHit(resultText(messages), join(workspace, 'sample.ts'));
    }
  });

  it('starts lazily, shares one backend across separate SDK workers, and releases the last owner', async () => {
    const pool = runtime();
    const first = await session(pool);
    const second = await session(pool);
    expect(first.threadId).not.toBe(second.threadId);
    expect(getCodeSearchDiagnostics().workers).toBe(0);
    await expect(access(join(directory, 'cache'))).rejects.toThrow();
    const a = backendDetails(await turn(first));
    const b = backendDetails(await turn(second));
    expect(a.pid).toBe(b.pid);
    expect(b.indexes).toBe(1);
    expect(getCodeSearchDiagnostics().workers).toBe(1);
    first.close(); await first.flush();
    expect(getCodeSearchDiagnostics().workers).toBe(1);
    second.close(); await second.flush();
    expect(getCodeSearchDiagnostics().workers).toBe(0);
  });

  it('shares the same host backend with an in-process session', async () => {
    const direct = await createSession(await directSetup(options(), searchData()));
    directSessions.push(direct);
    const [search] = searchData().tools;
    const threaded = await session(runtime(), {}, { tools: [search, null, search] });
    const first = backendDetails(await turn(direct));
    const second = backendDetails(await turn(threaded));
    expect(second).toEqual({ pid: first.pid, indexes: 1 });
    expect(getCodeSearchDiagnostics().workers).toBe(1);
    direct.close(); await direct.flush();
    expect(getCodeSearchDiagnostics().workers).toBe(1);
    expect(backendDetails(await turn(threaded))).toEqual(second);
  });

  it('preserves the public search service PATH inside a Node Worker and separates different values', async () => {
    const fixture = join(directory, 'environment-backend.cjs');
    await writeFile(fixture, `
      const { join } = require('node:path');
      const { root } = JSON.parse(process.argv[2]);
      process.on('message', request => {
        if (request.type === 'close') { process.disconnect(); return; }
        const snippet = JSON.stringify({ pid: process.pid,
          pathMatches: process.env.PATH === request.query,
          secretOmitted: process.env.CODE_SEARCH_FIXTURE_SECRET === undefined });
        const hit = { path: join(root, 'sample.ts'), lineStart: 1, lineEnd: 1, snippet, truncated: false };
        process.send({ type: 'result', id: request.id, result: { hits: [hit], freshness: 'fresh', exhaustive: false } });
      });
      process.on('disconnect', () => process.exit(0));
      process.send({ type: 'ready' });
    `);
    const entry = join(directory, 'search-worker.mjs');
    await writeFile(entry, `
      import { parentPort, workerData } from 'node:worker_threads';
      import { createCodeSearchService, getCodeSearchDiagnostics } from ${JSON.stringify(new URL('../../../../dist/index.js', import.meta.url).href)};
      const owners = [];
      const { options, root, key } = workerData;
      const expected = ['fixture-bin-a', 'fixture-bin-b'];
      if (process.env[key] !== expected[0] || (key === 'Path' && process.env.PATH !== undefined)) {
        throw new Error('The Worker does not have the expected PATH spelling');
      }
      const details = [];
      try {
        for (const value of expected) {
          process.env[key] = value;
          const owner = createCodeSearchService(options);
          owners.push(owner);
          const result = await owner.search({ root, query: value });
          details.push(JSON.parse(result.hits[0].snippet));
        }
      } finally {
        await Promise.all(owners.map(owner => owner.dispose()));
      }
      parentPort.postMessage({ details, diagnostics: getCodeSearchDiagnostics() });
    `);
    const key = process.platform === 'win32' ? 'Path' : 'PATH';
    const worker = new Worker(entry, {
      env: {
        ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT } : {}),
        [key]: 'fixture-bin-a', CODE_SEARCH_FIXTURE_SECRET: 'not-forwarded',
      },
      workerData: { options: { ...options().codeSearch, modulePath: fixture, workerPath: fixture }, root: workspace, key },
    });
    try {
      const result = await new Promise<{
        details: { pid: number; pathMatches: boolean; secretOmitted: boolean }[];
        diagnostics: ReturnType<typeof getCodeSearchDiagnostics>;
      }>((resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error', reject);
        worker.once('exit', code => reject(new Error(`Search Worker exited without a result (${code})`)));
      });
      expect(result.details).toEqual([
        { pid: expect.any(Number), pathMatches: true, secretOmitted: true },
        { pid: expect.any(Number), pathMatches: true, secretOmitted: true },
      ]);
      expect(result.details[0].pid).not.toBe(result.details[1].pid);
      expect(result.diagnostics).toEqual({ workers: 0, pending: 0, running: 0 });
    } finally {
      await worker.terminate();
    }
  }, 15000);

  it('runs optional search in direct and worker one-shot queries and releases it on completion', async () => {
    const direct = await collect(query({ prompt: 'Find the implementation.', options: await directSetup(options(), searchData()) }));
    expect(backendDetails(direct).indexes).toBe(1);
    expect(getCodeSearchDiagnostics().workers).toBe(0);
    const threaded = await collect(runtime().query({ prompt: 'Find the implementation.', options: options() },
      { setup: { ...setup, data: searchData() } }));
    expect(backendDetails(threaded).indexes).toBe(1);
    expect(getCodeSearchDiagnostics().workers).toBe(0);
  });

  it('lets a worker collaborator borrow the same host-owned search capability', async () => {
    const captureRequestsFile = join(directory, 'collaborator-search.jsonl');
    const current = await session(runtime(), { tools: ['spawn_agent', 'CodeSearch'], permissionMode: 'bypassPermissions' }, {
      captureRequestsFile,
      tools: [{ name: 'mcp__halo-team__spawn_agent', input: { prompt: 'Locate the sample implementation.' } }],
      collaboratorTools: [{ name: 'CodeSearch', input: { query: 'sample implementation' } }],
    });
    await turn(current);
    const requests = (await readFile(captureRequestsFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.collaborator);
    expect(requests.length).toBeGreaterThan(1);
    expect(JSON.stringify(requests.at(-1).request.messages)).toContain('Ranked code candidates');
    expect(getCodeSearchDiagnostics().workers).toBe(1);
    current.close(); await current.flush();
    expect(getCodeSearchDiagnostics().workers).toBe(0);
  });

  it('retains host read-deny restrictions even if worker setup drops them', async () => {
    const current = await session(runtime(), { disallowedTools: ['Read(secret)'] }, { ...searchData(), clearReadDenials: true });
    const messages = await turn(current);
    expect(resultText(messages)).toContain('read restrictions');
    expect(getCodeSearchDiagnostics().workers).toBe(0);
    await expect(access(join(directory, 'cache'))).rejects.toThrow();
  });

  it('anchors relative host read rules to the original workspace when a request changes root', async () => {
    const nested = join(workspace, 'deep');
    const denied = join(directory, 'secret');
    await mkdir(nested);
    await mkdir(denied);
    await writeFile(join(denied, 'sample.ts'), 'private fixture');
    const search = createSessionCodeSearchService(options({ cwd: nested, disallowedTools: ['Read(../../secret)'] }))!;
    try {
      await expect(search.search({ root: denied, query: 'private', readDenyRoots: [] })).rejects.toThrow('read restrictions');
      expect(getCodeSearchDiagnostics().workers).toBe(0);
    } finally { await search.dispose(); }
  });

  for (const mode of ['query', 'session', 'worker', 'worker-without-search'] as const) {
    it(`protects existing cache files while preserving workspace access through ${mode}`, async () => {
      const cache = join(directory, 'cache');
      await mkdir(cache);
      await writeFile(join(cache, 'snippets.txt'), 'PRIVATE_CACHE_SENTINEL');
      const data = { clearReadDenials: true, removeCodeSearch: mode === 'worker-without-search', tools: [
        { name: 'Read', input: { file_path: join(cache, 'snippets.txt') } },
        { name: 'Grep', input: { path: cache, pattern: 'SENTINEL', output_mode: 'content' } },
        { name: 'Read', input: { file_path: join(workspace, 'sample.ts') } },
      ] };
      const input = options({ tools: mode === 'worker-without-search' ? ['Read', 'Grep', 'CodeSearch'] : ['Read', 'Grep'] });
      let messages: SDKMessage[];
      if (mode === 'query') messages = await collect(query({ prompt: 'Check files.', options: await directSetup(input, data) }));
      else if (mode === 'session') {
        const current = await createSession(await directSetup(input, data));
        directSessions.push(current);
        messages = await turn(current);
      } else messages = await collect(runtime().query({ prompt: 'Check files.', options: input }, { setup: { ...setup, data } }));
      const results = messages.flatMap(message => message.type === 'user' ? message.message.content : [])
        .filter(block => block.type === 'tool_result');
      expect(results).toHaveLength(3);
      expect(results[0]).toMatchObject({ is_error: true, content: expect.stringContaining('denied') });
      expect(results[1]).toMatchObject({ is_error: true, content: expect.stringContaining('denied') });
      expect(results[2]).toMatchObject({ content: expect.stringContaining('export const sample = true') });
      expect(JSON.stringify(messages)).not.toContain('PRIVATE_CACHE_SENTINEL');
      expect(getCodeSearchDiagnostics().workers).toBe(0);
    });
  }

  it('inherits the cache floor in a worker collaborator after setup removes search configuration', async () => {
    const cache = join(directory, 'cache');
    await mkdir(cache);
    await writeFile(join(cache, 'snippets.txt'), 'PRIVATE_CHILD_CACHE_SENTINEL');
    const captureRequestsFile = join(directory, 'collaborator-denial.jsonl');
    const current = await session(runtime(), { tools: ['spawn_agent', 'Read'], permissionMode: 'bypassPermissions' }, {
      removeCodeSearch: true, clearReadDenials: true, captureRequestsFile,
      tools: [{ name: 'mcp__halo-team__spawn_agent', input: { prompt: 'Check the file.' } }],
      collaboratorTools: [{ name: 'Read', input: { file_path: join(cache, 'snippets.txt') } }],
    });
    const messages = await turn(current);
    const requests = (await readFile(captureRequestsFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(entry => entry.collaborator);
    expect(requests.length).toBeGreaterThan(1);
    const result = requests.at(-1).request.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
      .find(block => block.type === 'tool_result');
    expect(result).toMatchObject({ is_error: true, content: expect.stringContaining('denied') });
    expect(JSON.stringify(messages)).not.toContain('PRIVATE_CHILD_CACHE_SENTINEL');
  });

  it('leaves the tool and service absent when disabled or filtered, including worker one-shot queries', async () => {
    const pool = runtime();
    for (const extra of [{ codeSearch: undefined }, { tools: [] }, { disallowedTools: ['CodeSearch'] }]) {
      const messages = await collect(pool.query({ prompt: 'Hello.', options: options(extra) }, { setup }));
      const init = messages.find(message => message.type === 'system' && message.subtype === 'init');
      expect(init && 'tools' in init ? init.tools : []).not.toContain('CodeSearch');
    }
    expect(getCodeSearchDiagnostics().workers).toBe(0);
  });

  it('cancels an active search, settles once, and keeps the SDK worker usable', async () => {
    const current = await session(runtime(), {}, searchData('hang'));
    const pending = turn(current);
    await eventually(async () => { try { await access(join(directory, 'cache', 'query-started')); return true; } catch { return false; } });
    await current.interrupt();
    const messages = await pending;
    expect(messages.filter(message => message.type === 'result')).toHaveLength(1);
    expect(resultText(messages)).toBe('Interrupted by user');
    await eventually(() => getCodeSearchDiagnostics().workers === 0);
    const next = await turn(current);
    expect(next.find(message => message.type === 'result')).toMatchObject({ is_error: false });
  });

  it('releases the host search process after an SDK worker crashes', async () => {
    const current = await session(runtime({ warmWorkers: 1 }));
    await turn(current);
    expect(getCodeSearchDiagnostics().workers).toBe(1);
    await current.setModel('crash-worker');
    await expect(turn(current)).rejects.toThrow();
    await current.flush();
    expect(getCodeSearchDiagnostics().workers).toBe(0);
  });

  it('does not start a search backend on preparation failure or allow worker setup to replace it', async () => {
    const pool = runtime();
    await expect(session(pool, {}, { ...searchData(), failPreparation: true })).rejects.toThrow('Fixture preparation failed');
    await expect(session(pool, { codeSearch: undefined }, { ...searchData(), replaceCodeSearch: options().codeSearch }))
      .rejects.toThrow('configured by the worker host');
    expect(getCodeSearchDiagnostics().workers).toBe(0);
  });
});
