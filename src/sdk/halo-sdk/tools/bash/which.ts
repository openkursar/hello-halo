/**
 * @module tools/bash/which
 * Cross-platform synchronous `which` lookup.
 *
 * Uses `where.exe` on Windows and `which` on POSIX. Returns the first
 * resolved path, or null if not found.
 *
 * @license MIT
 */

import { spawnSync } from 'node:child_process';
import { isWindows } from './platform.js';
import { getLogger } from '../../utils/logger.js';

/**
 * Find the absolute path to an executable on $PATH.
 *
 * Windows discovery must not select a workspace executable in place of a system tool.
 */
export function whichSync(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (isWindows()) {
    const r = spawnSync('where.exe', [command], {
      encoding: 'utf-8', env, timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') getLogger('Shell').warn('Executable lookup timed out', { command, timeoutMs: 5000 });
    if (r.status !== 0 || !r.stdout) return null;

    const candidates = r.stdout.trim().split(/\r?\n/).filter(Boolean);
    const cwdLower = process.cwd().toLowerCase();
    for (const c of candidates) {
      const lower = c.toLowerCase();
      // Skip cwd-relative matches
      if (lower === cwdLower || lower.startsWith(cwdLower + '\\') || lower.startsWith(cwdLower + '/')) {
        continue;
      }
      return c;
    }
    // All candidates were cwd-local; return null rather than silently using one
    return null;
  }

  const r = spawnSync('/usr/bin/which', [command], {
    encoding: 'utf-8', env, timeout: 5000,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') getLogger('Shell').warn('Executable lookup timed out', { command, timeoutMs: 5000 });
  // Some POSIX systems have which at /bin/which only
  if (r.error || r.status !== 0) {
    const r2 = spawnSync('which', [command], {
      encoding: 'utf-8', env, timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    if ((r2.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') getLogger('Shell').warn('Fallback executable lookup timed out', { command, timeoutMs: 5000 });
    if (r2.status !== 0 || !r2.stdout) return null;
    return r2.stdout.trim() || null;
  }
  if (!r.stdout) return null;
  return r.stdout.trim() || null;
}
