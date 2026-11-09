/**
 * @module tools/bash/wrapper
 * Shell wrapper script generation and state file parsing.
 *
 * The wrapper:
 *   1. Restores tracked cwd and env vars
 *   2. Runs the user command
 *   3. Writes final pwd and env dump to a UTF-8 tmp file
 *
 * State is written to a temp file (not stdout) so that stdout encoding
 * issues — chiefly Windows GBK / CP936 from `cmd.exe` and `systeminfo` —
 * cannot corrupt the state metadata. The temp file is read by Node as
 * UTF-8.
 *
 * @license MIT
 */

import { readFileSync, unlinkSync } from 'node:fs';
import type { ShellState } from '../../types/tool.js';
import { getPlatform } from './platform.js';
import { posixQuote } from './shell-quote.js';
import { posixPathToWindowsPath, windowsPathToPosixPath } from './windows-paths.js';
import { isAbsoluteWorkingDirectory } from './working-directory.js';
import { getLogger } from '../../utils/logger.js';

/** System/internal env vars never persisted into ShellState. */
const FILTERED_VARS = new Set([
  '_', 'SHLVL', 'BASH_LINENO', 'BASH_SOURCE', 'PWD', '__agent_ec', '__agent_cwd',
  'FUNCNAME', 'PIPESTATUS', 'OLDPWD',
  // bash internal
  'BASHOPTS', 'BASH_ALIASES', 'BASH_ARGC', 'BASH_ARGV', 'BASH_CMDS',
  'BASH_COMMAND', 'BASH_EXECUTION_STRING', 'BASH_LINENO',
  'BASH_REMATCH', 'BASH_SUBSHELL', 'BASH_VERSINFO', 'BASH_VERSION',
  'COMP_WORDBREAKS', 'DIRSTACK', 'EUID', 'GROUPS', 'HOSTNAME',
  'HOSTTYPE', 'IFS', 'LINENO', 'MACHTYPE', 'OPTERR', 'OPTIND',
  'OSTYPE', 'PIPESTATUS', 'PPID', 'PS1', 'PS2', 'PS4', 'RANDOM',
  'SECONDS', 'SHELL', 'SHELLOPTS', 'UID',
]);

/** Result of parsing the state file written by the wrapper. */
export interface ParsedState {
  /** Native-OS-format cwd (Windows: `C:\…`, POSIX: `/…`) */
  cwd: string;
  envVars: Map<string, string>;
}

export interface WrapperBuild {
  /** The bash command string to pass via `-c`. */
  script: string;
  /** Native-OS path of the state file (for Node fs reads). */
  stateFileNative: string;
  /** Cleanup function: removes the state file. Safe to call multiple times. */
  cleanup: () => void;
}

/**
 * Build a bash wrapper script that runs `command` with the session's
 * persistent state restored and writes the resulting cwd + env to a
 * temp file in UTF-8.
 *
 * @param command          User command (verbatim, as bash code)
 * @param state            Session/agent-scoped persistent shell state
 * @param stateFilePosix   POSIX path of the state file (used inside the script)
 * @param stateFileNative  Native-OS path of the state file (used by Node fs)
 */
