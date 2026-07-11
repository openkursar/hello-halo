/**
 * Blackboard replication: sits AROUND the kernel blackboard (never edits the
 * kernel write path). Implements the single-writer replication log with
 * acknowledged quorum commit, idempotent hot-standby apply, member→authority
 * write admission, and catch-up.
 *
 * Three roles, one factory (createReplication):
 *   - AUTHORITY: captureLocalWrite assigns a per-office monotonic seq, appends the
 *     durable log entry, fans it out as a `blackboard-replicate` frame, and
 *     advances `committedSeq` as acks arrive. Normal writes are optimistic (local
 *     apply already happened; commit advances in the background). Roster writes
 *     are synchronous-commit: replicateRoster() resolves only once the write
 *     reaches quorum (and bumps rosterEpoch); in a partition it never resolves as
 *     committed.
 *   - HOT-STANDBY: handleReplicate applies an entry to the local read-only replica
 *     idempotently — dedup by (officeId, seq) monotonic AND (officeId, fid) —
 *     then acks. handleAck (authority side) advances committed.
 *   - MEMBER→AUTHORITY: handleBlackboardWrite admits a member's write (stale-term
 *     + scope gate) and applies it through the injected kernel blackboard, which
 *     re-fires onWrite → captureLocalWrite, so member writes flow through the
 *     same single-writer log.
 *
 * Correctness invariants:
 *   - committedSeq advances to N iff a MAJORITY of online hot-standbys acked ≥ N
 *     AND the heir (online standby with the earliest joined_at) acked ≥ N. The
 *     heir-inclusion constraint is what makes a committed write survive a single
 *     planned handover, since election picks by joined_at, not log completeness.
 *   - A write applies AT MOST ONCE: (officeId, seq) gates monotonic apply and
 *     (officeId, fid) gates cross-path replays (retransmit / handover replay /
 *     tool retry). Both keys are checked before any store side effect.
 *
 * Dependencies are injected so this module never imports the election / handover
 * / coordinator modules. term + committedSeq state are injected (owned by
 * term-state); this module only reads/advances them through provided callbacks.
 */

import { randomUUID } from 'crypto'
import type { NodeId } from '../types'
import type {
  AckFrame,
  BlackboardReplicateFrame,
  BlackboardWriteFrame,
  Fid,
  M2Frame,
  RejectFrame,
  RejectReason,
  ReplicationOp,
} from '../protocol-m2'
import { createFidDedup } from '../protocol-m2'
import type { AuthorityStore, ReplicationLogEntry } from '../../../federation/types'
import type { TeamStore } from '../../../team'
import type { BlackboardWriteRecord } from '../../team/blackboard'
import type {
  BlackboardTask,
  BlackboardFinding,
  TaskStatus,
} from '../../../../../shared/apps/team-types'
import { SELF_NODE_ID } from '../../../../../shared/apps/team-types'

const LOG_TAG = '[Replication]'

// ── Constants ──

/** Wait this long for an `ack` after a `blackboard-replicate` before retransmit. */
export const REPLICATION_ACK_TIMEOUT_MS = 2000
/** Soft cap on log entries kept per office for incremental catch-up. */
export const REPLICATION_LOG_RETAIN = 10000
/** Max entries per catch-up batch, inside MAX_FRAME_BYTES. */
export const REPLICATION_CATCHUP_BATCH = 256

// ── Catch-up shapes ──

/** Full snapshot used when a standby's gap predates the retained log. */
export interface ReplicationSnapshot {
  tasks: BlackboardTask[]
  findings: BlackboardFinding[]
  roster: RosterEntry[]
  appliedSeq: number
  term: number
}

/** A roster row as carried in a snapshot / roster replication payload. */
export interface RosterEntry {
  appId: string
  memberName: string
  role: string
  isLead: boolean
  ownerNodeId: string
}

