import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireBuildLock, buildLockPath } from './build-lock.mjs';

const directories: string[] = [];
async function fixture() {
  const sdk = await mkdtemp(join(tmpdir(), 'sdk-build-lock-'));
  directories.push(sdk);
  return sdk;
}

async function owner(sdk: string, pid: number, token = '00000000-0000-0000-0000-000000000000') {
  const directory = join(buildLockPath(sdk), 'held');
  await mkdir(directory, { recursive: true });
  await mkdir(join(buildLockPath(sdk), 'format-1'), { recursive: true });
  await writeFile(join(directory, `owner-${token}.json`), JSON.stringify({ pid }));
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('SDK build lock', () => {
  it('releases only its owner and keeps the shared container', async () => {
    const sdk = await fixture();
    const lock = await acquireBuildLock(sdk);
    expect(existsSync(join(buildLockPath(sdk), 'held'))).toBe(true);
    await lock.release();
    const next = await acquireBuildLock(sdk);
    await lock.release();
    expect((await readdir(join(buildLockPath(sdk), 'held'))).length).toBe(1);
    await next.release();
    expect(await readdir(buildLockPath(sdk))).toEqual(['format-1']);
  });

  it('reclaims an exited owner without leaving an owned directory', async () => {
    const sdk = await fixture();
    await owner(sdk, 2_147_483_647);
    const lock = await acquireBuildLock(sdk, { timeoutMs: 200, pollMs: 1 });
    await lock.release();
    expect(await readdir(buildLockPath(sdk))).toEqual(['format-1']);
  });

  it('waits for a live owner and reports its identity', async () => {
    const sdk = await fixture();
    await owner(sdk, process.pid);
    await expect(acquireBuildLock(sdk, { timeoutMs: 20, pollMs: 1 })).rejects.toThrow(new RegExp(`process ${process.pid}`));
    expect((await readdir(buildLockPath(sdk))).sort()).toEqual(['format-1', 'held']);
  });

  it('leaves legacy and malformed owners for inspection rather than deleting them', async () => {
    const sdk = await fixture();
    await mkdir(buildLockPath(sdk));
    const legacy = join(buildLockPath(sdk), 'owner.json');
    await writeFile(legacy, JSON.stringify({ pid: 2_147_483_647 }));
    await expect(acquireBuildLock(sdk, { timeoutMs: 20, pollMs: 1 })).rejects.toThrow(/Legacy SDK build lock/);
    expect(JSON.parse(await readFile(legacy, 'utf8')).pid).toBe(2_147_483_647);
    await rm(legacy);
    await owner(sdk, process.pid);
    const held = join(buildLockPath(sdk), 'held');
    const file = join(held, (await readdir(held))[0]);
    await writeFile(file, '{invalid');
    await expect(acquireBuildLock(sdk, { timeoutMs: 20, pollMs: 1 })).rejects.toThrow(/owner/);
    expect(await readFile(file, 'utf8')).toBe('{invalid');
  });

  it('does not mistake an uninitialized legacy root for an available lock', async () => {
    const sdk = await fixture();
    await mkdir(buildLockPath(sdk));
    await expect(acquireBuildLock(sdk, { timeoutMs: 20, pollMs: 1 })).rejects.toThrow(/interrupted initialization/);
    expect(await readdir(buildLockPath(sdk))).toEqual([]);
  });

  it('recovers an empty held directory without removing an unpublished candidate', async () => {
    const sdk = await fixture();
    await mkdir(join(buildLockPath(sdk), 'held'), { recursive: true });
    await mkdir(join(buildLockPath(sdk), 'format-1'));
    const candidate = join(buildLockPath(sdk), 'candidate-unfinished');
    await mkdir(candidate);
    const lock = await acquireBuildLock(sdk, { timeoutMs: 200, pollMs: 1 });
    await lock.release();
    expect(existsSync(candidate)).toBe(true);
    expect((await readdir(buildLockPath(sdk))).sort()).toEqual(['candidate-unfinished', 'format-1']);
  });

  it.each(['fresh', 'exited'])('serializes independent processes with a %s lock', async state => {
    const sdk = await fixture();
    if (state === 'exited') await owner(sdk, 2_147_483_647);
    const module = new URL('./build-lock.mjs', import.meta.url).href;
    const code = `
      import { acquireBuildLock } from ${JSON.stringify(module)};
      import { mkdir, rm } from 'node:fs/promises';
      import { join } from 'node:path';
      process.once('message', async () => {
        try {
          const lock = await acquireBuildLock(process.argv[1], { timeoutMs: 10000, pollMs: 1 });
          const critical = join(process.argv[1], 'critical');
          await mkdir(critical);
          await new Promise(resolve => setTimeout(resolve, 20));
          await rm(critical, { recursive: true });
          await lock.release();
          process.exit(0);
        } catch (error) { console.error(error); process.exit(1); }
      });
      process.send('ready');
    `;
    const children = Array.from({ length: 12 }, () => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code, sdk], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      let stderr = '';
      child.stderr!.on('data', bytes => { stderr += bytes; });
      const ready = new Promise<void>((resolve, reject) => {
        child.once('message', () => resolve());
        child.once('error', reject);
        child.once('exit', code => { if (code !== 0) reject(new Error(stderr || `Child exited ${code}`)); });
      });
      const done = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
      return { child, ready, done, diagnostics: () => stderr };
    });
    try {
      await Promise.all(children.map(child => child.ready));
      children.forEach(({ child }) => child.send('start'));
      const codes = await Promise.all(children.map(child => child.done));
      expect(codes, children.map(child => child.diagnostics()).join('\n')).toEqual(Array(12).fill(0));
      expect(await readdir(buildLockPath(sdk))).toEqual(['format-1']);
    } finally {
      children.forEach(({ child }) => { if (child.exitCode === null) child.kill(); });
      await Promise.all(children.map(child => child.done));
    }
  });
});