export function buildWrapperScript(
  command: string,
  state: ShellState,
  stateFilePosix: string,
  stateFileNative: string,
): WrapperBuild {
  // We deliberately do NOT `set -e` around the user command — the user's
  // command may legitimately exit non-zero. We DO capture $? immediately
  // after, then write state, then propagate the exit code.

  // Restore cwd: convert native cwd to POSIX form for bash on Windows.
  // `cd` in Git Bash accepts both forms but POSIX is canonical and
  // avoids backslash-escape footguns.
  const cwdForShell = getPlatform() === 'windows'
    ? windowsPathToPosixPath(state.cwd)
    : state.cwd;

  // Restore env vars. Use POSIX single-quote escape — never trust any
  // value to be shell-safe.
  let exportLines = '';
  for (const [k, v] of state.envVars) {
    // Skip vars that ended up filtered (defense-in-depth)
    if (FILTERED_VARS.has(k)) continue;
    exportLines += `export ${k}=${posixQuote(v)}\n`;
  }

  const sf = posixQuote(stateFilePosix);
  const pwdCommand = getPlatform() === 'windows' ? 'pwd -P -W' : 'pwd -P';

  // Use `pwd -P` for the physical path (symlinks resolved) so cwd
  // tracking matches Node's process.cwd() semantics.
  //
  // env dump: filter to NAME=value lines via a POSIX awk-free check.
  // Use `printf '%s\n'` instead of `echo` to handle values with
  // embedded backslashes correctly.
  const script = [
    // The directory can disappear after the launch check; do not run elsewhere.
    `cd ${posixQuote(cwdForShell)} 2>/dev/null || ` +
      `{ printf 'agent-sdk: working directory is unavailable; command not started\\n' >&2; exit 127; }`,
    exportLines,
    // --- USER COMMAND ---
    command,
    // --- POST ---
    `__agent_ec=$?`,
    // Always write the cwd slot, even when the command deleted its own directory.
    `__agent_cwd=$(${pwdCommand} 2>/dev/null) || ` +
      `{ __agent_cwd=${posixQuote(state.cwd)}; printf 'agent-sdk: current directory is unavailable; retaining previous directory state\\n' >&2; }`,
    `{ printf '%s\\n' "$__agent_cwd"; env; } > ${sf} 2>/dev/null || true`,
    `exit $__agent_ec`,
  ].join('\n');

  const cleanup = (): void => {
    try {
      unlinkSync(stateFileNative);
    } catch {
      // Already gone or never created
    }
  };

  return { script, stateFileNative, cleanup };
}

/**
 * Read and parse the state file written by the wrapper.
 * Returns null on any I/O or parse error.
 */
export function readStateFile(stateFileNative: string): ParsedState | null {
  let raw: string;
  try {
    raw = readFileSync(stateFileNative, { encoding: 'utf-8' });
  } catch {
    return null;
  }

  const lines = raw.split('\n');
  // Drop the single trailing empty line that comes from `env`'s terminal
  // newline; otherwise the continuation parser would treat it as an
  // empty continuation of the last value, appending '\n' to it.
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  const cwdLine = lines[0];
  if (!cwdLine) {
    getLogger('Bash').warn('shell state discarded: missing working directory');
    return null;
  }

  // Normalize cwd to native OS format
  let cwd = cwdLine;
  if (getPlatform() === 'windows') {
    cwd = posixPathToWindowsPath(cwd);
  }
  if (!isAbsoluteWorkingDirectory(cwd)) {
    getLogger('Bash').warn('shell state discarded: invalid working directory');
    return null;
  }

  const envVars = new Map<string, string>();
  // Multi-line env values: bash `env` writes them as-is including
  // embedded newlines. We use the next NAME=VALUE pattern as the
  // boundary — anything that doesn't match the pattern at the start
  // of a line is treated as a continuation.
  const nameLineRe = /^([A-Za-z_][A-Za-z0-9_]*)=/;
  let currentKey: string | null = null;
  let currentVal: string[] = [];
  const flush = (): void => {
    if (currentKey === null) return;
    if (!FILTERED_VARS.has(currentKey) && !currentKey.startsWith('BASH_FUNC_')) {
      envVars.set(currentKey, currentVal.join('\n'));
    }
    currentKey = null;
    currentVal = [];
  };

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const m = line.match(nameLineRe);
    if (m) {
      flush();
      currentKey = m[1]!;
      currentVal = [line.slice(m[0].length)];
    } else if (currentKey !== null) {
      currentVal.push(line);
    }
    // else: stray line before first env entry — ignore
  }
  flush();

  return { cwd, envVars };
}
