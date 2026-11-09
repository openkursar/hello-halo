/**
 * @module core/goal-reminders
 * Text the harness shows the model about the goal and open work.
 *
 * Everything here states facts the system knows for certain (the goal, the
 * todo counts, that the user edited something). Where the system cannot know
 * the right move — whether stopping was intended — the wording leaves the
 * decision to the model.
 * @license MIT
 */

import type { Goal } from '../types/goal.js';

export interface TodoSnapshot {
  content: string;
  status: string;
}

/** Plain-text rendering of a goal, shared by tool results and reminders. */
export function renderGoal(goal: Goal): string {
  const lines = [`Objective: ${goal.objective}`];
  if (goal.doneWhen.length > 0) {
    lines.push('Done when:', ...goal.doneWhen.map((c) => `- ${c}`));
  }
  lines.push(`Status: ${goal.status}`);
  return lines.join('\n');
}

function isOpen(todo: TodoSnapshot): boolean {
  return todo.status === 'pending' || todo.status === 'in_progress';
}

/** "3 of 7 completed; in progress: "X"" — or null without a list. */
function todoProgressLine(todos: TodoSnapshot[]): string | null {
  if (todos.length === 0) return null;
  const done = todos.filter((t) => t.status === 'completed').length;
  const current = todos.find((t) => t.status === 'in_progress');
  return current
    ? `Todo: ${done} of ${todos.length} completed; in progress: "${current.content}".`
    : `Todo: ${done} of ${todos.length} completed.`;
}

/** Goal recitation — after compaction, or when the goal has been out of view for a while. */
export function goalRecitationText(goal: Goal, todos: TodoSnapshot[] = []): string {
  const progress = todoProgressLine(todos);
  return [`Current goal:\n${renderGoal(goal)}`, progress].filter(Boolean).join('\n');
}

/** Tell the model the user changed the goal between turns. */
export function goalChangeNoticeText(previous: Goal | null, current: Goal | null): string {
  if (current === null) {
    return previous
      ? `The user removed the goal "${previous.objective}". It no longer applies.`
      : 'The user removed the goal. It no longer applies.';
  }
  const head = previous === null ? 'The user set a goal for this work.' : 'The user updated the goal.';
  const lines = [head, renderGoal(current)];
  if (previous && previous.objective !== current.objective) {
    lines.push(`Previous objective: ${previous.objective}`);
  }
  return lines.join('\n');
}

/**
 * The open-work check shown when the model ends its turn with the goal still
 * active or todo items unfinished. Null when nothing is open.
 */
export function openWorkCheckText(goal: Goal | null, todos: TodoSnapshot[]): string | null {
  const activeGoal = goal?.status === 'active' ? goal : null;
  const open = todos.filter(isOpen);
  if (!activeGoal && open.length === 0) return null;

  const parts: string[] = [];
  if (activeGoal) parts.push(`the goal "${activeGoal.objective}" is not marked complete`);
  if (open.length > 0) {
    const next = open.find((t) => t.status === 'in_progress') ?? open[0];
    parts.push(`${open.length} of ${todos.length} todo items are unfinished (next: "${next.content}")`);
  }

  return (
    `You ended your turn with work still open: ${parts.join(', and ')}.\n` +
    'This is a check, not an instruction to continue. If you stopped on purpose — the user asked you to ' +
    "stop here, you're waiting for their input, you're blocked, or the remaining items no longer apply — " +
    'say so in a sentence and update the goal or todo if they are out of date. If you stopped ' +
    'unintentionally, pick up where you left off.'
  );
}

/** Identity of the open-work state; the check fires once per distinct state. */
export function openWorkStateKey(goal: Goal | null, todos: TodoSnapshot[]): string {
  const activeGoal = goal?.status === 'active' ? goal : null;
  return JSON.stringify({
    goal: activeGoal ? [activeGoal.objective, activeGoal.doneWhen] : null,
    todos: todos.map((t) => [t.content, t.status]),
  });
}

/** The completion check shown once per turn when the host enables it. */
export const COMPLETION_CHECK_TEXT =
  'Before you finish, look back at what was asked in this turn. If something is still missing or ' +
  'unverified, continue. If everything is done, end without adding anything.';
