/**
 * Programmable multi-node fault-injection rig for federation tests.
 *
 * Every node runs a real FederationCoordinator + OfficeAuthority (createFederation-
 * Coordinator, createOfficeAuthority — no product code is modified) over a
 * controllable transport with programmable PARTITION/HEAL, node KILL/REVIVE, and
 * packet LOSS/DELAY/REORDER. Presence transitions come from real heartbeat frames
 * starved or delivered over that transport and measured against an injected
 * monotonic clock, not from direct injection into the authority.
 *
 * Determinism contract: a single logical clock drives everything. advance(ms) moves
 * it; tick() sweeps every FSM, flush() drains due transport frames and election
 * timers, beat() broadcasts a heartbeat round. The coordinator/election
 * schedule/jitter/now/monotonicNow seams are all wired to this clock, so no
 * wall-clock timer ever fires inside a test.
 */

import { vi } from 'vitest'
import { createDatabaseManager } from '../../../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../../../src/main/platform/store/types'
import { FederationStore } from '../../../../../../src/main/apps/federation/store'
import { AuthorityStore } from '../../../../../../src/main/apps/federation/authority-store'
import {
  MIGRATION_NAMESPACE as FED_NS,
  migrations as fedMigrations,
} from '../../../../../../src/main/apps/federation/migrations'
import { TeamStore } from '../../../../../../src/main/apps/team/store'
import {
  MIGRATION_NAMESPACE as TEAM_NS,
  migrations as teamMigrations,
} from '../../../../../../src/main/apps/team/migrations'
import { createFederationCoordinator } from '../../../../../../src/main/apps/runtime/federation/coordinator'
import type {
  FederationCoordinator,
  NodeBoundMember,
} from '../../../../../../src/main/apps/runtime/federation/coordinator'
import {
  createOfficeAuthority,
  type OfficeAuthority,
} from '../../../../../../src/main/apps/runtime/federation/authority/office-authority'
import type { OwnerStatus } from '../../../../../../src/main/apps/runtime/federation/authority/reconcile'
import type { MemberWriteRecord } from '../../../../../../src/main/apps/runtime/federation/authority/replication'
import type { FederationMessage } from '../../../../../../src/main/apps/runtime/federation/types'
import { DEFAULT_OFFICE_SCOPE } from '../../../../../../src/main/apps/federation/types'
import type { BlackboardTask } from '../../../../../../src/shared/apps/team-types'

export const RIG_OFFICE = 'office-rig'
export const RIG_EPOCH = 'epoch-1'

// Presence thresholds for the fake clock; must keep suspect < confirmed.
export const SUSPECT_MS = 6_000
export const CONFIRMED_MS = 13_000

export interface RigNode {
  id: string
  dbm: DatabaseManager
  fed: FederationStore
  auth: AuthorityStore
  team: TeamStore
  coordinator: FederationCoordinator
  office: OfficeAuthority
  /** Records the term argument each time onBecomeAuthority fires. */
  becameAuthority: ReturnType<typeof vi.fn>
  /** Spy for the reassignTask callback. */
  reassigned: ReturnType<typeof vi.fn>
  /** owner-status oracle the test can mutate per appId (drives reconcile). */
  ownerStatus: Map<string, OwnerStatus>
}

export interface RigOptions {
  /** Node ids; index = join order (joined_at = index+1). ids[0] starts as authority@term1. */
  ids: string[]
  /** Default owner status for any appId not explicitly set on a node. Default 'idle'. */
  defaultOwnerStatus?: OwnerStatus
}

interface QueuedFrame {
  from: string
  to: string
  frame: FederationMessage
  dueAt: number
  seq: number
}

export interface FaultCluster {
  nodes: Record<string, RigNode>
  ids: string[]

  // ── clock ──
  clock: () => number
  advance: (ms: number) => void
  /**
   * Advance only the WALL clock while leaving the monotonic clock frozen, to
   * simulate a host suspend/resume: on resume wall delta >> monotonic delta, which
   * the FSM's resume-grace guard must absorb without confirming healthy peers
   * offline.
   */
  advanceWallOnly: (ms: number) => void

  // ── pumps ──
  tick: () => void
  flush: () => void
  beat: () => void

  // ── fault knobs ──
  kill: (id: string) => void
  revive: (id: string) => void
  partition: (cells: string[][]) => void
  heal: () => void
  setLoss: (p: number) => void
  setDelay: (ms: number) => void
  setReorder: (on: boolean) => void

