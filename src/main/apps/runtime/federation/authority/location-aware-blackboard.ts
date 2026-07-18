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

/** A shadow write unconfirmed (neither replicated back nor rejected) this long is
 *  treated as lost — its optimistic row is rolled back, not assumed a success. */
const SHADOW_WRITE_TTL_MS = 30_000
/** Cap resends of one write so a persistently-rejecting authority can't loop. */
const SHADOW_WRITE_MAX_RESENDS = 3

interface PendingShadowWrite {
  resend: () => void
  /** Undo the optimistic local apply (delete an insert, restore an update's
   *  pre-image) so a definitively-rejected write does not diverge the board. */
  rollback: () => void
  /** Surface the discard to the user (deps.onWriteDiscarded) — a rolled-back
   *  write must never be silent: the writer saw the row land optimistically. */
  notifyDiscarded?: () => void
  attempts: number
  timer: ReturnType<typeof setTimeout>
}

/**
 * Shadow writes awaiting the host's verdict, keyed by fid. A blackboard-write is
 * fire-and-forget; the ONLY negative signal is a reject frame. Without consuming
 * it, a write refused mid-handover (EPOCH_STALE) was silently lost and the local
 * optimistic row diverged from the authority forever. This registry lets the
 * manager route a reject back here (handleShadowWriteReject) to resend or roll
 * back. Module-level: one blackboard per node, and fids are globally unique.
 */
const pendingShadowWrites = new Map<string, PendingShadowWrite>()

function clearPendingShadowWrite(fid: string): void {
  const p = pendingShadowWrites.get(fid)
  if (p) {
    clearTimeout(p.timer)
    pendingShadowWrites.delete(fid)
  }
}

/**
 * Positive ack: the authority committed this write and replicated it back (the
 * commit carries the member's ORIGINAL fid), so stop tracking it — it is
 * confirmed and must not later hit the unconfirmed-rollback backstop. Routed from
 * replication's apply path; a no-op for a fid this node never authored.
 */
export function confirmShadowWrite(fid: string): void {
  clearPendingShadowWrite(fid)
}

/**
 * A shadow write that within the TTL neither confirmed (replicated back) nor
 * rejected: the authority most likely never received it (the write frame was
 * lost). It was NOT silently a success — roll back the optimistic local row so the
 * board reflects authority truth instead of a phantom row teammates never see.
 * Safe against a merely-slow replication: a late catch-up re-applies the committed
 * write idempotently, so the row reappears if it did in fact land.
 */
function rollbackUnconfirmedShadowWrite(fid: string): void {
  const pending = pendingShadowWrites.get(fid)
  if (!pending) return
  console.warn(
    `${LOG_TAG} shadow write unconfirmed within ${SHADOW_WRITE_TTL_MS}ms fid=${fid}; rolling back optimistic row`
  )
  pending.rollback()
  pending.notifyDiscarded?.()
  pendingShadowWrites.delete(fid)
}

/**
 * Consume a host's reject of a shadow blackboard-write (routed by the manager).
 * EPOCH_STALE is retryable — a write sent during a handover: resend it to the
 * re-resolved authority with its ORIGINAL fid (the host dedups any overlap), so
 * it is not silently lost. A definitive (non-retryable, e.g. scope) reject means
 * the authority will NEVER accept this write, so its optimistic local row must be
 * rolled back — otherwise it diverges from authority truth forever (replication
 * only carries APPLIED writes, so a never-applied row is never corrected). A
 * retryable reject that exhausts its resend cap is left in place: a handover is
 * still settling and a later catch-up/snapshot reconciles it.
 */
export function handleShadowWriteReject(fid: string, retryable: boolean): void {
  const pending = pendingShadowWrites.get(fid)
  if (!pending) return
  if (retryable && pending.attempts < SHADOW_WRITE_MAX_RESENDS) {
    console.warn(`${LOG_TAG} shadow write rejected (retryable); resending fid=${fid} attempt=${pending.attempts + 1}`)
    pending.resend()
  } else {
    if (retryable) {
      console.warn(`${LOG_TAG} shadow write reject: resend cap reached fid=${fid}; leaving for reconcile`)
    } else {
      console.warn(`${LOG_TAG} shadow write rejected (non-retryable) fid=${fid}; rolling back optimistic row`)
      pending.rollback()
      pending.notifyDiscarded?.()
    }
    clearPendingShadowWrite(fid)
  }
}

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
  /**
   * Partition write gate: whether the office is currently PAUSED on this node
   * (partition minority / authority loss with no elected successor). While
   * paused, shadow writes are refused with a calm retryable error instead of
   * being optimistically applied — a paused side must not accumulate divergent
   * local rows that a later convergence would have to discard. Reads stay open
   * (the local replica remains the read projection). Absent → never paused.
   */
  isOfficePaused?: (teamId: string) => boolean
  /**
   * An optimistic shadow write was rolled back (lost in transit past the TTL,
   * or definitively rejected by the authority). The writer's user saw the row
   * land — bootstrap maps this to a UI signal so the undo is never silent.
   * Absent → rollback still happens, log-only.
   */
  onWriteDiscarded?: (teamId: string) => void
}

