/**
 * @module tools/bash/findShell
 * Detect a usable POSIX shell across platforms.
 *
 * Resolution order:
 *   1. `AGENT_SHELL` env override (must point to bash/zsh)
 *   2. Windows: Git Bash (`findGitBashPath`)
 *   3. `$SHELL` env (must be bash/zsh and executable)
 *   4. `which bash`, `which zsh`
 *   5. Standard install locations (/bin, /usr/bin, /usr/local/bin, /opt/homebrew/bin)
 *
 * The caller caches results by shell-selection environment. Throws if no shell is found —
 * this is a hard requirement for the Bash tool.
 *
 * @license MIT
 */

import { accessSync, constants as fsConstants } from 'node:fs';
import { isWindows } from './platform.js';
import { whichSync } from './which.js';
import { findGitBashPath } from './windows-paths.js';
import { getLogger } from '../../utils/logger.js';

/** Test whether a path is executable. */
function isExecutable(p: string): boolean {
  try {
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    // Preserve discovery on filesystems that cannot report execute permission.
    try {
      accessSync(p, fsConstants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}

function isSupportedShell(p: string): boolean {
  return p.includes('bash') || p.includes('zsh');
}

/**
 * Find a usable POSIX shell. Throws if none is found.
 *
 * On Windows, this means Git Bash. The user is expected to install Git
 * for Windows (https://git-scm.com/downloads/win) or set
 * `AGENT_GIT_BASH_PATH` to point at a bash.exe.
 */
export function findSuitableShell(env: NodeJS.ProcessEnv = process.env): string {
  // 1. Explicit override
  const override = env.AGENT_SHELL;
  if (override && isSupportedShell(override) && isExecutable(override)) {
    return override;
  }
  if (override) getLogger('Shell').warn('Configured shell is unsupported or unavailable; trying discovery', { setting: 'AGENT_SHELL' });

  // 2. Windows: Git Bash (preferred over $SHELL which may be a Windows path)
  if (isWindows()) {
    const gb = findGitBashPath(env);
    if (gb && isExecutable(gb)) {
      return gb;
    }
    throw new Error(
      'No Git Bash executable is available for this Windows session. ' +
      'Point AGENT_GIT_BASH_PATH to an installed bash.exe, or install Git for Windows ' +
      'from https://git-scm.com/downloads/win.',
    );
  }

  // 3. $SHELL env
  const envShell = env.SHELL;
  if (envShell && isSupportedShell(envShell) && isExecutable(envShell)) {
    return envShell;
  }

  // 4. which bash / zsh
  const preferBash = !!envShell?.includes('bash');
  const order = preferBash ? ['bash', 'zsh'] : ['zsh', 'bash'];
  for (const name of order) {
    const p = whichSync(name, env);
    if (p && isExecutable(p)) {
      return p;
    }
  }

  // 5. Standard install locations
  const stdPaths = ['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'];
  for (const name of order) {
    for (const dir of stdPaths) {
      const p = `${dir}/${name}`;
      if (isExecutable(p)) {
        return p;
      }
    }
  }

  throw new Error(
    'No suitable shell found. The Bash tool requires bash or zsh. ' +
    'Set AGENT_SHELL=/path/to/bash if your shell is in an unusual location.',
  );
}

