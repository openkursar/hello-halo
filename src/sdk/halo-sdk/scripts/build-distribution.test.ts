import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, renameSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildNativeOnly } from './build-native.mjs';
import {
  createStagingDirectory, distributionState,
  prepareBuildWorkspace, previousPrefix, publishDistribution, stagingPrefix,
} from './build-distribution.mjs';

const directories: string[] = [];
async function put(directory: string, file: string, contents: string | Buffer) {
  const path = join(directory, file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}
async function fixture() {
  const sdk = await mkdtemp(join(tmpdir(), 'sdk-build-distribution-'));
  directories.push(sdk);
  await put(sdk, 'package.json', JSON.stringify({
    name: '@hello-halo/agent-sdk', version: '1.0.0', main: './dist/index.js', types: './dist/index.d.ts',
    exports: {
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      './native': { types: './dist/native/index.d.ts', import: './dist/native/index.js' },
      './collaboration/protocol': { import: './dist/collaboration/protocol.js' },
    },
  }));
  await put(sdk, 'dist/index.js', 'export const value = "old";');
  await put(sdk, 'dist/index.d.ts', 'export declare const value: string;');
  await put(sdk, 'dist/native/index.js', 'export {};');
  await put(sdk, 'dist/native/index.d.ts', 'export {};');
  await put(sdk, 'dist/native/binding.js', 'export {};');
  await put(sdk, 'dist/collaboration/protocol.js', 'export {};');
  await put(sdk, 'dist/worker/entry.js', 'export {};');
  await put(sdk, 'dist/native/runtime.js', 'export const ready = true;');
  await put(sdk, 'dist/worker/THIRD-PARTY-NOTICES.txt', 'Worker notices');
  await put(sdk, 'dist/native/THIRD-PARTY-NOTICES.txt', 'Native notices');
  const runtime = [];
  for (const file of ['index.js', 'native/index.js', 'native/binding.js', 'native/runtime.js', 'collaboration/protocol.js', 'worker/entry.js']) {
    const bytes = await readFile(join(sdk, 'dist', file));
    runtime.push({ path: `dist/${file}`, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const declaration = await readFile(join(sdk, 'dist/index.d.ts'));
  await put(sdk, 'dist/runtime-manifest.json', JSON.stringify({ version: 1, runtime,
    declarations: [{ path: 'dist/index.d.ts', bytes: declaration.length }],
    entryPoints: ['dist/index.js'], assets: ['dist/worker/THIRD-PARTY-NOTICES.txt'] }));
  const artifact = Buffer.from('native fixture');
  const platform = `${process.platform}-${process.arch}`;
  const filename = `halo-sdk.${platform}.node`;
  await put(sdk, `dist/native/${filename}`, artifact);
  await put(sdk, 'dist/native/build-info.json', JSON.stringify({ implementation: 'rust', abiVersion: 1,
    artifacts: [{ platform, filename, sha256: createHash('sha256').update(artifact).digest('hex') }] }));
  return sdk;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('SDK distribution publishing', () => {
  it('accepts a complete distribution and reports every missing runtime input', async () => {
    const sdk = await fixture();
    expect(await distributionState(sdk)).toEqual({ complete: true, missing: [], reason: undefined });
    expect((await distributionState(sdk, { platform: 'win32-x64' })).complete).toBe(false);
    expect((await distributionState(sdk, { platform: null })).complete).toBe(true);
    await rm(join(sdk, 'dist/index.js'));
    const missing = await distributionState(sdk);
    expect(missing.complete).toBe(false);
    expect(missing.missing).toContain('index.js');
    expect(missing.reason).toMatch(/index\.js/);
  });

  it('rejects a distribution whose native artifact no longer matches its manifest', async () => {
    const sdk = await fixture();
    await put(sdk, `dist/native/halo-sdk.${process.platform}-${process.arch}.node`, 'changed');
    const state = await distributionState(sdk);
    expect(state.complete).toBe(false);
    expect(state.reason).toMatch(/checksum/);
  });

  it('requires every compiled package export', async () => {
    const sdk = await fixture();
    await rm(join(sdk, 'dist/collaboration/protocol.js'));
    const state = await distributionState(sdk);
    expect(state.complete).toBe(false);
    expect(state.missing).toContain('collaboration/protocol.js');
  });

  it('rejects missing internal runtime dependencies, declarations and legal assets', async () => {
    for (const file of ['dist/native/runtime.js', 'dist/index.d.ts', 'dist/worker/THIRD-PARTY-NOTICES.txt']) {
      const sdk = await fixture();
      await rm(join(sdk, file));
      expect((await distributionState(sdk)).missing).toContain(file.slice('dist/'.length));
    }
  });

  it('rejects malformed and escaping runtime manifest paths', async () => {
    const sdk = await fixture();
    const file = join(sdk, 'dist/runtime-manifest.json');
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    manifest.assets.push('dist/../../outside');
    await writeFile(file, JSON.stringify(manifest));
    expect((await distributionState(sdk)).reason).toMatch(/leaves the distribution/);
  });

  it('checks and reuses a distribution without installed build dependencies', async () => {
    const sdk = await fixture();
    for (const name of ['build.mjs', 'build-distribution.mjs', 'build-lock.mjs']) {
      await put(sdk, `scripts/${name}`, await readFile(fileURLToPath(new URL(name, import.meta.url))));
    }
    for (const flag of ['--check-distribution', '--if-missing']) {
      const result = spawnSync(process.execPath, ['scripts/build.mjs', flag], { cwd: sdk, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
    }
    await rm(join(sdk, 'dist/native/runtime.js'));
    const result = spawnSync(process.execPath, ['scripts/build.mjs', '--check-distribution'], { cwd: sdk, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('native/runtime.js');
    expect(existsSync(join(sdk, '.build-lock'))).toBe(false);
  });

  it('publishes a complete staging directory and removes the previous one', async () => {
    const sdk = await fixture();
    const staging = await createStagingDirectory(sdk);
    expect(dirname(staging)).toBe(sdk);
    expect(basename(staging).startsWith(stagingPrefix)).toBe(true);
    await cp(join(sdk, 'dist'), staging, { recursive: true });
    await put(staging, 'index.js', 'export const value = "new";');
    await publishDistribution(sdk, staging);
    expect(await readFile(join(sdk, 'dist/index.js'), 'utf8')).toContain('new');
    expect(existsSync(staging)).toBe(false);
    expect((await readdir(sdk)).filter(name => name.startsWith(previousPrefix))).toEqual([]);
  });

  it('keeps the previous distribution when staging is incomplete', async () => {
    const sdk = await fixture();
    const staging = await createStagingDirectory(sdk);
    await cp(join(sdk, 'dist'), staging, { recursive: true });
    await rm(join(staging, 'index.js'));
    await expect(publishDistribution(sdk, staging)).rejects.toThrow(/incomplete/);
    expect(await readFile(join(sdk, 'dist/index.js'), 'utf8')).toContain('old');
  });

  it('restores the previous distribution when the final rename fails', async () => {
    const sdk = await fixture();
    const staging = await createStagingDirectory(sdk);
    await cp(join(sdk, 'dist'), staging, { recursive: true });
    await put(staging, 'index.js', 'export const value = "new";');
    let calls = 0;
    const rename = (from: string, to: string) => {
      calls += 1;
      if (calls === 2) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return renameSync(from, to);
    };
    await expect(publishDistribution(sdk, staging, { rename })).rejects.toThrow(/Publishing .* failed/);
    expect(await readFile(join(sdk, 'dist/index.js'), 'utf8')).toContain('old');
  });

  it('recovers a distribution interrupted between the two renames', async () => {
    const sdk = await fixture();
    await rename(join(sdk, 'dist'), join(sdk, `${previousPrefix}interrupted`));
    await mkdir(join(sdk, `${stagingPrefix}abandoned`));
    await prepareBuildWorkspace(sdk);
    expect(await readFile(join(sdk, 'dist/index.js'), 'utf8')).toContain('old');
    expect(existsSync(join(sdk, `${stagingPrefix}abandoned`))).toBe(false);
    expect(existsSync(join(sdk, `${previousPrefix}interrupted`))).toBe(false);
  });
});

describe('native-only SDK builds', () => {
  async function compile({ outputDirectory }: { outputDirectory: string }) {
    const filename = `halo-sdk.${process.platform}-${process.arch}.node`;
    const bytes = Buffer.from('rebuilt native fixture');
    await put(outputDirectory, filename, bytes);
    await put(outputDirectory, 'THIRD-PARTY-NOTICES.txt', 'Rebuilt notices');
    await put(outputDirectory, 'build-info.json', JSON.stringify({ implementation: 'rust', abiVersion: 1,
      artifacts: [{ platform: `${process.platform}-${process.arch}`, filename, sha256: createHash('sha256').update(bytes).digest('hex') }] }));
  }

  it('builds native inputs without requiring a compiled JavaScript distribution', async () => {
    const sdk = await fixture();
    await rm(join(sdk, 'dist'), { recursive: true });
    await buildNativeOnly({ sdkDirectory: sdk, compile });
    expect(await readFile(join(sdk, `dist/native/halo-sdk.${process.platform}-${process.arch}.node`), 'utf8')).toBe('rebuilt native fixture');
    expect(existsSync(join(sdk, 'dist/index.js'))).toBe(false);
    expect((await distributionState(sdk)).complete).toBe(false);
  });

  it('preserves JavaScript and refreshes native assets in an existing runtime manifest', async () => {
    const sdk = await fixture();
    const previous = await readFile(join(sdk, 'dist/index.js'));
    await buildNativeOnly({ sdkDirectory: sdk, compile });
    expect(await readFile(join(sdk, 'dist/index.js'))).toEqual(previous);
    expect((await distributionState(sdk)).complete).toBe(true);
    const manifest = JSON.parse(await readFile(join(sdk, 'dist/runtime-manifest.json'), 'utf8'));
    expect(manifest.assets).toContain(`dist/native/halo-sdk.${process.platform}-${process.arch}.node`);
  });

  it('keeps the distribution unchanged when compilation finishes with an invalid native artifact', async () => {
    const sdk = await fixture();
    const previous = await readFile(join(sdk, 'dist/native/build-info.json'));
    await expect(buildNativeOnly({ sdkDirectory: sdk, compile: async ({ outputDirectory }: { outputDirectory: string }) => {
      await compile({ outputDirectory });
      await put(outputDirectory, `halo-sdk.${process.platform}-${process.arch}.node`, 'invalid');
    } })).rejects.toThrow(/checksum/);
    expect(await readFile(join(sdk, 'dist/native/build-info.json'))).toEqual(previous);
    expect((await distributionState(sdk)).complete).toBe(true);
  });

  it('keeps the distribution unchanged when native compilation fails', async () => {
    const sdk = await fixture();
    const previous = await readFile(join(sdk, 'dist/native/build-info.json'));
    await expect(buildNativeOnly({ sdkDirectory: sdk, compile: async () => { throw new Error('compile failed'); } })).rejects.toThrow('compile failed');
    expect(await readFile(join(sdk, 'dist/native/build-info.json'))).toEqual(previous);
    expect((await readdir(sdk)).some(name => name.startsWith(stagingPrefix))).toBe(false);
  });
});
