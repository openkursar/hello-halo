/**
 * @module tools/bash/shell-state
 * Persistent shell state management across Bash tool invocations.
 * Tracks cwd and env variables so `cd` and `export` persist across tool calls.
 * @license MIT
 */

import type { ShellState } from '../../types/tool.js';

/**
 * Holds the cwd and exported env vars that must survive between Bash calls,
 * one entry per session.
 *
 * Entries belong to a session identity. Execution retirement can transfer this
 * working state to its replacement; final disposal releases it.
 */
export class ShellStateManager {
  private states = new Map<string, ShellState>();

  /** Number of live entries. Exposed so leaks are observable in tests. */
  get size(): number {
    return this.states.size;
  }

  peek(sessionId: string): ShellState | undefined {
    return this.states.get(sessionId);
  }

  /** Get or create the ShellState for a session. */
  get(sessionId: string, defaultCwd: string): ShellState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = {
        cwd: defaultCwd,
        envVars: new Map(),
      };
      this.states.set(sessionId, state);
    }
    return state;
  }

  /** Update the ShellState for a session. */
  update(sessionId: string, state: ShellState): void {
    this.states.set(sessionId, state);
  }

  /** Release the state for a session. Safe to call for a session with none. */
  remove(sessionId: string): void {
    this.states.delete(sessionId);
  }
}

/** Global shell state manager singleton. */
export const shellStateManager = new ShellStateManager();

/**
 * Extract `export VAR=value` patterns from a command string.
 * Only handles simple single-line exports; complex shell constructs are
 * handled by the full env-dump approach.
 */
export function extractExportsFromCommand(command: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|(\S*))/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(command)) !== null) {
    const key = match[1];
    const val = match[2] ?? match[3] ?? match[4] ?? '';
    map.set(key, val);
  }
  return map;
}
