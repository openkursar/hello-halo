/**
 * office-authority — a 3-node in-process office proving the resilience core end to
 * end:
 *   - the authority's writes replicate to hot-standbys and COMMIT with
 *     heir-inclusion (no lost committed write);
 *   - when the authority is confirmed-offline, the heir is elected and becomes the
 *     new authority at term+1, and a previously-committed write is present on the
 *     successor (no lost committed write across handover).
 *
 * Each node has its own :memory: db (FederationStore + AuthorityStore + TeamStore)
 * and an OfficeAuthority; a synchronous hub routes frames by node id (a dead node
 * neither sends nor receives). Presence is driven explicitly.
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
import type { MemberWriteRecord } from '../../../../../../src/main/apps/runtime/federation/authority/replication'
import type { FederationMessage } from '../../../../../../src/main/apps/runtime/federation/types'
import type { TeamMember } from '../../../../../../src/main/apps/team'
import type { BlackboardTask, TeamActivity } from '../../../../../../src/shared/apps/team-types'

const OFFICE = 'office-x'
const EPOCH = 'epoch-1'

interface Node {
  id: string
  dbm: DatabaseManager
  fed: FederationStore
  auth: AuthorityStore
  team: TeamStore
  office: OfficeAuthority
  onBecomeAuthority: ReturnType<typeof vi.fn>
  /** Member writes this node admitted and applied through its kernel blackboard. */
  applied: MemberWriteRecord[]
}

function task(id: string, assignee: string | null = null, status: BlackboardTask['status'] = 'pending'): BlackboardTask {
  const now = 0
  return {
    id, teamId: OFFICE, epochId: EPOCH, title: id, assigneeAppId: assignee, status,
    resultRef: null, note: null, parentId: null, createdByAppId: 'lead', createdAt: now, updatedAt: now,
  }
}

