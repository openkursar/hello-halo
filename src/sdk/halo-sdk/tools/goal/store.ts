/**
 * @module tools/goal/store
 * Per-session goal state: in-memory cache backed by a JSON file, plus the
 * record of which version the model last saw.
 *
 * The goal changes from two sides. The model changes it through the Goal
 * tool, and sees the result in the tool output. The host changes it on the
 * user's behalf between turns, and the model has not seen that — so the store
 * keeps the version the model last saw and the loop drains the difference
 * into a notice.
 * @license MIT
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Goal, GoalInput } from '../../types/goal.js';
import { sessionStoragePath } from '../session-storage.js';

export interface GoalEntry {
  current: Goal | null;
  /** The goal as the model last saw it. */
  seen: Goal | null;
}

/** A host-side change the model has not been told about yet. */
export interface GoalChange {
  previous: Goal | null;
  current: Goal | null;
}

const goalStore = new Map<string, GoalEntry>();

/**
 * Best-effort persistence; the in-memory entry stays authoritative. The file
 * keeps `seen` as well as `current`, so a host-side change the model has not
 * been told about (including a cleared goal) survives a session rebuild. It is
 * removed only once there is neither a goal nor an untold change.
 */
function persistEntry(sessionId: string, entry: GoalEntry): void {
  const file = sessionStoragePath(sessionId, 'goals');
  if (!file) return;
  try {
    if (entry.current === null && entry.seen === null) {
      fs.rmSync(file, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const record: GoalEntry = { current: entry.current, seen: entry.seen };
    fs.writeFileSync(file, JSON.stringify(record, null, 2), 'utf-8');
  } catch (error) {
    console.warn(`[Goal] Persistence failed: session=${sessionId}`, error);
  }
}

function removePersisted(sessionId: string): void {
  const file = sessionStoragePath(sessionId, 'goals');
  if (!file) return;
  try {
    fs.rmSync(file, { force: true });
  } catch (error) {
    console.warn(`[Goal] Stored goal could not be removed: session=${sessionId}`, error);
  }
}

function isGoal(value: unknown): value is Goal {
  if (!value || typeof value !== 'object') return false;
  const g = value as Record<string, unknown>;
  return (
    typeof g.objective === 'string' &&
    Array.isArray(g.doneWhen) &&
    (g.status === 'active' || g.status === 'complete' || g.status === 'abandoned')
  );
}

function readEntryFromDisk(sessionId: string): GoalEntry {
  const file = sessionStoragePath(sessionId, 'goals');
  if (!file) return { current: null, seen: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[Goal] Stored goal could not be read: session=${sessionId} reason=${error instanceof Error ? error.name : 'unknown'} code=${(error as NodeJS.ErrnoException).code ?? '-'}`);
    return { current: null, seen: null };
  }
  // Older files hold the bare goal, already seen by the model.
  if (isGoal(parsed)) return { current: parsed, seen: parsed };
  if (parsed && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>;
    const current = isGoal(record.current) ? record.current : null;
    const seen = isGoal(record.seen) ? record.seen : null;
    return { current, seen };
  }
  return { current: null, seen: null };
}

function entryFor(sessionId: string): GoalEntry {
  let entry = goalStore.get(sessionId);
  if (!entry) {
    entry = readEntryFromDisk(sessionId);
    goalStore.set(sessionId, entry);
  }
  return entry;
}

/** Whether two goals say the same thing to the model. */
export function sameGoal(a: Goal | null, b: Goal | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.objective === b.objective &&
    a.status === b.status &&
    a.doneWhen.length === b.doneWhen.length &&
    a.doneWhen.every((c, i) => c === b.doneWhen[i])
  );
}

/** Normalize criteria: trimmed, non-empty strings only. */
export function cleanCriteria(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((c): c is string => typeof c === 'string')
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

// ---------------------------------------------------------------------------
// Public access
// ---------------------------------------------------------------------------

/** The session's goal (active or finished), or null when none is set. */
export function getGoal(sessionId: string): Goal | null {
  return entryFor(sessionId).current;
}

export function captureGoalState(sessionId: string): GoalEntry | undefined {
  const entry = goalStore.get(sessionId);
  return entry ? structuredClone(entry) : undefined;
}

export function restoreGoalState(sessionId: string, entry: GoalEntry | undefined): void {
  if (!entry) return;
  const restored = structuredClone(entry);
  goalStore.set(sessionId, restored);
  if (restored.current || restored.seen) persistEntry(sessionId, restored);
}

/** The session's goal if it is still active. */
export function getActiveGoal(sessionId: string): Goal | null {
  const goal = getGoal(sessionId);
  return goal?.status === 'active' ? goal : null;
}

/** Record a change the model made itself; it already sees the result. */
export function applyAgentGoal(sessionId: string, goal: Goal): void {
  const entry = entryFor(sessionId);
  entry.current = goal;
  entry.seen = goal;
  persistEntry(sessionId, entry);
}

/**
 * Replace (or clear, with null) the goal on the user's behalf. The model is
 * told on its next turn.
 *
 * @throws TypeError when the objective is missing or blank.
 */
export function setGoalFromHost(sessionId: string, input: GoalInput | null): Goal | null {
  const entry = entryFor(sessionId);
  if (input === null) {
    entry.current = null;
    persistEntry(sessionId, entry);
    return null;
  }
  const objective = typeof input.objective === 'string' ? input.objective.trim() : '';
  if (!objective) {
    throw new TypeError('Goal objective must be a non-empty string.');
  }
  const goal: Goal = {
    objective,
    doneWhen: cleanCriteria(input.doneWhen),
    status: 'active',
    updatedBy: 'user',
    updatedAt: new Date().toISOString(),
  };
  entry.current = goal;
  persistEntry(sessionId, entry);
  return goal;
}

/**
 * Take the host-side change the model has not seen, if any. After this call
 * the model is considered to know the current goal.
 */
export function drainGoalChange(sessionId: string): GoalChange | null {
  const entry = entryFor(sessionId);
  if (sameGoal(entry.seen, entry.current)) return null;
  const change: GoalChange = { previous: entry.seen, current: entry.current };
  entry.seen = entry.current;
  persistEntry(sessionId, entry);
  return change;
}

/**
 * Forget a session's goal. `discardPersisted` also removes the on-disk copy;
 * user sessions keep it so they can be resumed.
 */
export function releaseGoal(
  sessionId: string,
  options: { discardPersisted?: boolean } = {},
): void {
  goalStore.delete(sessionId);
  if (options.discardPersisted) removePersisted(sessionId);
}
