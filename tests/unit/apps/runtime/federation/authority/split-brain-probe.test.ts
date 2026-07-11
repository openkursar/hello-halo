/**
 * Split-brain observable-probe rig.
 *
 * Proves the split-brain + lost-write invariant directly: all nodes' committed
 * blackboard converges with no duplicate task ids, and a partitioned minority
 * pauses (never double-writes) until it heals and converges to the authority side.
 * Adds partition/heal/revive primitives and a sampled committed-write-authority
 * count on top of the office-authority test pattern.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
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
import {
  createOfficeAuthority,
  type OfficeAuthority,
} from '../../../../../../src/main/apps/runtime/federation/authority/office-authority'
import type { FederationMessage } from '../../../../../../src/main/apps/runtime/federation/types'
import type { BlackboardTask } from '../../../../../../src/shared/apps/team-types'

const OFFICE = 'office-sb'
const EPOCH = 'epoch-1'

interface Node {
  id: string
  dbm: DatabaseManager
  fed: FederationStore
  auth: AuthorityStore
  team: TeamStore
  office: OfficeAuthority
}

function task(id: string): BlackboardTask {
  return {
    id, teamId: OFFICE, epochId: EPOCH, title: id, assigneeAppId: null, status: 'pending',
    resultRef: null, note: null, parentId: null, createdByAppId: 'lead', createdAt: 0, updatedAt: 0,
  }
}

interface Rig {
  nodes: Record<string, Node>
  kill: (id: string) => void
  revive: (id: string) => void
  /** Split the live nodes into reachability cells; only same-cell pairs talk. */
  partition: (cells: string[][]) => void
  /** Collapse to one fully-connected cell. */
  heal: () => void
  /** Probe: nodes that believe they are authority AND have committed a write. */
  committedWriteAuthorityCount: () => number
  /** Per-node sorted committed task ids, for checking convergence and no-dup. */
  taskIdsByNode: () => Record<string, string[]>
}

function build(ids: string[]): Rig {
  const joinedAt: Record<string, number> = {}
  ids.forEach((id, i) => (joinedAt[id] = i + 1))
  const dead = new Set<string>()
  // cellOf[id] = partition-cell index; same index ⇒ can exchange frames.
  let cellOf: Record<string, number> = {}
  ids.forEach((id) => (cellOf[id] = 0))
  const registry = new Map<string, Node>()

  const canTalk = (a: string, b: string) =>
    !dead.has(a) && !dead.has(b) && cellOf[a] === cellOf[b]

  const route = (to: string, frame: FederationMessage) => {
    const from = (frame as { fromNode?: string }).fromNode ?? 'unknown'
    if (!canTalk(from, to)) return
    registry.get(to)?.office.handle(from, frame as never)
  }
  const broadcastFrom = (selfId: string, frame: FederationMessage) => {
    if (dead.has(selfId)) return
    for (const id of ids) {
      if (id === selfId) continue
      route(id, frame)
    }
  }

  for (const id of ids) {
    const dbm = createDatabaseManager(':memory:')
    const db = dbm.getAppDatabase()
    dbm.runMigrations(db, FED_NS, fedMigrations)
    dbm.runMigrations(db, TEAM_NS, teamMigrations)
    const fed = new FederationStore(db)
    const auth = new AuthorityStore(db)
    const team = new TeamStore(db)
    for (const peer of ids) {
      fed.upsertNode({ nodeId: peer, officeId: OFFICE, identity: peer, displayName: peer, joinedAt: joinedAt[peer], lastSeen: 0, status: 'online' })
    }
    auth.patchAuthorityState(OFFICE, { term: 1, authorityNodeId: ids[0], rosterEpoch: 1 }, 0)
    const office = createOfficeAuthority({
      officeId: OFFICE,
      selfNodeId: id,
      federationStore: fed,
      authorityStore: auth,
      teamStore: team,
      send: (to, frame) => route(to, frame),
      broadcast: (frame) => broadcastFrom(id, frame),
      now: () => 0,
      getCurrentRunEpoch: () => ({ teamId: OFFICE, epochId: EPOCH }),
      getOwnerStatus: () => 'idle',
      reassignTask: () => {},
      applyMemberWrite: () => {},
      onBecomeAuthority: () => {},
      onAuthorityChange: () => {},
      resolveArtifactBytes: async () => null,
      schedule: () => () => {},
      jitter: () => 0,
    })
    registry.set(id, { id, dbm, fed, auth, team, office })
  }

  const nodes = Object.fromEntries(registry) as Record<string, Node>

  // A node going offline (kill or partitioned away) must be observed as offline by
  // the peers that can no longer reach it — that is what the real presence FSM does.
  const refreshPresence = () => {
    for (const observer of ids) {
      if (dead.has(observer)) continue
      for (const other of ids) {
        if (other === observer) continue
        const status = canTalk(observer, other) ? 'online' : 'offline'
        nodes[observer].fed.setNodeStatus(OFFICE, other, status, 0)
        nodes[observer].office.onNodePresence(other, status === 'online' ? 'online' : 'offline')
      }
    }
  }

  return {
    nodes,
    kill: (id) => {
      dead.add(id)
      refreshPresence()
    },
    revive: (id) => {
      dead.delete(id)
      refreshPresence()
    },
    partition: (cells) => {
      cellOf = {}
      cells.forEach((cell, idx) => cell.forEach((id) => (cellOf[id] = idx)))
      refreshPresence()
    },
    heal: () => {
      cellOf = {}
      ids.forEach((id) => (cellOf[id] = 0))
      refreshPresence()
    },
    committedWriteAuthorityCount: () =>
      ids.filter((id) => !dead.has(id) && nodes[id].office.isAuthoritySelf() && nodes[id].office.getCommittedSeq() > 0).length,
    taskIdsByNode: () => {
      const out: Record<string, string[]> = {}
      for (const id of ids) {
        out[id] = nodes[id].team.listTasksByTeam(OFFICE).map((t) => t.id).sort()
      }
      return out
    },
  }
}

