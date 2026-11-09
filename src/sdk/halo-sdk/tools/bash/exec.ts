/**
 * @module tools/bash/exec
 * Top-level shell command execution.
 *
 * Responsibilities:
 *   - Resolve the shell binary (cached by session environment, via provider)
 *   - Prepare the shared POSIX launch data and state file
 *   - Spawn with windowsHide + cross-platform process-group setup
 *   - Capture stdout/stderr as UTF-8 strings
 *   - Handle timeout (SIGTERM → 5s grace → SIGKILL via tree-kill)
 *   - Handle AbortSignal (immediate tree-kill)
 *   - Read back the state file, return parsed state
 *
 * Stdout/stderr capture uses `setEncoding('utf-8')` on the streams so
 * Node's StringDecoder handles multi-byte UTF-8 correctly. Note this
 * does NOT transcode from non-UTF-8 encodings (Windows GBK from
 * cmd.exe): mojibake from such tools is inherent to the user's
 * command, not the harness. The state file is written separately by
 * the wrapper as a UTF-8 file, immune to user-command encoding.
 *
 * @license MIT
 */

import { OutputBuffer } from './output-buffer.js';
import { getLogger } from '../../utils/logger.js';
import { spawn } from '../../utils/processes.js';
import { randomBytes } from 'node:crypto';
import type { ShellState } from '../../types/tool.js';
import { prepareShellCommand, resolveShellPath, shellEnvironment } from './provider.js';
import { readStateFile, type ParsedState } from './wrapper.js';
import { killTree } from './tree-kill.js';
import { resolveWorkingDirectory } from './working-directory.js';

/** Outcome of a foreground command execution. */
export interface ExecResult {
  started: boolean;
  /** Exit code from the user's command (NOT from the wrapper). */
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True if the command was killed by the timeout. */
  timedOut: boolean;
  /** True if the command was killed by the abort signal. */
  aborted: boolean;
  /** Parsed final state from the wrapper's state file (null on read failure). */
  state: ParsedState | null;
}

export interface ExecOptions {
  command: string;
  /** Current shell state to restore (cwd + env vars). */
  state: ShellState;
  /** Session directory to recover into when the saved shell directory disappears. */
  fallbackCwd?: string;
  /** Subprocess env additions (merged on top of provider's). */
  envOverrides?: Record<string, string>;
  /** Timeout in ms. SIGTERM is sent at this point; SIGKILL 5s later. */
  timeoutMs: number;
  /** Optional abort signal; trigger immediate tree-kill. */
  abortSignal?: AbortSignal;
}

/** Generate a short unique ID for temp-file naming. */
function genId(): string {
  return randomBytes(6).toString('hex');
}

/**
 * Execute `command` in a foreground bash subprocess.
 *
 * Background commands have a separate session-owned lifecycle.
 */
export async function execShellCommand(opts: ExecOptions): Promise<ExecResult> {
  const state = { cwd: opts.state.cwd, envVars: new Map(opts.state.envVars) };
  let directory: Awaited<ReturnType<typeof resolveWorkingDirectory>>;
  try {
    directory = await resolveWorkingDirectory(state.cwd, opts.fallbackCwd);
  } catch (error) {
    return { started: false, exitCode: 127, stdout: '', stderr: String(error instanceof Error ? error.message : error),
      timedOut: false, aborted: false, state: null };
  }
  state.cwd = directory.cwd;
  const shellPath = resolveShellPath(opts.envOverrides);
  const id = genId();
  const launch = prepareShellCommand(shellPath, opts.command, state, id);

  return new Promise<ExecResult>((resolve) => {
    const stdoutChunks = new OutputBuffer();
    const stderrChunks = new OutputBuffer();
    if (directory.warning) stderrChunks.append(`${directory.warning}\n`);

    let child;
    try {
      child = spawn(launch.executable, launch.args, {
        ...launch.options,
        env: shellEnvironment(opts.envOverrides),
      });
    } catch (err) {
      launch.cleanup();
      resolve({
        started: false,
        exitCode: 127,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        timedOut: false,
        aborted: false,
        state: null,
      });
      return;
    }

    // UTF-8 string decoding — handles multi-byte boundaries correctly.
    child.stdout?.setEncoding('utf-8');
    child.stderr?.setEncoding('utf-8');
    child.stdout?.on('data', (s: string) => stdoutChunks.append(s));
    child.stderr?.on('data', (s: string) => stderrChunks.append(s));

    let timedOut = false;
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;

    const killSoft = (): void => {
      if (!child.pid) return;
      killTree(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => {
        if (child.pid) killTree(child.pid, 'SIGKILL');
      }, 5000);
      killTimer.unref();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killSoft();
    }, opts.timeoutMs);
    timer.unref();

    // Abort handling
    const abortHandler = (): void => {
      aborted = true;
      killSoft();
    };
    if (opts.abortSignal) {
      if (opts.abortSignal.aborted) {
        // Already aborted before spawn returned: kill immediately
        abortHandler();
      } else {
        opts.abortSignal.addEventListener('abort', abortHandler, { once: true });
      }
    }

    // We use 'close' (NOT 'exit') because 'close' fires after stdio
    // streams are drained. On Windows in particular, exit can fire
    // before stderr is flushed, truncating error messages.
    child.once('close', (code, signal) => {
      if (stdoutChunks.truncated || stderrChunks.truncated) {
        getLogger('Bash').warn('command output capture truncated', { stdout: stdoutChunks.truncated, stderr: stderrChunks.truncated });
      }
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (opts.abortSignal) {
        opts.abortSignal.removeEventListener('abort', abortHandler);
      }

      const state = readStateFile(launch.stateFile);
      launch.cleanup();

      // Derive exit code:
      //   - code is non-null when the process exited normally
      //   - code is null when killed by signal; map to 128 + signum analog
      //   - Windows reports null+signal='SIGTERM' for taskkill; treat as termination
      let exitCode: number;
      if (timedOut) {
        exitCode = 124; // Convention: GNU timeout uses 124
      } else if (aborted) {
        exitCode = 130; // 128 + SIGINT
      } else if (code !== null) {
        exitCode = code;
      } else {
        // Signaled but neither timeout nor abort — treat as generic failure
        exitCode = signal ? 128 : 1;
      }

      resolve({
        started: !!child.pid,
        exitCode,
        stdout: stdoutChunks.text(),
        stderr: stderrChunks.text(),
        timedOut,
        aborted,
        state,
      });
    });

    child.once('error', (err) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (opts.abortSignal) {
        opts.abortSignal.removeEventListener('abort', abortHandler);
      }
      launch.cleanup();
      resolve({
        started: false,
        exitCode: 127,
        stdout: stdoutChunks.text(),
        stderr: err.message,
        timedOut: false,
        aborted: false,
        state: null,
      });
    });
  });
}
