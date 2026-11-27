/**
 * @module tools/file-access
 * In-process file serialization and snapshots used by Read, Write, and Edit.
 * @license MIT
 */

import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { realPath } from '../utils/read-deny.js';
import { readBounded } from '../utils/bounded-read.js';

export const MAX_FILE_BYTES = 8 * 1024 * 1024;

export function assertFileSize(size: number): void {
  if (size > MAX_FILE_BYTES) throw new Error(`File exceeds the ${MAX_FILE_BYTES} byte limit. Use a streaming command to process larger files.`);
}

export const FILE_CHANGED_MESSAGE =
  'The file no longer matches its recorded read. Inspect the current contents before attempting a write.';

export interface FileSnapshot {
  bytes: Buffer;
  stat: Stats;
}

// Entries exist only while an operation owns or waits for the path.
const fileOperations = new Map<string, Promise<void>>();
let acquireRuntimeLock: ((key: string) => Promise<() => void>) | undefined;

/** A grouped runtime coordinates tool file access across its execution threads. */
export function setFileLockCoordinator(acquire: (key: string) => Promise<() => void>): void {
  acquireRuntimeLock = acquire;
}

export async function withFileLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const canonicalPath = realPath(filePath);
  const key = process.platform === 'win32' || process.platform === 'darwin'
    ? canonicalPath.toLowerCase() : canonicalPath;
  if (acquireRuntimeLock) {
    const release = await acquireRuntimeLock(key);
    try { return await operation(); } finally { release(); }
  }
  const previous = fileOperations.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  fileOperations.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (fileOperations.get(key) === current) fileOperations.delete(key);
  }
}

export function hashFileContent(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function sameFileVersion(a: Stats, b: Stats): boolean {
  return sameContentVersion(a, b) && a.ctimeMs === b.ctimeMs;
}

function sameContentVersion(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

async function matchesBytes(handle: fs.FileHandle, expected: Buffer): Promise<boolean> {
  const buffer = Buffer.allocUnsafe(Math.min(expected.length + 1, 64 * 1024));
  let offset = 0;
  while (offset < expected.length) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, expected.length - offset), offset);
    if (bytesRead === 0 || !buffer.subarray(0, bytesRead).equals(expected.subarray(offset, offset + bytesRead))) {
      return false;
    }
    offset += bytesRead;
  }
  return (await handle.read(buffer, 0, 1, offset)).bytesRead === 0;
}

async function statCurrentPath(filePath: string): Promise<Stats> {
  if (process.platform !== 'win32') return fs.stat(filePath);
  // Windows path stat can report dev=0 while fstat reports the volume ID.
  // Compare two handles so volume/inode identity checks remain meaningful.
  const handle = await fs.open(filePath, 'r');
  try { return await handle.stat(); } finally { await handle.close(); }
}

export async function readFileSnapshot(filePath: string): Promise<FileSnapshot> {
  const handle = await fs.open(filePath, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`Not a regular file: ${filePath}`);
    const bytes = await readBounded(handle, MAX_FILE_BYTES);
    const after = await handle.stat();
    const current = await statCurrentPath(filePath);
    if (!sameFileVersion(before, after) || !sameFileVersion(after, current)) {
      throw new Error(FILE_CHANGED_MESSAGE);
    }
    return { bytes, stat: after };
  } finally {
    await handle.close();
  }
}

/**
 * Recheck immediately before mutating an existing inode; wx refuses a concurrent
 * creator. External writers can still race after the check: this is not a CAS.
 */
export async function writeFileSnapshot(
  filePath: string,
  bytes: Buffer,
  expected?: FileSnapshot,
): Promise<Stats> {
  assertFileSize(bytes.length);
  if (!expected) await fs.mkdir(path.dirname(filePath), { recursive: true });
  const handle = await fs.open(filePath, expected ? 'r+' : 'wx');
  try {
    if (expected) {
      const current = await handle.stat();
      const atPath = await statCurrentPath(filePath);
      if (!current.isFile() || !sameFileVersion(current, atPath) ||
          !sameContentVersion(expected.stat, current) || expected.bytes.length !== current.size) {
        throw new Error(FILE_CHANGED_MESSAGE);
      }
      assertFileSize(current.size);
      // An unchanged ctime does not prove content equality; copy-up can also change only ctime.
      if (!await matchesBytes(handle, expected.bytes)) throw new Error(FILE_CHANGED_MESSAGE);
      const after = await handle.stat();
      if (!sameFileVersion(current, after) || !sameFileVersion(after, await statCurrentPath(filePath))) {
        throw new Error(FILE_CHANGED_MESSAGE);
      }
    }
    // Opening with r+ preserves permissions, hard links, and extended attributes.
    await handle.writeFile(bytes);
    await handle.truncate(bytes.length);
    return await handle.stat();
  } finally {
    await handle.close();
  }
}
