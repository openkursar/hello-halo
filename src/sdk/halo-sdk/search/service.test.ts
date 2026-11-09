import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, access, symlink, realpath, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createCodeSearchService, getCodeSearchDiagnostics } from './index.js';
import type { CodeSearchOptions, CodeSearchService } from './index.js';

let directory: string;
let root: string;
let options: CodeSearchOptions;
let workerPath: string;
let supervisorPath: string;
const services: CodeSearchService[] = [];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'halo-code-search-tests-'));
  workerPath = join(directory, 'worker.mjs');
  await build({ entryPoints: [fileURLToPath(new URL('./worker.ts', import.meta.url))], outfile: workerPath, bundle: true, platform: 'node', format: 'esm', target: 'node20' });
  supervisorPath = join(directory, 'supervisor.mjs');
  await build({ entryPoints: [fileURLToPath(new URL('./supervisor.ts', import.meta.url))], outfile: supervisorPath, bundle: true, platform: 'node', format: 'esm', target: 'node20' });
});
beforeEach(async () => {
  const testDirectory = await mkdtemp(join(directory, 'case-'));
  root = join(testDirectory, 'source');
  await mkdir(root);
  await writeFile(join(root, 'auth.ts'), 'export const valid = true;\n');
  await writeFile(join(testDirectory, 'outside.ts'), 'private outside fixture');
  const modulePath = join(testDirectory, 'backend.mjs');
  await writeFile(modulePath, `
    import { join } from 'node:path';
    import { writeFile } from 'node:fs/promises';
    let indexes = 0;
    export async function createZvecGrep(options) {
      let root;
      return {
        async index(config) {
          if (config.follow !== false || config.rootPaths[0].follow !== false) throw new Error('unsafe follow');
          root = config.rootPaths[0].absolutePath;
          indexes++;
        },
        async context({query}) {
          if (query === 'hang') { await writeFile(join(root, 'hang-started'), ''); await new Promise(() => {}); }
          if (query === 'slow') await new Promise(resolve => setTimeout(resolve, 70));
          if (query === 'crash') process.exit(9);
          if (query === 'invalid') return {items:null};
          const file = query === 'outside' ? join(root,'..','outside.ts') : join(root, query === 'symlink' ? 'alias.ts' : 'auth.ts');
          return {items:[{file:{absolutePath:file},range:{kind:'text',startLine:1,endLine:1},status:'fresh',
            content: JSON.stringify({pid:process.pid,indexes,query,embedding:options.embedding,secret:process.env.OPENAI_API_KEY ?? null,electron:process.env.ELECTRON_RUN_AS_NODE ?? null})}]};
        },
        async close() { await new Promise(resolve => setTimeout(resolve,60)); }
      };
    }
  `);
  options = { backend: 'zvec-grep', nodePath: process.execPath, modulePath, cachePath: join(testDirectory, 'cache'), workerPath, supervisorPath, timeoutMs: 3000, idleTimeoutMs: 1000 };
});
afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.dispose()));
  vi.unstubAllEnvs();
  expect(getCodeSearchDiagnostics()).toEqual({workers:0,pending:0,running:0});
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
function service(extra: Partial<CodeSearchOptions> = {}) {
  const instance = createCodeSearchService({ ...options, ...extra });
  services.push(instance);
  return instance;
}
function details(result: Awaited<ReturnType<CodeSearchService['search']>>) { return JSON.parse(result.hits[0].snippet); }
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('optional code search service', () => {
  it('does no work until search and rejects overlapping read restrictions before indexing', async () => {
    const search = service();
    expect(getCodeSearchDiagnostics().workers).toBe(0);
    await expect(access(options.cachePath)).rejects.toThrow();
    await expect(search.search({root, query:'auth', readDenyRoots:[join(root,'secret')]})).rejects.toThrow(/read restrictions/);
    await expect(search.search({root, query:'auth', readDenyRoots:[directory]})).rejects.toThrow(/read restrictions/);
    expect(getCodeSearchDiagnostics().workers).toBe(0);
    await expect(access(options.cachePath)).rejects.toThrow();
  });

  it('resolves deny aliases and allows unrelated restrictions', async () => {
    const search = service();
    const alias = join(root, '..', 'root-alias');
    await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(search.search({root, query:'auth', readDenyRoots:[alias]})).rejects.toThrow(/read restrictions/);
    const result = await search.search({root, query:'auth', readDenyRoots:[join(directory,'unrelated')]});
    expect(result.hits[0].path).toBe(await realpath(join(root,'auth.ts')));
    expect(result.exhaustive).toBe(false);
  });

  it('shares a worker and index between services and releases after the last owner', async () => {
    const first = service(); const second = service();
    const a = await first.search({root,query:'first'});
    const b = await second.search({root,query:'second'});
    expect(details(a).pid).toBe(details(b).pid);
    expect(details(b).indexes).toBe(1);
    expect(a.freshness).toBe('fresh'); expect(b.freshness).toBe('possibly_stale');
    await first.dispose();
    expect(getCodeSearchDiagnostics().workers).toBe(1);
    const c = await second.search({root,query:'third',refresh:true});
    expect(details(c).indexes).toBe(2); expect(c.freshness).toBe('fresh');
    await second.dispose();
    expect(getCodeSearchDiagnostics().workers).toBe(0);
  });

  it('serializes concurrent work without duplicating the initial index', async () => {
    const search = service();
    const results = await Promise.all([search.search({root,query:'slow'}),search.search({root,query:'next'})]);
    expect(details(results[0]).pid).toBe(details(results[1]).pid);
    expect(details(results[1]).indexes).toBe(1);
  });

  it('terminates active inference on cancellation and can restart', async () => {
    const search = service();
    const before = details(await search.search({root,query:'ready'}));
    const controller = new AbortController();
    const pending = search.search({root,query:'hang',signal:controller.signal});
    const rejected = expect(pending).rejects.toThrow(/cancelled/);
    await pause(30); controller.abort(); await rejected;
    const after = details(await search.search({root,query:'restart'}));
    expect(after.pid).not.toBe(before.pid);
  });

  it('cancels a queued request without killing another caller', async () => {
    const search = service();
    const before = details(await search.search({root,query:'ready'}));
    const running = search.search({root,query:'slow'});
    for (let i = 0; i < 100 && !getCodeSearchDiagnostics().running; i++) await pause(1);
    expect(getCodeSearchDiagnostics().running).toBe(1);
    const controller = new AbortController();
    const queued = search.search({root,query:'never-run',signal:controller.signal});
    const rejected = expect(queued).rejects.toThrow(/cancelled/);
    for (let i = 0; i < 100 && getCodeSearchDiagnostics().pending < 2; i++) await pause(1);
    expect(getCodeSearchDiagnostics().pending).toBe(2);
    controller.abort(); await rejected;
    expect(details(await running).pid).toBe(before.pid);
  });

  it('stops a timed-out backend and reports the timeout', async () => {
    await service().search({root,query:'ready'});
    const search = service({timeoutMs:100});
    await expect(search.search({root,query:'hang'})).rejects.toThrow(/time limit/);
  });

  it('checks candidate real paths again before releasing snippets', async () => {
    const search = service();
    await expect(search.search({root,query:'outside'})).rejects.toThrow(/outside the permitted/);
    if (process.platform !== 'win32') {
      await symlink(join(root,'..','outside.ts'),join(root,'alias.ts'));
      await expect(search.search({root,query:'symlink'})).rejects.toThrow(/outside the permitted/);
    }
  });

  it('does not pass provider credentials or remote model overrides to the child', async () => {
    vi.stubEnv('OPENAI_API_KEY','not-for-search');
    vi.stubEnv('ZVEC_GREP_EMBEDDING','qwen/remote');
    const result = details(await service().search({root,query:'environment'}));
    expect(result.secret).toBeNull();
    expect(result.embedding).toBe('local/potion-code-16m-v2');
  });

  it('releases idle workers and rejects calls after disposal', async () => {
    const search = service({idleTimeoutMs:20});
    await search.search({root,query:'first'});
    await vi.waitFor(() => expect(getCodeSearchDiagnostics().workers).toBe(0), { timeout: 2000, interval: 10 });
    await search.dispose();
    await expect(search.search({root,query:'after'})).rejects.toThrow(/cancelled/);
  });

  it('bounds native workers while another workspace is busy', async () => {
    const search = service();
    await search.search({root,query:'ready'});
    const controller = new AbortController();
    const pending = search.search({root,query:'hang',signal:controller.signal});
    const rejected = expect(pending).rejects.toThrow(/cancelled/);
    for (let i = 0; i < 100 && !getCodeSearchDiagnostics().running; i++) await pause(1);
    const other = join(root,'..','other-source');
    await mkdir(other);
    await expect(search.search({root:other,query:'another workspace'})).rejects.toThrow(/workers are busy/);
    expect(getCodeSearchDiagnostics().workers).toBe(1);
    controller.abort(); await rejected;
  });

  it('restarts after a failed module import so a repaired installation can be retried', async () => {
    const original = await readFile(options.modulePath,'utf8');
    await writeFile(options.modulePath, 'throw new Error("fixture dependency unavailable");');
    const search = service();
    await expect(search.search({root,query:'first'})).rejects.toThrow(/fixture dependency unavailable/);
    expect(getCodeSearchDiagnostics().workers).toBe(0);
    await writeFile(options.modulePath, original);
    expect((await search.search({root,query:'repaired'})).hits).toHaveLength(1);
  });

  it('reserves capacity atomically when concurrent roots replace an idle worker', async () => {
    const search = service();
    await search.search({root,query:'warm'});
    await vi.waitFor(() => expect(getCodeSearchDiagnostics().pending).toBe(0));
    const roots = [join(root,'..','b'), join(root,'..','c')];
    for (const target of roots) { await mkdir(target); await writeFile(join(target,'auth.ts'),'fixture'); }
    const results = await Promise.allSettled(roots.map(target => search.search({root:target,query:'slow'})));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(failure.reason.message).toMatch(/workers are busy/);
    expect(failure.reason.message).not.toMatch(/released/);
  });

  it('removes cancelled queued jobs immediately instead of retaining a full promise chain', async () => {
    const search = service();
    await search.search({root,query:'warm'});
    const active = new AbortController();
    const running = search.search({root,query:'hang',signal:active.signal}).catch(error => error);
    await vi.waitFor(async () => { await expect(access(join(root,'hang-started'))).resolves.toBeUndefined(); });
    const controllers = Array.from({length:31}, () => new AbortController());
    const waiting = controllers.map(controller => search.search({root,query:'queued',signal:controller.signal}).catch(error => error));
    await vi.waitFor(() => expect(getCodeSearchDiagnostics().pending).toBe(32));
    controllers.forEach(controller => controller.abort());
    const errors = await Promise.all(waiting);
    expect(errors.every(error => error instanceof Error && /cancelled/.test(error.message))).toBe(true);
    expect(getCodeSearchDiagnostics().pending).toBe(1);
    const replacement = search.search({root,query:'replacement'});
    await vi.waitFor(() => expect(getCodeSearchDiagnostics().pending).toBe(2));
    active.abort(); await running;
    expect((await replacement).hits).toHaveLength(1);
  });

  it('shares equivalent configuration regardless of property order or unknown fields', async () => {
    const first = service();
    const reordered = Object.fromEntries(Object.entries(options).reverse()) as unknown as CodeSearchOptions;
    const second = createCodeSearchService({...reordered, ignoredSecret:'not-a-backend-setting'} as CodeSearchOptions);
    services.push(second);
    const a = details(await first.search({root,query:'first'}));
    const b = details(await second.search({root,query:'second'}));
    expect(a.pid).toBe(b.pid);
  });

  it('reports malformed results and native process exits', async () => {
    const search = service();
    await expect(search.search({root,query:'invalid'})).rejects.toThrow(/invalid candidate list/);
    await expect(search.search({root,query:'crash'})).rejects.toThrow(/worker exited/);
  });
});
