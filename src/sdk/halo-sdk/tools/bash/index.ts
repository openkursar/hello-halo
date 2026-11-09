/**
 * @module tools/bash
 * BashTool — Execute shell commands with timeout, background support,
 * and persistent shell state (cwd + env) across invocations.
 *
 * Cross-platform: macOS, Linux, and Windows (via Git Bash). See the
 * sibling files (windows-paths.ts, find-shell.ts, tree-kill.ts) for
 * platform-specific mechanics.
 *
 * @license MIT
 */

import type { Tool, ToolContext, ToolResult } from '../../types/tool.js';
import { toolError, toolSuccess } from '../../types/tool.js';
export { BackgroundTaskRegistry } from './background.js';
export type { BackgroundTask, BackgroundTaskOptions } from './background.js';
import { execShellCommand } from './exec.js';
import { BASH_TOOL_NAME, BASH_TOOL_DESCRIPTION, BASH_INPUT_SCHEMA } from './schema.js';
import { extractExportsFromCommand, shellStateManager } from './shell-state.js';
import { truncateBashOutput } from './truncate.js';
import { getLogger } from '../../utils/logger.js';

/** Default timeout: 2 minutes. */
const DEFAULT_TIMEOUT_MS = 120_000;
/** Maximum timeout: 10 minutes. */
const MAX_TIMEOUT_MS = 600_000;

export const BashTool: Tool = {
  name: BASH_TOOL_NAME,
  description: BASH_TOOL_DESCRIPTION,
  inputSchema: BASH_INPUT_SCHEMA,
  permissionLevel: 'execute',

  async execute(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const command = input.command as string | undefined;
    if (!command || typeof command !== 'string') {
      return toolError('Missing required parameter: command');
    }

    const timeoutMs = Math.min(
      Math.max(0, Number(input.timeout) || DEFAULT_TIMEOUT_MS),
      MAX_TIMEOUT_MS,
    );
    const runBg = Boolean(input.run_in_background);
    const backgroundTimeoutMs = input.timeout === undefined ? undefined : timeoutMs;

    // Every session identity owns its shell state.
    const state = shellStateManager.get(ctx.sessionId, ctx.cwd);

    // --- Background path ---
    if (runBg) {
      const registry = ctx.services?.backgroundTasks;
      if (!registry) return toolError('Background execution requires session-owned task services');
      try {
        const task = await registry.start({ command, state, fallbackCwd: ctx.cwd, env: ctx.env,
          timeoutMs: backgroundTimeoutMs, abortSignal: ctx.abortSignal });
        const metadata = { task_id: task.id, output_file: task.outputFile };
        if (task.status === 'failed') return toolError(`Failed to start background task ${task.id}: ${task.error}`, metadata);
        return toolSuccess(
          (task.cwdWarning ? `${task.cwdWarning}\n` : '') +
          `Command running in background with ID: ${task.id}.\nOutput file: ${task.outputFile}\n` +
          (backgroundTimeoutMs === undefined
            ? 'No execution deadline was set.\n'
            : `Execution deadline: ${backgroundTimeoutMs}ms from launch.\n`) +
          'Completion is reported at the next active turn. Use Read for output, TaskOutput for status, or TaskStop to stop it. ' +
          'Background tasks stop when the session is closed or interrupted.',
          metadata,
        );
      } catch (error) {
        return toolError(`Failed to start background command: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // --- Foreground path ---
    // ctx.env may contain `undefined` values (Record<string, string | undefined>).
    // Spawn env must be string-only — filter undefined.
    const envOverrides: Record<string, string> = {};
    for (const [k, v] of Object.entries(ctx.env)) {
      if (typeof v === 'string') envOverrides[k] = v;
    }

    const result = await execShellCommand({
      command,
      state,
      fallbackCwd: ctx.cwd,
      envOverrides,
      timeoutMs,
      abortSignal: ctx.abortSignal,
    });

    // Persist state from the wrapper's state file (cwd + env).
    if (result.state) {
      state.cwd = result.state.cwd;
      // Merge: vars set in earlier calls survive unless re-exported.
      for (const [k, v] of result.state.envVars) {
        state.envVars.set(k, v);
      }
      shellStateManager.update(ctx.sessionId, state);
    } else if (result.started) {
      // State file unreadable: best-effort fall back to parsing
      // explicit `export` patterns in the command text.
      const exports = extractExportsFromCommand(command);
      if (exports.size > 0) {
        for (const [k, v] of exports) {
          state.envVars.set(k, v);
        }
        shellStateManager.update(ctx.sessionId, state);
      }
    }

    // Assemble output. We preserve the order of write: stdout first
    // (trimmed of trailing newline), then stderr if any. This matches
    // the test expectations and historical behavior.
    let output = '';
    const stdoutTrimmed = stripTrailingNewlines(result.stdout);
    if (stdoutTrimmed) {
      output = stdoutTrimmed;
    }
    const stderrTrimmed = result.stderr.trim();
    if (stderrTrimmed) {
      output = output ? `${output}\n${stderrTrimmed}` : stderrTrimmed;
    }
    if (!output) {
      output = '(No output)';
    }

    if (result.timedOut) {
      getLogger('Bash').warn('command timed out; returning captured output', {
        sessionId: ctx.sessionId, timeoutMs,
        stdoutChars: result.stdout.length, stderrChars: result.stderr.length,
      });
      return toolError(truncateBashOutput(
        `Command timed out after ${timeoutMs}ms and was terminated.\n${output}\n\n` +
        'The command may have completed some work before termination. Inspect its output and saved files before repeating it.',
      ));
    }

    if (result.exitCode !== 0) {
      return toolError(truncateBashOutput(`Command exited with code ${result.exitCode}\n${output}`));
    }
    return toolSuccess(truncateBashOutput(output));
  },
};

/** Strip trailing \n / \r\n but preserve internal newlines. */
function stripTrailingNewlines(s: string): string {
  let end = s.length;
  while (end > 0) {
    const c = s.charCodeAt(end - 1);
    if (c === 0x0a /* \n */ || c === 0x0d /* \r */) {
      end--;
    } else {
      break;
    }
  }
  return s.slice(0, end);
}
