/**
 * @module types/goal
 * The session goal — what the current work must achieve and how to tell it is done.
 *
 * One goal per session. The model sets and maintains it through the Goal tool;
 * the host can seed it (`Options.goal`), read it, edit it, or clear it on the
 * user's behalf. Unlike conversation history it is never summarized away.
 * @license MIT
 */

/** Lifecycle of a goal. Only an `active` goal steers the loop. */
export type GoalStatus = 'active' | 'complete' | 'abandoned';

/** Who made the most recent change: the model via the Goal tool, or the host on the user's behalf. */
export type GoalChangeSource = 'agent' | 'user';

export interface Goal {
  /** What the work must achieve, in the user's terms. */
  objective: string;
  /** Checkable criteria that together mean the objective is met. */
  doneWhen: string[];
  status: GoalStatus;
  /** Optional context recorded with the latest change (e.g. why it was completed or abandoned). */
  note?: string;
  updatedBy: GoalChangeSource;
  /** ISO-8601 timestamp of the latest change. */
  updatedAt: string;
}

/** Host-supplied goal: seeds a session (`Options.goal`) or replaces the current one (`setGoal`). */
export interface GoalInput {
  objective: string;
  doneWhen?: string[];
}

/** Which end-of-turn checks the loop runs when the model stops on its own. */
export interface TurnEndChecks {
  /**
   * When the model ends its turn while the goal is still active or todo items
   * are unfinished, remind it once per unchanged state and let it decide
   * whether to continue. Default: true.
   */
  openWork?: boolean;
  /**
   * After every natural end of turn, ask the model once to confirm nothing
   * requested is still missing. Costs an extra model call per turn.
   * Default: false.
   */
  completion?: boolean;
}
