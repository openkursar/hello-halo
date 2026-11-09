/**
 * @module tools/bash/windowsPaths
 * Windows ↔ POSIX path conversion + Git Bash discovery.
 *
 * The Bash tool always invokes a POSIX shell (Git Bash on Windows).
 * Shell-side commands need POSIX paths (`/c/Users/foo`); Node-side fs
 * operations need native Windows paths (`C:\Users\foo`). These helpers
 * translate between the two.
 *
 * @license MIT
 */

import { existsSync } from 'node:fs';
import { join as nativeJoin } from 'node:path';
import { isWindows } from './platform.js';
import { whichSync } from './which.js';
import { getLogger } from '../../utils/logger.js';

function isDriveLetter(value: string): boolean {
  if (value.length !== 1) return false;
  const code = value.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/** Translate separators and absolute drive roots without resolving the path. */
export function windowsPathToPosixPath(value: string): string {
  const portable = value.split('\\').join('/');
  if (portable[1] === ':' && portable[2] === '/' && isDriveLetter(portable[0])) {
    return `/${portable[0].toLowerCase()}${portable.substring(2)}`;
  }
  return portable;
}

/** Recognize MSYS and Cygwin drive mounts; retain UNC and relative path structure. */
export function posixPathToWindowsPath(value: string): string {
  const segments = value.split('/');
  if (segments[0] === '') {
    const drivePosition = segments[1] === 'cygdrive' ? 2 : 1;
    const drive = segments[drivePosition];
    if (drive && isDriveLetter(drive)) {
      const remainder = segments.slice(drivePosition + 1);
      return [drive.toUpperCase() + ':', ...(remainder.length ? remainder : [''])].join('\\');
    }
  }
  return segments.join('\\');
}

// ---------------------------------------------------------------------------
// Git Bash discovery
// ---------------------------------------------------------------------------


/**
 * Locate `bash.exe` from a Git for Windows installation.
 *
 * Resolution order:
 *   1. `AGENT_GIT_BASH_PATH` env override (validated against fs)
 *   2. `C:\Program Files\Git\bin\bash.exe`
 *   3. `C:\Program Files (x86)\Git\bin\bash.exe`
 *   4. Locate `git.exe` via `where`, derive `..\..\bin\bash.exe`
 *
 * Returns `null` if no Git Bash can be found. Caller decides how to
 * surface this — on Windows we throw a helpful error in findShell.
 */
export function findGitBashPath(env: NodeJS.ProcessEnv = process.env): string | null {

  if (!isWindows()) {
    return null;
  }

  // 1. Env override
  const override = env.AGENT_GIT_BASH_PATH;
  if (override) {
    if (existsSync(override)) {
      return override;
    }
    getLogger('Shell').warn('Configured Git Bash path is unavailable; trying discovery', { setting: 'AGENT_GIT_BASH_PATH' });
  }

  // 2 & 3. Known install locations
  const knownPaths = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ];
  for (const p of knownPaths) {
    if (existsSync(p)) {
      return p;
    }
  }

  const gitPath = whichSync('git', env);
  if (gitPath && existsSync(gitPath)) {
    const gitDir = nativeJoin(gitPath, '..', '..');
    const bashPath = nativeJoin(gitDir, 'bin', 'bash.exe');
    if (existsSync(bashPath)) return bashPath;
  }

  return null;
}

