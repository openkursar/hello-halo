import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';
import { getHaloDir } from '../../foundation/config.service';
import { RuntimeError } from './errors';
import type { RuntimeProvider } from './provider';
export function getRuntimeRoot(provider: RuntimeProvider): string {
  return join(getHaloDir(), 'runtimes', provider.directoryName);
}
export function normalizeInputPath(input: string): string {
  if (typeof input !== 'string' || input.length > 4096) {
    throw new RuntimeError('not-found');
  }
  const trimmed = input.trim().replace(/^(["'])(.*)\1$/, '$2');
  const path = trimmed === '~' ? homedir() : trimmed.startsWith(`~${sep}`) || trimmed.startsWith('~/') ? join(homedir(), trimmed.slice(2)) : trimmed;
  if (!path || path.includes('\0') || !isAbsolute(path)) {
    throw new RuntimeError('not-found');
  }
  return normalize(path);
}
export async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) {
      console.warn('[ExternalRuntime] Candidate cannot be inspected', {
        code: (error as NodeJS.ErrnoException).code
      });
    }
    return false;
  }
}
export async function candidateExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() || info.isDirectory();
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || '')) {
      console.warn('[ExternalRuntime] Candidate cannot be inspected', { code: (error as NodeJS.ErrnoException).code });
    }
    return false;
  }
}
export async function isManagedPath(provider: RuntimeProvider, path: string): Promise<boolean> {
  let root: string;
  try {
    root = await realpath(getRuntimeRoot(provider));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[ExternalRuntime] Managed directory cannot be resolved', {
        runtimeId: provider.id,
        code: (error as NodeJS.ErrnoException).code
      });
    }
    return false;
  }
  const local = relative(root, path);
  return local !== '' && local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local);
}
