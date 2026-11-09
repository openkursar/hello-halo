import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { join as posixJoin } from 'node:path/posix';
import type { ShellState } from '../../types/tool.js';
import { findSuitableShell } from './find-shell.js';
import { rewriteWindowsNullRedirect } from './null-redirect.js';
import { isWindows } from './platform.js';
import { buildWrapperScript } from './wrapper.js';
import { windowsPathToPosixPath } from './windows-paths.js';

const MAX_SHELL_PATHS = 16;
const shellPaths = new Map<string, string>();
const selectionKeys = ['AGENT_SHELL', 'AGENT_GIT_BASH_PATH', 'SHELL', 'PATH', 'Path', 'path'];

/** Cache executable paths only; credentials and command state remain per invocation. */
export function resolveShellPath(overrides?: NodeJS.ProcessEnv): string {
  const key = JSON.stringify(selectionKeys.map(name =>
    overrides && Object.prototype.hasOwnProperty.call(overrides, name) ? overrides[name] : process.env[name],
  ));
  let shellPath = shellPaths.get(key);
  if (shellPath === undefined) shellPath = findSuitableShell({ ...process.env, ...overrides });
  else shellPaths.delete(key);
  shellPaths.set(key, shellPath);
  if (shellPaths.size > MAX_SHELL_PATHS) shellPaths.delete(shellPaths.keys().next().value!);
  return shellPath;
}

/** Foreground and background owners share launch data, not process lifetimes. */
export function prepareShellCommand(shellPath: string, command: string, state: ShellState, id: string) {
  const windows = isWindows();
  const directory = tmpdir();
  const filename = `sdk-bash-${id}.state`;
  const stateFile = join(directory, filename);
  const shellStateFile = posixJoin(windows ? windowsPathToPosixPath(directory) : directory, filename);
  const built = buildWrapperScript(rewriteWindowsNullRedirect(command), state, shellStateFile, stateFile);

  return {
    executable: shellPath,
    args: ['-c', built.script],
    options: {
      cwd: state.cwd,
      stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
      detached: !windows,
      windowsHide: true,
    },
    stateFile: built.stateFileNative,
    cleanup: built.cleanup,
  };
}

/** Sample at spawn time; caller overrides retain precedence over SDK defaults. */
export function shellEnvironment(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(!process.env.LC_ALL && !process.env.LANG ? { LC_ALL: 'C.UTF-8', LANG: 'C.UTF-8' } : {}),
    AGENT_MODE: '1',
    GIT_EDITOR: 'true',
    ...overrides,
  };
}
