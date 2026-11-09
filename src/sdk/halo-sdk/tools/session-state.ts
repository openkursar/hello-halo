/**
 * @module tools/session-state
 * Releases the state that tools keep keyed by session id.
 *
 * Tools that must remember something between calls — the shell's cwd and
 * exported variables, the todo list, the goal — hold it in module-level stores.
 * The session owner releases them on close. Idle retirement may capture their
 * working state first without keeping execution resources alive.
 *
 * Every store keyed by session belongs in this function.
 * @license MIT
 */

import { shellStateManager } from './bash/shell-state.js';
import { releaseTodos, captureTodos, restoreTodos, type TodoItem } from './todo-write/index.js';
import { releaseGoal, captureGoalState, restoreGoalState, type GoalEntry } from './goal/index.js';
import { releaseSessionStorage } from './session-storage.js';
import type { ShellState } from '../types/tool.js';

export interface SessionToolSnapshot {
  shell?: ShellState;
  todos?: TodoItem[];
  goal?: GoalEntry;
}

export function captureSessionToolState(sessionId: string): SessionToolSnapshot {
  const shell = shellStateManager.peek(sessionId);
  return {
    shell: shell ? { cwd: shell.cwd, envVars: new Map(shell.envVars) } : undefined,
    todos: captureTodos(sessionId),
    goal: captureGoalState(sessionId),
  };
}

export function restoreSessionToolState(sessionId: string, snapshot: SessionToolSnapshot): void {
  if (snapshot.shell) shellStateManager.update(sessionId, { cwd: snapshot.shell.cwd, envVars: new Map(snapshot.shell.envVars) });
  restoreTodos(sessionId, snapshot.todos);
  restoreGoalState(sessionId, snapshot.goal);
}

/**
 * Release everything held for `sessionId`.
 *
 * @param discardPersisted - Also delete the session's on-disk todo list and
 *   goal. One-shot queries discard their private state; resumable sessions
 *   retain it.
 */
export function releaseSessionToolState(
  sessionId: string,
  { discardPersisted = false }: { discardPersisted?: boolean } = {},
): void {
  shellStateManager.remove(sessionId);
  releaseTodos(sessionId, { discardPersisted });
  releaseGoal(sessionId, { discardPersisted });
  releaseSessionStorage(sessionId);
}
