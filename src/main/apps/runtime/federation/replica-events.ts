/**
 * Projects what one hot-standby apply pass changed into renderer board events.
 *
 * A replicated row is merged by the renderer as a `team:blackboard` delta, never
 * turned into a whole-board refetch. A refresh (`team:updated`) is reserved for
 * structural change — a new or changed epoch, a snapshot replace — and for a
 * catch-up page carrying more rows than are worth sending one by one.
 */

import type { BlackboardFinding, BlackboardTask, TeamActivity, TeamBlackboardEvent, TeamUpdatedChange } from '../../../../shared/apps/team-types'
import type { ReplicaAppliedBatch } from './authority/replication'

/** Above this many rows in one pass, one refresh is cheaper than a delta per row. */
export const REPLICA_ROW_EVENTS_MAX = 16

export interface ReplicaProjection {
  boardEvents: TeamBlackboardEvent[]
  /** Emit one `team:updated` for this office (and send no board events). */
  refresh: boolean
  /** What that refresh covers; null → everything (a snapshot replaced the replica). */
  changed: TeamUpdatedChange[] | null
  /** Epochs whose row was replicated; the caller applies their closed state locally. */
  epochIds: string[]
}

export function projectReplicaApplied(
  officeId: string,
  applied: ReplicaAppliedBatch,
  getTaskById: (taskId: string) => BlackboardTask | null
): ReplicaProjection {
  const boardEvents: TeamBlackboardEvent[] = []
  const epochIds: string[] = []
  let refresh = applied.snapshot
  let epochChanged = false
  for (const entry of applied.entries) {
    switch (entry.op) {
      case 'epoch_upsert':
        refresh = true
        epochChanged = true
        if (entry.taskId) epochIds.push(entry.taskId)
        break
      case 'post_task':
      case 'update_task': {
        // The replica merges a task update into its row, so the merged row is what the
        // renderer must see, not the partial payload.
        const taskId = entry.taskId ?? (entry.payload.taskId as string | undefined) ?? (entry.payload.id as string | undefined)
        const task = taskId ? getTaskById(taskId) : null
        if (task) boardEvents.push({ teamId: officeId, epochId: task.epochId, kind: 'task', task })
        break
      }
      case 'post_finding': {
        const finding = entry.payload as unknown as BlackboardFinding
        boardEvents.push({ teamId: officeId, epochId: finding.epochId, kind: 'finding', finding })
        break
      }
      case 'post_activity': {
        const activity = entry.payload as unknown as TeamActivity
        boardEvents.push({ teamId: officeId, epochId: activity.epochId, kind: 'activity', activity })
        break
      }
      default:
        break
    }
  }
  if (boardEvents.length > REPLICA_ROW_EVENTS_MAX) refresh = true
  // Board rows feed the task list's counts, so a board refresh reloads it too.
  const changed: TeamUpdatedChange[] | null = applied.snapshot
    ? null
    : epochChanged
      ? ['board', 'epochs', 'conversations']
      : ['board', 'conversations']
  return { boardEvents: refresh ? [] : boardEvents, refresh, changed, epochIds }
}