/**
 * Calm, retryable refusal for writes during a pause. Surfaces to the AGENT as
 * a tool error; deliberately position-free (no partition/authority/node words)
 * per the product's no-technical-leakage rule.
 */
const SYNC_PENDING_MESSAGE =
  'The shared board is syncing right now. Please try this write again in a moment.'

export function createLocationAwareBlackboard(deps: LocationAwareBlackboardDeps): Blackboard {
  const { base, store, sendBlackboardWrite } = deps

  function hostOf(teamId: string): NodeId | null {
    const team = store.getTeamById(teamId)
    return team?.hostNodeId ?? null
  }

  /**
   * Send a shadow write to its host and track it by fid so a reject can resend or
   * roll it back. Each attempt re-resolves the host (a handover may have moved
   * authority) and keeps the ORIGINAL fid so the host dedups any overlap. The
   * `rollback` undoes the caller's optimistic local apply on a definitive reject.
   */
  function emitShadowWrite(
    teamId: string,
    host: NodeId,
    write: OutboundBlackboardWrite,
    rollback: () => void,
    attempt = 1
  ): void {
    sendBlackboardWrite(host, write)
    const prev = pendingShadowWrites.get(write.fid)
    if (prev) clearTimeout(prev.timer)
    const timer = setTimeout(() => rollbackUnconfirmedShadowWrite(write.fid), SHADOW_WRITE_TTL_MS)
    if (typeof timer.unref === 'function') timer.unref()
    pendingShadowWrites.set(write.fid, {
      attempts: attempt,
      timer,
      rollback,
      notifyDiscarded: deps.onWriteDiscarded ? () => deps.onWriteDiscarded!(teamId) : undefined,
      resend: () => {
        const nextHost = hostOf(teamId)
        if (nextHost) emitShadowWrite(teamId, nextHost, write, rollback, attempt + 1)
        else clearPendingShadowWrite(write.fid)
      },
    })
  }

  /** Refuse a shadow write while the office is paused (see isOfficePaused). */
  function assertWritable(teamId: string): void {
    if (deps.isOfficePaused?.(teamId)) {
      console.warn(`${LOG_TAG} write refused while office paused team=${teamId}`)
      throw new Error(SYNC_PENDING_MESSAGE)
    }
  }

  function postTask(input: PostTaskInput): { taskId: string } {
    const host = hostOf(input.teamId)
    if (host === null) return base.postTask(input)
    assertWritable(input.teamId)

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
    emitShadowWrite(
      input.teamId,
      host,
      {
        teamId: input.teamId,
        op: 'post_task',
        payload: task as unknown as Record<string, unknown>,
        taskId: task.id,
        fid: randomUUID(),
      },
      () => store.deleteTask(task.id) // rollback: undo the optimistic insert
    )
    console.log(`${LOG_TAG} shadow postTask team=${input.teamId} task=${task.id} → host=${host}`)
    return { taskId: task.id }
  }

  function updateTask(input: UpdateTaskInput): void {
    const host = hostOf(input.teamId)
    if (host === null) {
      base.updateTask(input)
      return
    }
    assertWritable(input.teamId)
    const now = Date.now()
    const patch = {
      status: input.status,
      ...(input.resultRef !== undefined ? { resultRef: input.resultRef } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
    }
    // Capture the pre-image BEFORE the optimistic apply so a definitive reject can
    // restore the exact prior field values (an update has no delete to undo it).
    const preImage = store.getTaskById(input.taskId)
    store.updateTask(input.taskId, patch, now) // optimistic local apply
    emitShadowWrite(
      input.teamId,
      host,
      {
        teamId: input.teamId,
        op: 'update_task',
        payload: { taskId: input.taskId, ...patch, updatedAt: now },
        taskId: input.taskId,
        fid: randomUUID(),
      },
      () => {
        // rollback: restore the pre-image fields; if the task did not exist
        // before, the optimistic update was a no-op so there is nothing to undo.
        if (!preImage) return
        store.updateTask(
          input.taskId,
          { status: preImage.status, resultRef: preImage.resultRef, note: preImage.note },
          preImage.updatedAt
        )
      }
    )
    console.log(`${LOG_TAG} shadow updateTask team=${input.teamId} task=${input.taskId} → host=${host}`)
  }

  function postFinding(input: PostFindingInput): { findingId: string } {
    const host = hostOf(input.teamId)
    if (host === null) return base.postFinding(input)
    assertWritable(input.teamId)

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
    emitShadowWrite(
      input.teamId,
      host,
      {
        teamId: input.teamId,
        op: 'post_finding',
        payload: finding as unknown as Record<string, unknown>,
        fid: randomUUID(),
      },
      () => store.deleteFinding(finding.id) // rollback: undo the optimistic insert
    )
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
