import { afterEach, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { analyzeRuntime, pruneRuntime } from './prune-runtime.mjs';

const directories: string[] = [];
async function put(directory: string, file: string, text: string | Buffer) {
  await mkdir(dirname(join(directory, file)), { recursive: true });
  await writeFile(join(directory, file), text);
}
async function fixture(entry = "export { value } from './live.js';") {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'sdk-runtime-closure-')));
  directories.push(directory);
  await put(directory, 'package.json', JSON.stringify({ type: 'module', main: './dist/index.js',
    exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      './collaboration/protocol': { import: './dist/collaboration/protocol.js' } } }));
  await put(directory, 'dist/index.js', entry);
  await put(directory, 'dist/live.js', 'export const value = 42;');
  await put(directory, 'dist/retired.js', 'export const oldLoop = true;');
  await put(directory, 'dist/retired.js.map', '{"version":3,"sources":[],"mappings":""}');
  await put(directory, 'dist/retired.d.ts', 'export declare const oldLoop: boolean;');
  await put(directory, 'dist/retired.d.ts.map', '{"version":3,"sources":[],"mappings":""}');
  await put(directory, 'dist/index.d.ts', "export { oldLoop } from './retired.js';");
  await put(directory, 'dist/collaboration/protocol.js', 'export const version = 1;');
  await put(directory, 'worker/entry.ts', 'export const ready = true;');
  await build({ entryPoints: [join(directory, 'worker/entry.ts')], outfile: join(directory, 'dist/worker/entry.js'),
    bundle: true, platform: 'node', format: 'esm', sourcemap: true });
  const artifact = Buffer.from('synthetic native artifact');
  const filename = `halo-sdk.${process.platform}-${process.arch}.node`;
  await put(directory, `dist/native/${filename}`, artifact);
  await put(directory, 'dist/native/build-info.json', JSON.stringify({ implementation: 'rust', abiVersion: 1,
    artifacts: [{ filename, sha256: createHash('sha256').update(artifact).digest('hex') }] }));
  await put(directory, 'dist/native/THIRD-PARTY-NOTICES.txt', 'Native fixture notices');
  await put(directory, 'dist/worker/THIRD-PARTY-NOTICES.txt', 'Worker fixture notices');
  await put(directory, 'dist/unused-resource.json', '{"retained":true}');
  return directory;
}
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe('distributed SDK runtime closure', () => {
  it('removes retired JavaScript and its map while preserving declarations, worker and native assets', async () => {
    const directory = await fixture();
    const declaration = await readFile(join(directory, 'dist/retired.d.ts'));
    const report = await pruneRuntime(directory);
    expect(report.removed.map((file: { path: string }) => file.path)).toEqual(['dist/retired.js', 'dist/retired.js.map']);
    await expect(access(join(directory, 'dist/retired.js'))).rejects.toThrow();
    expect(await readFile(join(directory, 'dist/retired.d.ts'))).toEqual(declaration);
    for (const file of ['dist/retired.d.ts.map', 'dist/worker/entry.js', 'dist/worker/entry.js.map',
      'dist/native/build-info.json', `dist/native/halo-sdk.${process.platform}-${process.arch}.node`, 'dist/unused-resource.json']) {
      await expect(access(join(directory, file))).resolves.toBeUndefined();
    }
    expect((await analyzeRuntime(directory)).removed).toEqual([]);
  });

  it('adds statically named createRequire dependencies to the runtime roots', async () => {
    const directory = await fixture("import { createRequire } from 'node:module'; const localRequire = createRequire(import.meta.url); export const value = localRequire('./kept.cjs');");
    await put(directory, 'dist/kept.cjs', 'module.exports = 42;');
    const report = await pruneRuntime(directory);
    expect(report.runtime.map((file: { path: string }) => file.path)).toContain('dist/kept.cjs');
    await expect(access(join(directory, 'dist/kept.cjs'))).resolves.toBeUndefined();
  });

  it.each(['export const load = name => import(name);', 'export const load = name => require(name);'])('refuses unknown dynamic dependencies before deleting any output', async entry => {
    const directory = await fixture(entry);
    await expect(pruneRuntime(directory)).rejects.toThrow('Unclassified dynamic runtime dependency');
    await expect(access(join(directory, 'dist/retired.js'))).resolves.toBeUndefined();
  });

  it('refuses a source-only loader whose production guard was removed', async () => {
    const directory = await fixture("export { nativeBinaryPath } from './native/binding.js';");
    await put(directory, 'dist/native/binding.js', "import { createRequire } from 'node:module'; import { join } from 'node:path'; export function nativeBinaryPath() { const directory = '.'; return createRequire(import.meta.url)(join(directory, 'source-identity.cjs')); }");
    await expect(pruneRuntime(directory)).rejects.toThrow('Unclassified dynamic runtime dependency');
    await expect(access(join(directory, 'dist/retired.js'))).resolves.toBeUndefined();
  });

  it('recognizes guarded host setup imports in the original Worker source despite bundle renaming', async () => {
    const directory = await fixture();
    await put(directory, 'worker/entry.ts', `
      export async function create(value: { setup: { module: string } }) {
        if (new URL(value.setup.module).protocol !== 'file:') throw new TypeError('A local setup is required');
        return await import(value.setup!.module);
      }
    `);
    await build({ entryPoints: [join(directory, 'worker/entry.ts')], outfile: join(directory, 'dist/worker/entry.js'),
      bundle: true, platform: 'node', format: 'esm', sourcemap: true, minifyIdentifiers: true });
    const report = await analyzeRuntime(directory);
    expect(report.dynamic).toContainEqual(expect.objectContaining({ file: 'worker/entry.ts', kind: 'import', expression: 'value.setup.module' }));
  });

  it('requires the absolute file guard for host setup imports', async () => {
    const directory = await fixture("export { NativeRuntime } from './native/runtime.js';");
    await put(directory, 'dist/native/runtime.js', 'export class NativeRuntime { async prepare(setup) { return await import(setup.module); } }');
    await expect(pruneRuntime(directory)).rejects.toThrow('Unclassified dynamic runtime dependency');
    await expect(access(join(directory, 'dist/retired.js'))).resolves.toBeUndefined();
  });

  it('rejects Node dependencies in the browser protocol before deleting output', async () => {
    const directory = await fixture();
    await put(directory, 'dist/collaboration/protocol.js', "import fs from 'node:fs'; export const read = fs.readFileSync;");
    await expect(pruneRuntime(directory)).rejects.toThrow();
    await expect(access(join(directory, 'dist/retired.js'))).resolves.toBeUndefined();
  });

  it('requires an explicit contract before publishing wildcard runtime targets', async () => {
    const directory = await fixture();
    const path = join(directory, 'package.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest.exports['./all/*'] = './dist/*';
    await writeFile(path, JSON.stringify(manifest));
    await expect(pruneRuntime(directory)).rejects.toThrow('explicit closure contract');
  });
});