  // ── probes ──
  committedWriteAuthorityCount: () => number
  taskIdsByNode: () => Record<string, string[]>
  appliedSeqByNode: () => Record<string, number>
  offlineSeenBy: (observer: string) => string[]

  dispose: () => void
}

export function task(
  id: string,
  assignee: string | null = null,
  status: BlackboardTask['status'] = 'pending'
): BlackboardTask {
  return {
    id,
    teamId: RIG_OFFICE,
    epochId: RIG_EPOCH,
    title: id,
    assigneeAppId: assignee,
    status,
    resultRef: null,
    note: null,
    parentId: null,
    createdByAppId: 'lead',
    createdAt: 0,
    updatedAt: 0,
  }
}

export function buildCluster(opts: RigOptions): FaultCluster {
  const ids = opts.ids
  const defaultOwner: OwnerStatus = opts.defaultOwnerStatus ?? 'idle'
  const joinedAt: Record<string, number> = {}
  ids.forEach((id, i) => (joinedAt[id] = i + 1))

  // ── logical clock ──
  let wall = 1_000_000
  let mono = 1_000_000
  const now = () => wall
  const monotonicNow = () => mono

  // ── fault state ──
  const dead = new Set<string>()
  let cellOf: Record<string, number> = {}
  ids.forEach((id) => (cellOf[id] = 0))
  let loss = 0
  let delayMs = 0
  let reorder = false

  const canTalk = (a: string, b: string) =>
    !dead.has(a) && !dead.has(b) && cellOf[a] === cellOf[b]

  // ── inbound handlers (each coordinator registers via link.onMessage) ──
  const inboundHandlers = new Map<string, (from: string, msg: FederationMessage) => void>()

  // ── clock-driven timers (election back-off rides these, not setTimeout) ──
  interface ClockTimer {
    fireAt: number
    fn: () => void
    cancelled: boolean
  }
  const timers: ClockTimer[] = []
  function scheduleOnClock(ms: number, fn: () => void): () => void {
    const timer: ClockTimer = { fireAt: wall + ms, fn, cancelled: false }
    timers.push(timer)
    return () => {
      timer.cancelled = true
    }
  }

  // ── transport queue (delay/reorder) ──
  const queue: QueuedFrame[] = []
  let seqCounter = 0

  // During a tick()'s sweep loop every node advances its FSM "at the same instant"
  // on its own timer. To model that, frames a sweep emits (presence-update offline
  // fan-out) are buffered and delivered only AFTER every node has swept — otherwise
  // the first node to confirm a peer offline would synchronously project that
  // offline onto a same-cell observer (applyRemoteOffline: unblock only, no
  // store-row mutation), making the observer skip the peer in its own sweep and
  // never record the transition. Buffered frames are drained by the trailing flush.
  let sweepPhase = false

  // Deterministic LCG for the loss knob (no Math.random in tests).
  let lossState = 0x2545f491
  const lossRoll = (): number => {
    lossState = (lossState * 1103515245 + 12345) & 0x7fffffff
    return lossState / 0x7fffffff
  }

  const deliverNow = (from: string, to: string, frame: FederationMessage): void => {
    if (!canTalk(from, to)) return
    if (dead.has(to)) return
    inboundHandlers.get(to)?.(from, frame)
  }

  const route = (from: string, to: string, frame: FederationMessage): void => {
    if (!canTalk(from, to)) return
    if (loss > 0 && lossRoll() < loss) return
    if (sweepPhase) {
      // Buffer until the sweep loop completes; due immediately so the trailing
      // flush delivers it this same tick (no wall advance needed).
      queue.push({ from, to, frame, dueAt: wall, seq: seqCounter++ })
      return
    }
    if (delayMs <= 0 && !reorder) {
      deliverNow(from, to, frame)
      return
    }
    queue.push({ from, to, frame, dueAt: wall + delayMs, seq: seqCounter++ })
  }

  const routeBroadcast = (from: string, frame: FederationMessage): void => {
    if (dead.has(from)) return
    for (const id of ids) {
      if (id === from) continue
      route(from, id, frame)
    }
  }

  const registry = new Map<string, RigNode>()

  for (const id of ids) {
    const dbm = createDatabaseManager(':memory:')
    const db = dbm.getAppDatabase()
    dbm.runMigrations(db, FED_NS, fedMigrations)
    dbm.runMigrations(db, TEAM_NS, teamMigrations)
    const fed = new FederationStore(db)
    const auth = new AuthorityStore(db)
    const team = new TeamStore(db)

    for (const peer of ids) {
      fed.upsertNode({
        nodeId: peer,
        officeId: RIG_OFFICE,
        identity: peer,
        displayName: peer,
        joinedAt: joinedAt[peer],
        lastSeen: wall,
        status: 'online',
      })
    }
    auth.patchAuthorityState(RIG_OFFICE, { term: 1, authorityNodeId: ids[0], rosterEpoch: 1 }, 0)

    const becameAuthority = vi.fn()
    const reassigned = vi.fn()
    const ownerStatus = new Map<string, OwnerStatus>()

    const listMembersForNode = (nodeId: string): NodeBoundMember[] =>
      team
        .listMembersByTeam(RIG_OFFICE)
        .filter((m) => m.ownerNodeId === nodeId)
        .map((m) => ({ appId: m.appId, memberIdentity: m.memberIdentity ?? null }))

    // Faithful kernel-blackboard stand-in for an ADMITTED remote member write:
    // production applies the op through the authority's kernel blackboard, which
    // re-fires onWrite → captureLocalWrite, so the member write joins the SAME
    // single-writer log + fan-out as a local authority write. We mirror that here —
    // apply the op to the authority's own team store, then re-enter the log via
    // captureLocalWrite carrying the member's stable fid (replication handed it to
    // the next capture). This is what makes a local-origin and a remote-origin
    // write produce an equivalent replicated stream.
    let officeRef: OfficeAuthority | null = null
    const applyMemberWrite = (record: MemberWriteRecord): void => {
      const p = record.payload as Record<string, unknown>
      if (record.op === 'post_task') {
        team.insertTask(p as unknown as BlackboardTask)
      } else if (record.op === 'update_task') {
        const taskId = record.taskId ?? (p.taskId as string | undefined)
        if (taskId) {
          team.updateTask(
            taskId,
            {
              ...(p.status !== undefined ? { status: p.status as BlackboardTask['status'] } : {}),
              ...(p.assigneeAppId !== undefined
                ? { assigneeAppId: p.assigneeAppId as string | null }
                : {}),
              ...(p.resultRef !== undefined ? { resultRef: p.resultRef as string | null } : {}),
              ...(p.note !== undefined ? { note: p.note as string | null } : {}),
            },
            (p.updatedAt as number | undefined) ?? wall
          )
        }
      } else if (record.op === 'post_finding') {
        team.insertFinding(p as unknown as Parameters<typeof team.insertFinding>[0])
      }
      officeRef?.captureLocalWrite({
        teamId: record.teamId,
        epochId: record.epochId,
        op: record.op,
        payload: p,
        ...(record.taskId !== undefined ? { taskId: record.taskId } : {}),
      })
    }

    const office = createOfficeAuthority({
      officeId: RIG_OFFICE,
      selfNodeId: id,
      federationStore: fed,
      authorityStore: auth,
      teamStore: team,
      send: (to, frame) => route(id, to, frame as FederationMessage),
      broadcast: (frame) => routeBroadcast(id, frame as FederationMessage),
      now,
      getCurrentRunEpoch: () => ({ teamId: RIG_OFFICE, epochId: RIG_EPOCH }),
      getOwnerStatus: (appId) => ownerStatus.get(appId) ?? defaultOwner,
      reassignTask: (t) => reassigned(t),
      applyMemberWrite,
      onBecomeAuthority: (term) => becameAuthority(term),
      onAuthorityChange: () => {},
      resolveArtifactBytes: async () => null,
      schedule: (ms, fn) => scheduleOnClock(ms, fn),
      jitter: () => 0,
    })
    officeRef = office

    const coordinator = createFederationCoordinator({
      context: { officeId: RIG_OFFICE, selfNodeId: id },
      link: {
        send: (to, msg) => route(id, to, msg),
        broadcast: (msg) => routeBroadcast(id, msg),
        onMessage: (handler) => inboundHandlers.set(id, handler),
        close: () => inboundHandlers.delete(id),
      },
      federationStore: fed,
      teamStore: team,
      verifyCredential: (tok) => (tok === 'valid' ? { officeId: RIG_OFFICE, scope: DEFAULT_OFFICE_SCOPE } : null),
      now,
      monotonicNow,
      presence: { suspectAfterMs: SUSPECT_MS, confirmedOfflineMs: CONFIRMED_MS },
      listMembersForNode,
      onNodePresence: (nodeId, status) => office.onNodePresence(nodeId, status),
      onMemberConfirmedOffline: () => {},
      onM2Frame: (from, frame) => office.handle(from, frame),
    })
    coordinator.start()

    registry.set(id, {
      id,
      dbm,
      fed,
      auth,
      team,
      coordinator,
      office,
      becameAuthority,
      reassigned,
      ownerStatus,
    })
  }

  const nodes = Object.fromEntries(registry) as Record<string, RigNode>

  function fireDueTimers(): boolean {
    let fired = false
    let progressed = true
    while (progressed) {
      progressed = false
      for (const t of timers) {
        if (!t.cancelled && t.fireAt <= wall) {
          t.cancelled = true
          t.fn()
          progressed = true
          fired = true
        }
      }
    }
    return fired
  }

  function drainQueueOnce(): boolean {
    const due = queue.filter((q) => q.dueAt <= wall)
    if (due.length === 0) return false
    due.sort((a, b) => a.seq - b.seq)
    if (reorder) due.reverse()
    for (const q of due) {
      const idx = queue.indexOf(q)
      if (idx >= 0) queue.splice(idx, 1)
    }
    for (const q of due) deliverNow(q.from, q.to, q.frame)
    return true
  }

  function flush(): void {
    let spun = true
    while (spun) {
      spun = false
      if (drainQueueOnce()) spun = true
      if (fireDueTimers()) spun = true
    }
  }

  // A node is, by definition, alive to itself at the instant it acts. Its
  // self-row in the roster is never refreshed by a peer (broadcast skips the
  // sender), so without this it would eventually confirm ITSELF offline on a
  // sweep — a pure artifact of modelling the full roster, never a real
  // departure. Feed a self-heartbeat straight into the inbound handler to keep
  // the self-row fresh, mirroring production where the local node is always seen.
  function markSelfSeen(id: string): void {
    inboundHandlers.get(id)?.(id, {
      kind: 'heartbeat',
      officeId: RIG_OFFICE,
      fromNode: id,
      ts: wall,
    } as FederationMessage)
  }

  function tick(): void {
    sweepPhase = true
    for (const id of ids) {
      if (dead.has(id)) continue
      markSelfSeen(id)
      nodes[id].coordinator.sweepPresence()
    }
    sweepPhase = false
    flush()
  }

  function beat(): void {
    for (const id of ids) {
      if (dead.has(id)) continue
      nodes[id].coordinator.sendHeartbeat()
      markSelfSeen(id)
    }
    flush()
  }

  return {
    nodes,
    ids,
    clock: () => wall,
    advance: (ms) => {
      wall += ms
      mono += ms
    },
    advanceWallOnly: (ms) => {
      wall += ms
    },
    tick,
    flush,
    beat,
    kill: (id) => {
      dead.add(id)
    },
    revive: (id) => {
      dead.delete(id)
    },
    partition: (cells) => {
      cellOf = {}
      cells.forEach((cell, idx) => cell.forEach((nodeId) => (cellOf[nodeId] = idx)))
    },
    heal: () => {
      cellOf = {}
      ids.forEach((id) => (cellOf[id] = 0))
    },
    setLoss: (p) => {
      loss = p
    },
    setDelay: (ms) => {
      delayMs = ms
    },
    setReorder: (on) => {
      reorder = on
    },
    committedWriteAuthorityCount: () =>
      ids.filter(
        (id) =>
          !dead.has(id) &&
          nodes[id].office.isAuthoritySelf() &&
          nodes[id].office.getCommittedSeq() > 0
      ).length,
    taskIdsByNode: () => {
      const out: Record<string, string[]> = {}
      for (const id of ids) {
        out[id] = nodes[id].team
          .listTasksByTeam(RIG_OFFICE)
          .map((t) => t.id)
          .sort()
      }
      return out
    },
    appliedSeqByNode: () => {
      const out: Record<string, number> = {}
      for (const id of ids) out[id] = nodes[id].office.replication.getAppliedSeq()
      return out
    },
    offlineSeenBy: (observer) =>
      nodes[observer].fed
        .listNodesByOffice(RIG_OFFICE)
        .filter((n) => n.nodeId !== observer && n.status === 'offline')
        .map((n) => n.nodeId)
        .sort(),
    dispose: () => {
      for (const id of ids) {
        try {
          nodes[id].coordinator.stop()
        } catch {
          /* link already closed */
        }
        nodes[id].dbm.closeAll()
      }
    },
  }
}