export type CatchupResult =
  | { mode: 'incremental'; entries: ReplicationLogEntry[] }
  | { mode: 'snapshot'; snapshot: ReplicationSnapshot }

// ── Member-write record passed to the authority's kernel apply ──

export interface MemberWriteRecord {
  teamId: string
  epochId: string
  op: 'post_task' | 'update_task' | 'post_finding'
  payload: Record<string, unknown>
  taskId?: string
}

export interface ReplicationDeps {
  officeId: string
  selfNodeId: NodeId
  /** Durable replication log + authority water marks (apps/federation). */
  authorityStore: AuthorityStore
  /** Local read-only replica a hot-standby applies entries to. */
  replicaStore: TeamStore
  send: (to: NodeId, frame: M2Frame) => void
  broadcast: (frame: M2Frame) => void
  now?: () => number
  // Injected term / committed-seq state (owned by term-state):
  getTerm: () => number
  getCommittedSeq: () => number
  setCommittedSeq: (seq: number) => void
  /** Online hot-standby node ids (the replication quorum denominator). */
  getOnlineStandbys: () => NodeId[]
  /** The deterministic heir: online standby with the earliest joined_at (null if none). */
  getHeir: () => NodeId | null
  /**
   * Count of KNOWN hot-standbys in the last-known roster (excluding self),
   * regardless of current reachability. Distinguishes a GENUINE single-node office
   * (count 0 → commit immediately) from a partitioned authority whose standbys are
   * known-but-offline (count > 0, no online acks → write stays UNcommitted, so a
   * later handover never loses it).
   *
   * REQUIRED: this is the fail-closed guard against an authority optimistically
   * committing an unreplicated write during a partition. There is no safe default
   * (a default of 0 would silently fail-OPEN and lose writes on handover), so every
   * caller must supply the real last-known-roster count.
   */
  getKnownStandbyCount: () => number
  /** Apply a member's admitted write through the authority's kernel blackboard. */
  applyMemberWrite?: (record: MemberWriteRecord) => void
  /** Scope admission gate for a member write. Default: allow. */
  admitMemberWrite?: (frame: BlackboardWriteFrame) => boolean
  /** Bumped + persisted when a roster write commits. Default: no-op. */
  bumpRosterEpoch?: () => void
  /**
   * Fired after a hot-standby applies a replicated task/finding to its replica
   * store, so the renderer refreshes live. NOT fired for roster ops (they
   * mutate no blackboard row). Default: no-op.
   */
  onReplicaApplied?: (info: { op: ReplicationOp; taskId?: string }) => void
}

export interface Replication {
  // ── AUTHORITY side ──
  /** Connect to onBlackboardWrite: sequence + log + fan-out a local write. */
  captureLocalWrite(record: BlackboardWriteRecord): void
  /**
   * Synchronous-commit a roster write: blocks (resolves) only once the write
   * reaches quorum (majority online standbys ∧ heir). In a partition it never
   * resolves committed — the returned promise resolves `false` on timeout.
   */
  replicateRoster(op: 'roster_join' | 'roster_leave', payload: Record<string, unknown>): Promise<boolean>

  // ── HOT-STANDBY side ──
  /** Idempotent (seq + fid) apply of a replicated entry to replicaStore, then ack. */
  handleReplicate(from: NodeId, frame: BlackboardReplicateFrame): void
  /** Advance committedSeq when quorum (online majority ∧ heir) has acked. */
  handleAck(from: NodeId, frame: AckFrame): void

  // ── MEMBER → AUTHORITY ──
  /** EPOCH_STALE check + scope admit + applyMemberWrite (re-enters captureLocalWrite). */
  handleBlackboardWrite(from: NodeId, frame: BlackboardWriteFrame): void

  // ── CATCH-UP ──
  buildCatchup(lastAckedSeq: number): CatchupResult

  /** Dispatch any M2 frame this layer owns, by frame.kind (Lead routes onM2Frame here). */
  handleM2Frame(from: NodeId, frame: M2Frame): void

