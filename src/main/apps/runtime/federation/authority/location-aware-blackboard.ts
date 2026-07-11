/**
 * Location-aware blackboard: a position-transparent decorator around the kernel
 * Blackboard (wired via `wrapBlackboard`). It keeps the team-tool call convention
 * free of any "local/remote" parameter — a member calls postTask/updateTask/
 * postFinding exactly as before, and this layer decides per office whether the
 * write applies locally (owned office) or routes to the office's host (shadow
 * office).
 *
 * Two office kinds, by store.getTeamById(teamId).hostNodeId:
 *   - OWNED (hostNodeId == null): delegate straight to the base blackboard; this
 *     node IS the single writer.
 *   - SHADOW (hostNodeId != null): this node only owns a brought member. It mints
 *     a stable id locally, optimistically applies the row to its own store (so
 *     the member sees its write immediately), and sends a blackboard-write to the
 *     host carrying {op, payload, fid}. The host applies the SAME id, so the
 *     host's apply and this optimistic apply converge idempotently. postTask/
 *     postFinding stay synchronous, returning the locally-generated id.
 *
 * Single-writer discipline holds: a shadow write's authoritative apply + seq
 * assignment happen on the host; the local optimistic copy is reconciled by
 * replication (same id → idempotent) and is never sequenced here.
 */

import { randomUUID } from 'crypto'
import type { NodeId } from '../types'
import type { ReplicationOp } from '../protocol-m2'
import type { TeamStore } from '../../../team'
import type {
  Blackboard,
  PostTaskInput,
  UpdateTaskInput,
  PostFindingInput,
} from '../../team/blackboard'
import type {
  BlackboardTask,
  BlackboardFinding,
  BlackboardSnapshot,
  TeamReadBoardFilter,
} from '../../../../../shared/apps/team-types'

const LOG_TAG = '[LocationAwareBlackboard]'

/** A blackboard write routed to an office's host (member → authority). */
export interface OutboundBlackboardWrite {
  teamId: string
  op: Extract<ReplicationOp, 'post_task' | 'update_task' | 'post_finding'>
  payload: Record<string, unknown>
  taskId?: string
  /** Cross-restart globally-unique idempotency key (matches host's log fid usage). */
  fid: string
}

export interface LocationAwareBlackboardDeps {
  /** The kernel blackboard for OWNED offices (delegate target). */
  base: Blackboard
  /** Store used to read host ownership + write the shadow optimistic copy. */
  store: TeamStore
  selfNodeId: NodeId
  /** Route a shadow office's write to its host (the office authority). */
  sendBlackboardWrite: (hostNodeId: NodeId, write: OutboundBlackboardWrite) => void
}

export function createLocationAwareBlackboard(deps: LocationAwareBlackboardDeps): Blackboard {
  const { base, store, sendBlackboardWrite } = deps

  function hostOf(teamId: string): NodeId | null {
    const team = store.getTeamById(teamId)
    return team?.hostNodeId ?? null
  }

  function postTask(input: PostTaskInput): { taskId: string } {
    const host = hostOf(input.teamId)
    if (host === null) return base.postTask(input)

    // Shadow office: own the id locally so the host applies the SAME id.
    const now = Date.now()
    const task: BlackboardTask = {
      id: randomUUID(),
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
    store.insertTask(task) // optimistic local apply (position transparency)
    sendBlackboardWrite(host, {
      teamId: input.teamId,
      op: 'post_task',
      payload: task as unknown as Record<string, unknown>,
      taskId: task.id,
      fid: randomUUID(),
    })
    console.log(`${LOG_TAG} shadow postTask team=${input.teamId} task=${task.id} → host=${host}`)
    return { taskId: task.id }
  }

  function updateTask(input: UpdateTaskInput): void {
    const host = hostOf(input.teamId)
    if (host === null) {
      base.updateTask(input)
      return
    }
    const now = Date.now()
    const patch = {
      status: input.status,
      ...(input.resultRef !== undefined ? { resultRef: input.resultRef } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
    }
    store.updateTask(input.taskId, patch, now) // optimistic local apply
    sendBlackboardWrite(host, {
      teamId: input.teamId,
      op: 'update_task',
      payload: { taskId: input.taskId, ...patch, updatedAt: now },
      taskId: input.taskId,
      fid: randomUUID(),
    })
    console.log(`${LOG_TAG} shadow updateTask team=${input.teamId} task=${input.taskId} → host=${host}`)
  }

  function postFinding(input: PostFindingInput): { findingId: string } {
    const host = hostOf(input.teamId)
    if (host === null) return base.postFinding(input)

    const finding: BlackboardFinding = {
      id: randomUUID(),
      teamId: input.teamId,
      epochId: input.epochId,
      authorAppId: input.callerAppId,
      body: input.content ?? null,
      ref: input.ref ?? null,
      createdAt: Date.now(),
    }
    store.insertFinding(finding) // optimistic local apply
    sendBlackboardWrite(host, {
      teamId: input.teamId,
      op: 'post_finding',
      payload: finding as unknown as Record<string, unknown>,
      fid: randomUUID(),
    })
    console.log(`${LOG_TAG} shadow postFinding team=${input.teamId} finding=${finding.id} → host=${host}`)
    return { findingId: finding.id }
  }

  function readBoard(
    teamId: string,
    epochId: string,
    callerAppId: string,
    filter?: TeamReadBoardFilter
  ): BlackboardSnapshot {
    // Reads always serve the local projection (owned store, or the shadow office's
    // replicated copy). Position-transparent: the reader is unaware which it is.
    return base.readBoard(teamId, epochId, callerAppId, filter)
  }

  return { postTask, updateTask, postFinding, readBoard }
}
