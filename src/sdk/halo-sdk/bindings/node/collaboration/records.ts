import type { TaskStatus } from './types.js';

export interface BlackboardTask {
  id: string
  teamId: string
  epochId: string
  title: string
  assigneeAppId: string | null
  status: TaskStatus
  /** File path to a produced artifact, not inline content. */
  resultRef: string | null
  note: string | null
  parentId: string | null
  createdByAppId: string
  createdAt: number
  updatedAt: number
}

export interface BlackboardFinding {
  id: string
  teamId: string
  epochId: string
  authorAppId: string
  body: string | null
  ref: string | null
  createdAt: number
}

// ── Activity (what actually happened, as opposed to what state things are in) ──

/**
 * What kind of coordination act an activity row records.
 *
 * Reads (`team_read_board`, `team_read_artifact`) are deliberately absent: they
 * change nothing, they are frequent, and a feed full of "X looked at the board"
 * pushes the acts that matter off the screen.
 */
export type TeamActivityKind =
  | 'message'
  | 'reply'
  | 'task_post'
  | 'task_update'
  | 'finding'
  | 'check_set'
  | 'check_stop'
  | 'run_end'
  | 'decision'

/**
 * The state an act recorded — one notion, read against the act's kind:
 *   a message  → 'sent' (accepted for delivery) or 'undelivered' (never arrived,
 *                which is the opposite of "no reply yet", not a flavour of it);
 *   a reply    → how the turn the message started ended;
 *   a task_update → the status the task was put into.
 */
export type TeamActivityStatus =
  | 'sent'
  | 'undelivered'
  | 'ok'
  | 'timeout'
  | 'error'
  | 'escalation'
  | TaskStatus

/**
 * One recorded coordination act. Append-only: a reply is a NEW row pointing back
 * at the message it answers (`correlationId`), never an edit of that message —
 * so the stream stays immutable, replicates as a single idempotent insert, and
 * needs no pre-image to roll back.
 *
 * The team's directed messages exist nowhere else as messages: each one only
 * passes through the sender's transcript (as a tool argument) and the receiver's
 * (as a turn input), on machines that may not be the same. This table is the
 * only place the office's own record of "who contacted whom" lives.
 */
export interface TeamActivity {
  id: string
  teamId: string
  epochId: string
  kind: TeamActivityKind
  /** Who acted. */
  actorAppId: string
  /** Who it was aimed at (message/reply/check); null for board writes. */
  targetAppId: string | null
  /** One line, already human-readable — what a feed row and a digest line show. */
  subject: string
  /** Full text, kept for detail-on-demand. Never rendered in a list or a digest. */
  body: string | null
  /** The task / finding / check / message id this act concerns. */
  refId: string | null
  /** Ties a reply to the message that caused it. */
  correlationId: string | null
  status: TeamActivityStatus | null
  createdAt: number
}