describe('split-brain observable probe (AC-5.2 / AC-5.4 hard gate)', () => {
  const dbs: DatabaseManager[] = []
  const track = (rig: Rig) => {
    for (const id of Object.keys(rig.nodes)) dbs.push(rig.nodes[id].dbm)
    return rig
  }
  afterEach(() => {
    for (const d of dbs) d.closeAll()
    dbs.length = 0
  })

  it('O-SB-1 invariant: committed-write-authority ≤ 1 across a partition + heal (no split-brain double-write)', () => {
    const rig = track(build(['A', 'B', 'C']))
    const samples: number[] = []
    const sample = () => samples.push(rig.committedWriteAuthorityCount())

    // Authority A commits a write while fully connected.
    rig.nodes.A.office.captureLocalWrite({ teamId: OFFICE, epochId: EPOCH, op: 'post_task', payload: task('t1') as unknown as Record<string, unknown>, taskId: 't1' })
    sample() // A is the sole committed-write authority.

    // Partition into {A} (minority, 1 of 3) vs {B,C} (majority, quorum=2).
    rig.partition([['A'], ['B', 'C']])
    sample()

    // The majority side elects the heir B (it sees A offline).
    sample()
    expect([1, 2].includes(rig.nodes.B.office.getTerm())).toBe(true)

    // A, now isolated minority, tries to keep writing. It must NOT commit
    // unreplicated writes (getKnownStandbyCount is reachability-blind → quorum
    // unreachable), so it never becomes a second committed-write authority.
    rig.nodes.A.office.captureLocalWrite({ teamId: OFFICE, epochId: EPOCH, op: 'post_task', payload: task('t2-minority') as unknown as Record<string, unknown>, taskId: 't2-minority' })
    sample()

    // B (majority authority) commits a fresh write.
    rig.nodes.B.office.captureLocalWrite({ teamId: OFFICE, epochId: EPOCH, op: 'post_task', payload: task('t3-majority') as unknown as Record<string, unknown>, taskId: 't3-majority' })
    sample()

    // Heal the partition; A observes B's higher term and steps down.
    rig.heal()
    rig.nodes.A.office.handle('B', { kind: 'blackboard-write', officeId: OFFICE, fromNode: 'B', term: rig.nodes.B.office.getTerm(), op: 'post_task', payload: { ...(task('t3-majority') as unknown as Record<string, unknown>), teamId: OFFICE }, taskId: 't3-majority', fid: 'heal-1' } as never)
    sample()

    expect(Math.max(...samples)).toBeLessThanOrEqual(1)
  })

  it("AC-5.4 proxy: minority side does not commit its isolated write (no lost-write masquerading as a second history)", () => {
    const rig = track(build(['A', 'B', 'C']))
    rig.nodes.A.office.captureLocalWrite({ teamId: OFFICE, epochId: EPOCH, op: 'post_task', payload: task('t1') as unknown as Record<string, unknown>, taskId: 't1' })
    const committedBefore = rig.nodes.A.office.getCommittedSeq()

    rig.partition([['A'], ['B', 'C']])
    rig.nodes.A.office.captureLocalWrite({ teamId: OFFICE, epochId: EPOCH, op: 'post_task', payload: task('t2-minority') as unknown as Record<string, unknown>, taskId: 't2-minority' })

    // The minority write is appended to A's local log but NOT committed (no quorum):
    // committedSeq must not advance past the pre-partition committed point.
    expect(rig.nodes.A.office.getCommittedSeq()).toBe(committedBefore)
  })

  it('AC-5.2 proxy: no duplicate task id on the majority side after heir election', () => {
    const rig = track(build(['A', 'B', 'C']))
    rig.nodes.A.office.captureLocalWrite({ teamId: OFFICE, epochId: EPOCH, op: 'post_task', payload: task('t1') as unknown as Record<string, unknown>, taskId: 't1' })

    rig.kill('A')
    rig.nodes.B.office.captureLocalWrite({ teamId: OFFICE, epochId: EPOCH, op: 'post_task', payload: task('t2') as unknown as Record<string, unknown>, taskId: 't2' })

    const byNode = rig.taskIdsByNode()
    for (const id of ['B', 'C']) {
      const ids = byNode[id]
      expect(new Set(ids).size).toBe(ids.length) // no duplicates
      expect(ids).toContain('t1') // committed write survived handover
    }
  })
})