  /** Highest seq this node has applied locally (replica or authority). */
  getAppliedSeq(): number
}

export function createReplication(deps: ReplicationDeps): Replication {
  const {
    officeId,
    selfNodeId,
    authorityStore,
    replicaStore,
    send,
    broadcast,
    getTerm,
    getCommittedSeq,
    setCommittedSeq,
    getOnlineStandbys,
    getHeir,
  } = deps
  const now = deps.now ?? (() => Date.now())
  const admitMemberWrite = deps.admitMemberWrite ?? (() => true)
  const bumpRosterEpoch = deps.bumpRosterEpoch ?? (() => {})
  const onReplicaApplied = deps.onReplicaApplied ?? (() => {})

  // No safe default for getKnownStandbyCount (see the deps doc above) — assert
  // at construction so a non-typed JS caller can't silently omit it and fail open.
  if (typeof deps.getKnownStandbyCount !== 'function') {
    throw new Error('Replication: getKnownStandbyCount is required (fail-closed quorum guard)')
  }

  // Cross-restart fid idempotency rides authorityStore.hasFid; this in-memory
  // dedup is the fast first-line guard for the live window (retransmits, replays).
  const fidDedup = createFidDedup()

  // One-shot hand-off of a member write's stable fid into the very next
  // captureLocalWrite. applyMemberWrite → kernel apply → onWrite → captureLocalWrite
  // is a synchronous call chain, so this is consumed before any other capture can
  // interleave. It lets a member write keep its ORIGINAL fid in the durable log,
  // so a cross-restart retry is caught by authorityStore.hasFid (a fresh
  // randomUUID per apply would defeat that and double-apply after a restart).
  let pendingMemberFid: Fid | null = null

  // Highest seq applied to the LOCAL replica (hot-standby side). On the authority
  // side, appliedSeq is the log max — both feed getAppliedSeq().
  let replicaAppliedSeq = 0

  // Per-node highest acked seq (not per-seq ack sets), recomputed into commit —
  // keeps tracking O(standbys) and monotone.
  const ackedSeqByNode = new Map<NodeId, number>()

  // Pending roster-write resolvers keyed by seq: resolved true on commit, false on
  // timeout (partition / insufficient quorum).
  const pendingRoster = new Map<number, { resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }>()

  function getAppliedSeq(): number {
    return Math.max(replicaAppliedSeq, authorityStore.getMaxSeq(officeId))
  }

  function reject(to: NodeId, reFid: Fid, reason: RejectReason): void {
    const frame: RejectFrame = {
      kind: 'reject',
      officeId,
      fromNode: selfNodeId,
      reFid,
      reason,
      retryable: reason === 'EPOCH_STALE',
      fid: randomUUID(),
    }
    send(to, frame)
  }

  // ── Quorum: majority of online standbys AND the heir ──

  function quorumReached(seq: number): boolean {
    const standbys = getOnlineStandbys()
    const heir = getHeir()
    if (standbys.length === 0) {
      // A genuine single-node office (no known standbys) commits immediately.
      // Standbys known-but-unreachable (partition) stay uncommitted — no replica
      // exists yet, and a later handover could lose the write.
      const known = deps.getKnownStandbyCount()
      return known === 0
    }

    let acks = 0
    for (const node of standbys) {
      if ((ackedSeqByNode.get(node) ?? 0) >= seq) acks++
    }
    const majority = Math.floor(standbys.length / 2) + 1
    const heirAcked = heir === null || (ackedSeqByNode.get(heir) ?? 0) >= seq
    return acks >= majority && heirAcked
  }

  /**
   * Advance committedSeq as far as the contiguous run of quorum-reached seqs
   * allows, starting just after the current committed water mark. Resolves any
   * pending roster writes that became committed.
   */
  function tryAdvanceCommit(): void {
    const maxSeq = authorityStore.getMaxSeq(officeId)
    let committed = getCommittedSeq()
    let advanced = false
    for (let seq = committed + 1; seq <= maxSeq; seq++) {
      if (!quorumReached(seq)) break
      committed = seq
      advanced = true
    }
    if (!advanced) return
    setCommittedSeq(committed)
    pendingRoster.forEach((pending, seq) => {
      if (seq <= committed) {
        clearTimeout(pending.timer)
        pendingRoster.delete(seq)
        bumpRosterEpoch()
        pending.resolve(true)
      }
    })
  }

  // ── Authority: append + fan-out one entry ──

  function appendAndBroadcast(
    op: ReplicationOp,
    payload: Record<string, unknown>,
    taskId: string | undefined,
    fid: Fid
  ): number {
    const seq = authorityStore.getMaxSeq(officeId) + 1
    const term = getTerm()
    const entry: ReplicationLogEntry = {
      officeId,
      seq,
      term,
      op,
      payload,
      fid,
      taskId: taskId ?? null,
      createdAt: now(),
    }
    authorityStore.appendLogEntry(entry)
    const frame: BlackboardReplicateFrame = {
      kind: 'blackboard-replicate',
      officeId,
      fromNode: selfNodeId,
      term,
      seq,
      op,
      payload,
      ...(taskId !== undefined ? { taskId } : {}),
      // Raft leaderCommit: tell standbys how far the log is committed so they can
      // enforce the election restriction after a handover.
      committedSeq: getCommittedSeq(),
      fid,
    }
    broadcast(frame)
    return seq
  }

  function captureLocalWrite(record: BlackboardWriteRecord): void {
    // A member write re-entering via applyMemberWrite carries its original fid;
    // a genuine authority-originated local write mints a fresh one.
    const fid = pendingMemberFid ?? randomUUID()
    pendingMemberFid = null
    const seq = appendAndBroadcast(record.op, record.payload, record.taskId, fid)
    // The authority is its own first durable copy → its applied water mark is the
    // log max. Optimistic: local apply already happened in the kernel; commit
    // advances in the background as acks arrive.
    console.log(`${LOG_TAG} captureLocalWrite office=${officeId} seq=${seq} op=${record.op}`)
    tryAdvanceCommit()
  }

  function replicateRoster(
    op: 'roster_join' | 'roster_leave',
    payload: Record<string, unknown>
  ): Promise<boolean> {
    const fid = randomUUID()
    const seq = appendAndBroadcast(op, payload, undefined, fid)
    console.log(`${LOG_TAG} replicateRoster office=${officeId} seq=${seq} op=${op}`)
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        // Partition / insufficient quorum: the write stays pending (NOT committed),
        // rosterEpoch is not bumped. The caller surfaces a neutral "temporarily
        // unavailable" to the user, with no technical leak in this layer.
        if (pendingRoster.has(seq)) {
          pendingRoster.delete(seq)
          console.warn(`${LOG_TAG} roster write seq=${seq} did not reach quorum (partition)`)
          resolve(false)
        }
      }, REPLICATION_ACK_TIMEOUT_MS)
      pendingRoster.set(seq, { resolve, timer })
      // It may already be committable (e.g. single-node office).
      tryAdvanceCommit()
    })
  }

  // ── Hot-standby: idempotent apply + ack ──

  /** Returns true when a blackboard row changed (task/finding), false for roster ops. */
  function applyToReplica(frame: BlackboardReplicateFrame): boolean {
    switch (frame.op) {
      case 'post_task':
        replicaStore.insertTask(frame.payload as unknown as BlackboardTask)
        return true
      case 'update_task': {
        const p = frame.payload as {
          taskId?: string
          status?: TaskStatus
          assigneeAppId?: string | null
          resultRef?: string | null
          note?: string | null
          updatedAt?: number
        }
        const taskId = frame.taskId ?? p.taskId
        if (taskId) {
          replicaStore.updateTask(
            taskId,
            {
              ...(p.status !== undefined ? { status: p.status } : {}),
              ...(p.assigneeAppId !== undefined ? { assigneeAppId: p.assigneeAppId } : {}),
              ...(p.resultRef !== undefined ? { resultRef: p.resultRef } : {}),
              ...(p.note !== undefined ? { note: p.note } : {}),
            },
            p.updatedAt ?? now()
          )
        }
        return true
      }
      case 'post_finding':
        replicaStore.insertFinding(frame.payload as unknown as BlackboardFinding)
        return true
      case 'roster_join':
      case 'roster_leave':
        // Roster replication mutates federation membership state, not the team
        // blackboard tables; the replica records it via the durable log only (the
        // authoritative roster projection is rebuilt on catch-up / handover).
        return false
    }
  }

  function handleReplicate(from: NodeId, frame: BlackboardReplicateFrame): void {
    if (frame.officeId !== officeId) return
    // EPOCH_STALE: a write from a sealed (older) tenure is rejected with no effect.
    if (frame.term < getTerm()) {
      reject(from, frame.fid, 'EPOCH_STALE')
      return
    }
    // Idempotent apply: (officeId, seq) monotonic AND (officeId, fid) dedup. Either
    // hit means we already applied this write → re-ack (ack may have been lost) but
    // do not re-apply.
    const duplicateBySeq = frame.seq <= replicaAppliedSeq
    const duplicateByFid = fidDedup.seen(frame.fromNode, frame.fid) || authorityStore.hasFid(officeId, frame.fid)
    if (duplicateBySeq || duplicateByFid) {
      sendAck(from, frame)
      return
    }
    // Persist to the local durable log too (so a standby promoted to authority can
    // serve catch-up + continue the seq), then apply to the read-only replica.
    authorityStore.appendLogEntry({
      officeId,
      seq: frame.seq,
      term: frame.term,
      op: frame.op,
      payload: frame.payload,
      fid: frame.fid,
      taskId: frame.taskId ?? null,
      createdAt: now(),
    })
    const rowChanged = applyToReplica(frame)
    replicaAppliedSeq = Math.max(replicaAppliedSeq, frame.seq)
    // A fresh task/finding landed on this standby's replica → signal the
    // renderer to refresh live (roster ops change no row, so they do not emit).
    if (rowChanged) {
      onReplicaApplied({ op: frame.op, ...(frame.taskId !== undefined ? { taskId: frame.taskId } : {}) })
    }
    // Learn the authority's committed water mark (Raft leaderCommit), capped at
    // what we have actually applied — a standby can never claim committed beyond
    // its own log. This is what later lets us veto a behind candidate at election.
    // committedSeq advances monotonically (setCommittedSeq guards).
    if (frame.committedSeq !== undefined) {
      setCommittedSeq(Math.min(frame.committedSeq, replicaAppliedSeq))
    }
    console.log(`${LOG_TAG} applied replicate office=${officeId} seq=${frame.seq} op=${frame.op}`)
    sendAck(from, frame)
  }

  function sendAck(to: NodeId, frame: BlackboardReplicateFrame): void {
    const ack: AckFrame = {
      kind: 'ack',
      officeId,
      fromNode: selfNodeId,
      reFid: frame.fid,
      ackedSeq: replicaAppliedSeq,
      fid: randomUUID(),
    }
    send(to, ack)
  }

  function handleAck(from: NodeId, frame: AckFrame): void {
    if (frame.officeId !== officeId) return
    if (frame.ackedSeq === undefined) return
    const prev = ackedSeqByNode.get(from) ?? 0
    if (frame.ackedSeq > prev) ackedSeqByNode.set(from, frame.ackedSeq)
    tryAdvanceCommit()
  }

  // ── Member → authority ──

  function handleBlackboardWrite(from: NodeId, frame: BlackboardWriteFrame): void {
    if (frame.officeId !== officeId) return
    if (frame.term < getTerm()) {
      reject(from, frame.fid, 'EPOCH_STALE')
      return
    }
    if (!admitMemberWrite(frame)) {
      reject(from, frame.fid, 'SCOPE_DENIED')
      return
    }
    // Cross-path dedup: a retry of an already-applied member write must not
    // double-apply (the fid is stable across the retry).
    if (fidDedup.seen(frame.fromNode, frame.fid) || authorityStore.hasFid(officeId, frame.fid)) {
      return
    }
    if (frame.op === 'roster_join' || frame.op === 'roster_leave') {
      // Roster writes are authority-internal (driven by join/leave), not member
      // blackboard writes; ignore them on this path.
      return
    }
    if (!deps.applyMemberWrite) return
    const payload = frame.payload
    const teamId = typeof payload.teamId === 'string' ? payload.teamId : officeId
    const epochId = typeof payload.epochId === 'string' ? payload.epochId : ''
    // Carry the member's stable fid into the next captureLocalWrite so the
    // durable log entry keys idempotency on it (for the cross-restart dedup path).
    pendingMemberFid = frame.fid
    // Apply through the authority's kernel blackboard, which re-fires onWrite →
    // captureLocalWrite, so the member write joins the single-writer log + fan-out.
    deps.applyMemberWrite({
      teamId,
      epochId,
      op: frame.op,
      payload,
      ...(frame.taskId !== undefined ? { taskId: frame.taskId } : {}),
    })
    // Defensive: if applyMemberWrite did not re-enter captureLocalWrite (e.g. a
    // future no-op apply), do not leak the fid into an unrelated later capture.
    pendingMemberFid = null
  }

  // ── Catch-up ──

  function buildCatchup(lastAckedSeq: number): CatchupResult {
    const minSeq = authorityStore.getMinSeq(officeId)
    // Gap predates the retained log (or the log was pruned) → full snapshot.
    if (minSeq > 0 && lastAckedSeq < minSeq - 1) {
      return { mode: 'snapshot', snapshot: buildSnapshot() }
    }
    const entries = authorityStore.listLogAfter(officeId, lastAckedSeq, REPLICATION_CATCHUP_BATCH)
    return { mode: 'incremental', entries }
  }

  function buildSnapshot(): ReplicationSnapshot {
    const tasks = replicaStore.listTasksByTeam(officeId)
    // Findings are per-epoch; gather across the office's tasks' epochs. The replica
    // mirrors the authority, so a per-team aggregation reconstructs the board.
    const findings: BlackboardFinding[] = []
    const epochs = Array.from(new Set(tasks.map((t) => t.epochId)))
    for (const epochId of epochs) {
      findings.push(...replicaStore.listFindingsByEpoch(officeId, epochId))
    }
    const members = replicaStore.listMembersByTeam(officeId)
    const roster: RosterEntry[] = members.map((m) => ({
      appId: m.appId,
      memberName: m.memberName,
      role: m.role,
      isLead: m.isLead,
      ownerNodeId: m.ownerNodeId ?? SELF_NODE_ID,
    }))
    return {
      tasks,
      findings,
      roster,
      appliedSeq: getAppliedSeq(),
      term: getTerm(),
    }
  }

  // ── Dispatch ──

  function handleM2Frame(from: NodeId, frame: M2Frame): void {
    switch (frame.kind) {
      case 'blackboard-replicate':
        handleReplicate(from, frame)
        break
      case 'ack':
        handleAck(from, frame)
        break
      case 'blackboard-write':
        handleBlackboardWrite(from, frame)
        break
      default:
        // Other M2 frames (authority/artifact) belong to other modules.
        break
    }
  }

  return {
    captureLocalWrite,
    replicateRoster,
    handleReplicate,
    handleAck,
    handleBlackboardWrite,
    buildCatchup,
    handleM2Frame,
    getAppliedSeq,
  }
}
