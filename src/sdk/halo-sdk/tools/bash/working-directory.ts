import { stat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import { getLogger } from '../../utils/logger.js';
import { getPlatform } from './platform.js';

export function isAbsoluteWorkingDirectory(cwd: string): boolean {
  return !/[\0\r\n]/.test(cwd) &&
    (getPlatform() === 'windows' ? win32.isAbsolute(cwd) : posix.isAbsolute(cwd));
}

async function directoryProblem(cwd: string): Promise<string | undefined> {
  if (!isAbsoluteWorkingDirectory(cwd)) return 'invalid_path';
  try {
    return (await stat(cwd)).isDirectory() ? undefined : 'not_directory';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? 'stat_failed';
  }
}

export async function resolveWorkingDirectory(
  cwd: string,
  fallbackCwd?: string,
): Promise<{ cwd: string; warning?: string }> {
  const reason = await directoryProblem(cwd);
  if (!reason) return { cwd };

  const recoverable = ['invalid_path', 'not_directory', 'ENOENT', 'ENOTDIR'].includes(reason);
  if (recoverable && fallbackCwd && fallbackCwd !== cwd && !await directoryProblem(fallbackCwd)) {
    getLogger('Bash').warn('shell working directory unavailable; using session directory', { reason });
    return {
      cwd: fallbackCwd,
      warning: `Previous shell working directory is unavailable (${reason}). Running in session directory ${JSON.stringify(fallbackCwd)}.`,
    };
  }

  getLogger('Bash').warn('command not started: working directory unavailable', { reason });
  throw new Error(`Command not started: shell working directory is unavailable (${reason}). Restore the session working directory before retrying.`);
}
