import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { readFileSnapshot, withFileLock, writeFileSnapshot } from './file-access.js';

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
}));

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sdk-file-access-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('file operation serialization', () => {
  it('serializes aliases of one path but not unrelated files', async () => {
    const target = path.join(tmpDir, 'target');
    const alias = path.join(tmpDir, 'alias');
    await fs.mkdir(target);
    await fs.symlink(target, alias, 'junction');
    const entered = deferred();
    const release = deferred();
    const calls: string[] = [];
    const first = withFileLock(path.join(target, 'new.txt'), async () => {
      calls.push('first');
      entered.resolve();
      await release.promise;
      calls.push('released');
    });
    await entered.promise;
    const second = withFileLock(path.join(alias, 'new.txt'), async () => { calls.push('second'); });
    await withFileLock(path.join(tmpDir, 'other.txt'), async () => { calls.push('unrelated'); });
    expect(calls).toEqual(['first', 'unrelated']);
    release.resolve();
    await Promise.all([first, second]);
    expect(calls).toEqual(['first', 'unrelated', 'released', 'second']);
  });

  it('releases queued operations after a failure', async () => {
    const filePath = path.join(tmpDir, 'file.txt');
    const failed = withFileLock(filePath, async () => { throw new Error('expected failure'); });
    const next = withFileLock(filePath, async () => 'completed');
    await expect(failed).rejects.toThrow('expected failure');
    await expect(next).resolves.toBe('completed');
    await expect(withFileLock(filePath, async () => 'reused')).resolves.toBe('reused');
  });
});

describe('snapshot-checked writes', () => {
  it('accepts metadata-only copy-up when opening the write handle', async () => {
    const filePath = path.join(tmpDir, 'copy-up.txt');
    await fs.writeFile(filePath, 'original', { mode: 0o640 });
    const snapshot = await readFileSnapshot(filePath);
    const open = fs.open;
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      const handle = await open(...args);
      await handle.chmod(0o600);
      return handle;
    });
    await writeFileSnapshot(filePath, Buffer.from('updated'), snapshot);
    expect(await fs.readFile(filePath, 'utf-8')).toBe('updated');
  });

  it('rejects changed bytes even when only ctime reveals the change', async () => {
    const filePath = path.join(tmpDir, 'changed.txt');
    await fs.writeFile(filePath, 'original');
    const stamp = new Date('2024-01-01T00:00:00.000Z');
    await fs.utimes(filePath, stamp, stamp);
    const snapshot = await readFileSnapshot(filePath);
    const open = fs.open;
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      const handle = await open(...args);
      await fs.writeFile(filePath, 'external');
      await fs.utimes(filePath, stamp, stamp);
      return handle;
    });
    await expect(writeFileSnapshot(filePath, Buffer.from('updated'), snapshot))
      .rejects.toThrow('no longer matches its recorded read');
    expect(await fs.readFile(filePath, 'utf-8')).toBe('external');
  });

  it('refuses a read snapshot if the file changes while bytes are being read', async () => {
    const filePath = path.join(tmpDir, 'during-read.txt');
    await fs.writeFile(filePath, 'original');
    const open = fs.open;
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      const handle = await open(...args);
      const read = handle.read.bind(handle);
      vi.spyOn(handle, 'read').mockImplementationOnce(async (...readArgs: any[]) => {
        const bytes = await (read as any)(...readArgs);
        await fs.writeFile(filePath, 'modified during read');
        return bytes;
      });
      return handle;
    });
    await expect(readFileSnapshot(filePath)).rejects.toThrow(/no longer matches its recorded read|grew while being read/);
    expect(await fs.readFile(filePath, 'utf-8')).toBe('modified during read');
  });

  it('refuses changes made after the initial snapshot', async () => {
    const filePath = path.join(tmpDir, 'file.txt');
    await fs.writeFile(filePath, 'original');
    const snapshot = await readFileSnapshot(filePath);
    await fs.writeFile(filePath, 'external');
    await fs.utimes(filePath, snapshot.stat.atime, snapshot.stat.mtime);
    await expect(writeFileSnapshot(filePath, Buffer.from('overwrite'), snapshot)).rejects.toThrow('no longer matches its recorded read');
    expect(await fs.readFile(filePath, 'utf-8')).toBe('external');
  });

  it('refuses inode replacement even when size and mtime match', async () => {
    const filePath = path.join(tmpDir, 'file.txt');
    const replacement = path.join(tmpDir, 'replacement.txt');
    const stamp = new Date('2024-01-01T00:00:00.000Z');
    await fs.writeFile(filePath, 'original');
    await fs.utimes(filePath, stamp, stamp);
    const snapshot = await readFileSnapshot(filePath);
    await fs.writeFile(replacement, 'external');
    await fs.utimes(replacement, stamp, stamp);
    await fs.rename(replacement, filePath);
    await expect(writeFileSnapshot(filePath, Buffer.from('overwrite'), snapshot)).rejects.toThrow('no longer matches its recorded read');
    expect(await fs.readFile(filePath, 'utf-8')).toBe('external');
  });

  it('never overwrites a concurrent creator', async () => {
    const filePath = path.join(tmpDir, 'new.txt');
    await fs.writeFile(filePath, 'created elsewhere');
    await expect(writeFileSnapshot(filePath, Buffer.from('overwrite'))).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await fs.readFile(filePath, 'utf-8')).toBe('created elsewhere');
  });

  it('preserves the inode and permissions while shortening the file', async () => {
    const filePath = path.join(tmpDir, 'file.txt');
    await fs.writeFile(filePath, 'long original content', { mode: 0o640 });
    const snapshot = await readFileSnapshot(filePath);
    const stat = await writeFileSnapshot(filePath, Buffer.from('short'), snapshot);
    expect(stat.ino).toBe(snapshot.stat.ino);
    expect(stat.mode).toBe(snapshot.stat.mode);
    expect(await fs.readFile(filePath, 'utf-8')).toBe('short');
  });
});
