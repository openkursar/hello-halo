import { randomUUID } from 'node:crypto';
import { CollaborationRefusal } from './errors.js';
import type { TaskStatus } from './types.js';
import type { BlackboardTask, BlackboardFinding, TeamActivity, TeamActivityKind, TeamActivityStatus } from './records.js';

export interface PostTaskInput {
  teamId: string
  epochId: string
  callerAppId: string
  title: string
  assigneeAppId: string | null
  parentId?: string
}

export interface UpdateTaskInput {
  teamId: string
  epochId: string
  taskId: string
  status: TaskStatus
  resultRef?: string
  note?: string
  /**
   * The member moving the task — not necessarily its assignee. The office admits
   * a write from another machine only when it names a member that machine owns,
   * so an update with no author is refused outright on any machine that owns more
   * than one member. Absent only for the authority's own maintenance writes,
   * which never cross that gate.
   */
  callerAppId?: string
}

export interface PostFindingInput {
  teamId: string
  epochId: string
  callerAppId: string
  content?: string
  ref?: string
}

/**
 * Which publication form is claiming a ref, so the board can name the app that
 * will OWN it: a finding belongs to its author, a task's resultRef to the
 * ASSIGNEE — who may not be the member calling the tool.
 */
export type PublishedRefClaim =
  | { kind: 'finding'; authorAppId: string }
  | { kind: 'task'; taskId: string }

/** The teammate already publishing a ref someone else is about to claim. */
export interface PublishedRefConflict {
  memberName: string
}

/**
 * One coordination act to record. `id` may be supplied by a caller that already
 * owns a stable identifier (the message bus mints an envelope id before the act
 * is recorded), so the recorded row and the thing it describes share one key.
 */
export interface PostActivityInput {
  teamId: string
  epochId: string
  kind: TeamActivityKind
  actorAppId: string
  targetAppId?: string | null
  subject: string
  body?: string | null
  refId?: string | null
  correlationId?: string | null
  status?: TeamActivityStatus | null
  id?: string
}

export interface BlackboardWriteRecord {
  teamId: string
  epochId: string
  op:
    | 'post_task'
    | 'update_task'
    | 'post_finding'
    | 'post_activity'
    | 'epoch_upsert'
    | 'member_profile'
    | 'participant_upsert'
    | 'check_upsert'
    | 'check_delete'
  payload: Record<string, unknown>
  taskId?: string
}

export interface BlackboardWriteStore {
  insertTask(task: BlackboardTask): void;
  getTaskById(id: string): BlackboardTask | null;
  updateTask(id: string, patch: Partial<Pick<BlackboardTask, 'status' | 'resultRef' | 'note'>>, now: number): void;
  insertFinding(finding: BlackboardFinding): void;
  insertActivity(activity: TeamActivity): void;
}

export type BlackboardChange = { teamId: string; epochId: string } & (
  | { kind: 'task'; task: BlackboardTask }
  | { kind: 'finding'; finding: BlackboardFinding }
  | { kind: 'activity'; activity: TeamActivity }
);

export interface BlackboardWriterOptions {
  store: BlackboardWriteStore;
  onChange?: (change: BlackboardChange) => void;
  onWrite?: (record: BlackboardWriteRecord) => void;
  clock?: () => number;
  createId?: () => string;
}