describe('office-authority (3-node resilience integration)', () => {
  const created: DatabaseManager[] = []
  afterEach(() => {
    for (const d of created) d.closeAll()
    created.length = 0
  })

  function build(): {
    nodes: Record<string, Node>
    kill: (id: string) => void
    sent: { to: string; frame: FederationMessage }[]
  } {
    const ids = ['A', 'B', 'C']
    const joinedAt: Record<string, number> = { A: 1, B: 2, C: 3 }
    const dead = new Set<string>()
    const registry = new Map<string, Node>()
    const sent: { to: string; frame: FederationMessage }[] = []

    const route = (to: string, frame: FederationMessage) => {
      sent.push({ to, frame })
      if (dead.has(to)) return
      const from = (frame as { fromNode?: string }).fromNode ?? 'unknown'
      if (dead.has(from)) return
      const n = registry.get(to)
      if (n) n.office.handle(from, frame as never)
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
      created.push(dbm)
      const db = dbm.getAppDatabase()
      dbm.runMigrations(db, FED_NS, fedMigrations)
      dbm.runMigrations(db, TEAM_NS, teamMigrations)
      const fed = new FederationStore(db)
      const auth = new AuthorityStore(db)
      const team = new TeamStore(db)
      for (const peer of ids) {
        fed.upsertNode({ nodeId: peer, officeId: OFFICE, identity: peer, displayName: peer, joinedAt: joinedAt[peer], lastSeen: 0, status: 'online' })
      }
      auth.patchAuthorityState(OFFICE, { term: 1, authorityNodeId: 'A', rosterEpoch: 1 }, 0)
      const onBecomeAuthority = vi.fn()
      const applied: MemberWriteRecord[] = []
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
        applyMemberWrite: (record) => applied.push(record),
        onBecomeAuthority,
        onAuthorityChange: () => {},
        resolveArtifactBytes: async () => null,
        // Synchronous election: confirms arrive during broadcast, so the timer
        // never needs to fire — a no-op scheduler keeps the test deterministic.
        schedule: () => () => {},
        jitter: () => 0,
      })
      registry.set(id, { id, dbm, fed, auth, team, office, onBecomeAuthority, applied })
    }

    const nodes = Object.fromEntries(registry) as Record<string, Node>
    const kill = (id: string) => {
      dead.add(id)
      for (const peerId of ids) {
        if (peerId === id) continue
        nodes[peerId].fed.setNodeStatus(OFFICE, id, 'offline', 0)
      }
    }
    return { nodes, kill, sent }
  }

  it('replicates the authority writes and commits with heir-inclusion', () => {
    const { nodes } = build()
    const A = nodes.A
    const t1 = task('t1')
    A.office.captureLocalWrite({ teamId: OFFICE, epochId: EPOCH, op: 'post_task', payload: t1 as unknown as Record<string, unknown>, taskId: 't1' })

    expect(A.office.getCommittedSeq()).toBe(1) // majority(B,C)=2 acked incl heir B
    expect(nodes.B.team.getTaskById('t1')).toBeTruthy()
    expect(nodes.C.team.getTaskById('t1')).toBeTruthy()
  })

  it('leaderCommit: a standby learns committedSeq from a later replicate (enables election restriction)', () => {
    const { nodes } = build()
    // First write commits on A (committedSeq → 1). The replicate frame for it was
    // sent before its acks, so it carried committedSeq 0; standbys are still 0.
    nodes.A.office.captureLocalWrite({ teamId: OFFICE, epochId: EPOCH, op: 'post_task', payload: task('t1') as unknown as Record<string, unknown>, taskId: 't1' })
    expect(nodes.A.office.getCommittedSeq()).toBe(1)
    // A SECOND write now carries committedSeq=1 in its leaderCommit → standbys learn it.
    nodes.A.office.captureLocalWrite({ teamId: OFFICE, epochId: EPOCH, op: 'post_task', payload: task('t2') as unknown as Record<string, unknown>, taskId: 't2' })
    expect(nodes.B.office.getCommittedSeq()).toBeGreaterThanOrEqual(1)
    expect(nodes.C.office.getCommittedSeq()).toBeGreaterThanOrEqual(1)
  })

  it('AC-5.1/5.2: authority dies → heir elected at term+1, committed write survives', () => {
    const { nodes, kill } = build()
    nodes.A.office.captureLocalWrite({ teamId: OFFICE, epochId: EPOCH, op: 'post_task', payload: task('t1') as unknown as Record<string, unknown>, taskId: 't1' })
    expect(nodes.A.office.getCommittedSeq()).toBe(1)

    kill('A')
    nodes.B.office.onNodePresence('A', 'offline')
    nodes.C.office.onNodePresence('A', 'offline')

    // The heir B (earliest joined_at among survivors) wins term 2.
    expect(nodes.B.office.isAuthoritySelf()).toBe(true)
    expect(nodes.B.office.getTerm()).toBe(2)
    expect(nodes.B.onBecomeAuthority).toHaveBeenCalledWith(2)

    expect(nodes.B.team.getTaskById('t1')).toBeTruthy()
  })

  function member(appId: string, ownerNodeId: string): TeamMember {
    return {
      teamId: OFFICE,
      appId,
      memberName: appId,
      role: 'worker',
      isLead: false,
      aiProvisioned: false,
      addedAt: 1,
      ownerNodeId,
      origin: ownerNodeId === 'A' ? 'local' : 'remote',
      memberIdentity: appId,
      scopeJson: null,
    }
  }

  /** A directed act (message/reply): the actor and the target sit on DIFFERENT nodes. */
  function directedActivity(actorAppId: string, targetAppId: string): TeamActivity {
    return {
      id: 'act-1',
      teamId: OFFICE,
      epochId: EPOCH,
      kind: 'message',
      actorAppId,
      targetAppId,
      subject: 'hello',
      body: null,
      refId: null,
      correlationId: null,
      status: 'sent',
      createdAt: 0,
    }
  }

  it("records a joiner's directed activity: the actor it owns carries the write, not the target it does not", () => {
    // Drop `actorAppId` from the resolvable subject fields and the only claim
    // left is targetAppId — a member of the AUTHORITY's node — so every
    // cross-node message record is refused non-retryably and rolled back.
    const { nodes, sent } = build()
    for (const id of ['A', 'B', 'C']) {
      nodes[id].team.addMember(member('remote-wkr', 'B'))
      nodes[id].team.addMember(member('local-wkr', 'A'))
    }

    nodes.A.office.handle('B', {
      kind: 'blackboard-write',
      officeId: OFFICE,
      fromNode: 'B',
      term: nodes.A.office.getTerm(),
      op: 'post_activity',
      payload: directedActivity('remote-wkr', 'local-wkr') as unknown as Record<string, unknown>,
      fid: 'fid-activity-1',
    } as never)

    expect(nodes.A.applied.map((r) => r.op)).toEqual(['post_activity'])
    expect(sent.some((s) => s.frame.kind === 'reject')).toBe(false)
  })

  it('refuses a write that names only members the sending node does not own', () => {
    const { nodes, sent } = build()
    for (const id of ['A', 'B', 'C']) {
      nodes[id].team.addMember(member('remote-wkr', 'B'))
      nodes[id].team.addMember(member('local-wkr', 'A'))
    }

    // B owns `remote-wkr`, yet claims to act AS the authority's own member.
    nodes.A.office.handle('B', {
      kind: 'blackboard-write',
      officeId: OFFICE,
      fromNode: 'B',
      term: nodes.A.office.getTerm(),
      op: 'post_activity',
      payload: directedActivity('local-wkr', 'local-wkr') as unknown as Record<string, unknown>,
      fid: 'fid-activity-2',
    } as never)

    expect(nodes.A.applied).toHaveLength(0)
    expect(
      sent.some((s) => s.frame.kind === 'reject' && (s.frame as { reason?: string }).reason === 'SCOPE_DENIED')
    ).toBe(true)
  })

  it('O-SB / partition minority: with two peers dead, the lone survivor pauses (no double authority)', () => {
    const { nodes, kill } = build()
    // Kill A and C → B is alone against a last-known roster of 3 (quorum 2).
    kill('A')
    kill('C')
    nodes.B.office.onNodePresence('A', 'offline')
    nodes.B.office.onNodePresence('C', 'offline')
    expect(nodes.B.office.isAuthoritySelf()).toBe(false)
    expect(nodes.B.office.getTerm()).toBe(1) // tenure unchanged (no election won)
  })
})