/** Writes commit to the host's store before observers or replication are notified. */
export function createBlackboardWriter(options: BlackboardWriterOptions) {
  const { store } = options;
  const clock = options.clock ?? Date.now;
  const createId = options.createId ?? randomUUID;
  function emit(change: BlackboardChange): void {
    try { options.onChange?.(change); } catch (error) {
      console.error(`[Blackboard] Observer failed after write: team=${change.teamId} epoch=${change.epochId} kind=${change.kind}`, error);
    }
  }
  function notifyWrite(record: BlackboardWriteRecord): void {
    try { options.onWrite?.(record); } catch (error) {
      console.error(`[Blackboard] Replication observer failed after write: team=${record.teamId} epoch=${record.epochId} op=${record.op}`, error);
    }
  }
  function postTask(input: PostTaskInput): { taskId: string } {
    if (input.parentId) {
      const parent = store.getTaskById(input.parentId)
      if (!parent || parent.teamId !== input.teamId || parent.epochId !== input.epochId) {
        throw new CollaborationRefusal('task_parent_scope', 'The parent task is not in this collaboration.', {
          teamId: input.teamId, epochId: input.epochId, taskId: input.parentId,
        })
      }
    }
    const now = clock()
    const task: BlackboardTask = {
      id: createId(),
      teamId: input.teamId,
      epochId: input.epochId,
      title: input.title,
      assigneeAppId: input.assigneeAppId,
      status: 'pending',
      resultRef: null,
      note: null,
      parentId: input.parentId ?? null,
      createdByAppId: input.callerAppId,
      createdAt: now,
      updatedAt: now,
    }
    store.insertTask(task)
    emit({ teamId: input.teamId, epochId: input.epochId, kind: 'task', task })
    notifyWrite({
      teamId: input.teamId,
      epochId: input.epochId,
      op: 'post_task',
      payload: task as unknown as Record<string, unknown>,
      taskId: task.id,
    })
    return { taskId: task.id }
  }

  function updateTask(input: UpdateTaskInput): void {
    const before = store.getTaskById(input.taskId)
    if (!before || before.teamId !== input.teamId || before.epochId !== input.epochId) {
      throw new CollaborationRefusal('task_update_scope', 'The task is not in this collaboration.', {
        teamId: input.teamId, epochId: input.epochId, taskId: input.taskId,
      })
    }
    const now = clock()
    store.updateTask(
      input.taskId,
      {
        status: input.status,
        ...(input.resultRef !== undefined ? { resultRef: input.resultRef } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
      },
      now
    )
    const task = store.getTaskById(input.taskId)
    if (task) emit({ teamId: input.teamId, epochId: input.epochId, kind: 'task', task })
    notifyWrite({
      teamId: input.teamId,
      epochId: input.epochId,
      op: 'update_task',
      payload: {
        taskId: input.taskId,
        status: input.status,
        ...(input.resultRef !== undefined ? { resultRef: input.resultRef } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        updatedAt: now,
      },
      taskId: input.taskId,
    })
  }

  function postFinding(input: PostFindingInput): { findingId: string } {
    const finding: BlackboardFinding = {
      id: createId(),
      teamId: input.teamId,
      epochId: input.epochId,
      authorAppId: input.callerAppId,
      body: input.content ?? null,
      ref: input.ref ?? null,
      createdAt: clock(),
    }
    store.insertFinding(finding)
    emit({ teamId: input.teamId, epochId: input.epochId, kind: 'finding', finding })
    notifyWrite({
      teamId: input.teamId,
      epochId: input.epochId,
      op: 'post_finding',
      payload: finding as unknown as Record<string, unknown>,
    })
    return { findingId: finding.id }
  }

  function postActivity(input: PostActivityInput): { activityId: string } {
    const activity: TeamActivity = {
      id: input.id ?? createId(),
      teamId: input.teamId,
      epochId: input.epochId,
      kind: input.kind,
      actorAppId: input.actorAppId,
      targetAppId: input.targetAppId ?? null,
      subject: input.subject,
      body: input.body ?? null,
      refId: input.refId ?? null,
      correlationId: input.correlationId ?? null,
      status: input.status ?? null,
      createdAt: clock(),
    }
    store.insertActivity(activity)
    emit({ teamId: input.teamId, epochId: input.epochId, kind: 'activity', activity })
    notifyWrite({
      teamId: input.teamId,
      epochId: input.epochId,
      op: 'post_activity',
      payload: activity as unknown as Record<string, unknown>,
    })
    return { activityId: activity.id }
  }

  return { postTask, updateTask, postFinding, postActivity };
}
