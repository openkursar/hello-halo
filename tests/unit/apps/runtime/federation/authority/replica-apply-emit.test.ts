/**
 * A hot-standby emits a renderer refresh after applying a replicated write.
 *
 * Same 3-node in-process office as office-authority.test.ts (each node its own
 * :memory: store + an OfficeAuthority over a synchronous node-id hub). The
 * authority captures a local blackboard write; it replicates to the two standbys,
 * which apply it to their read-only replica AND fire onReplicaApplied so the
 * renderer shows the live task/finding without a reload. Proven:
 *   - post_task / post_finding (row-changing) → each standby emits once, carrying
 *     the op and (for tasks) the taskId;
 *   - the authority itself does NOT emit on its own local write (it already has the
 *     row; the emit is a STANDBY-side refresh signal only);
 *   - the emit count matches the apply count (idempotent re-delivery would not
 *     double-emit, but a clean single replicate emits exactly once per standby).
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
import type { BlackboardTask, BlackboardFinding } from '../../../../../../src/shared/apps/team-types'

const OFFICE = 'office-d2'
const EPOCH = 'epoch-1'

interface ReplicaEmit {
  officeId: string
  op: string
  taskId?: string
}

interface Node {
  id: string
  dbm: DatabaseManager
  team: TeamStore
  office: OfficeAuthority
  emits: ReplicaEmit[]
}

function task(id: string, assignee: string | null = null): BlackboardTask {
  const now = 0
  return {
    id, teamId: OFFICE, epochId: EPOCH, title: id, assigneeAppId: assignee, status: 'pending',
    resultRef: null, note: null, parentId: null, createdByAppId: 'lead', createdAt: now, updatedAt: now,
  }
}

function finding(id: string): BlackboardFinding {
  return {
    id, teamId: OFFICE, epochId: EPOCH, authorAppId: 'lead',
    body: id, ref: null, createdAt: 0,
  }
}

describe('D-2 — standby emits team:updated after applying a replicated write', () => {
  const created: DatabaseManager[] = []
  afterEach(() => {
    for (const d of created) d.closeAll()
    created.length = 0
  })

  function build(): Record<string, Node> {
    const ids = ['A', 'B', 'C']
    const joinedAt: Record<string, number> = { A: 1, B: 2, C: 3 }
    const registry = new Map<string, Node>()

    const route = (to: string, frame: FederationMessage) => {
      const from = (frame as { fromNode?: string }).fromNode ?? 'unknown'
      registry.get(to)?.office.handle(from, frame as never)
    }
    const broadcastFrom = (selfId: string, frame: FederationMessage) => {
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
        fed.upsertNode({
          nodeId: peer, officeId: OFFICE, identity: peer, displayName: peer,
          joinedAt: joinedAt[peer], lastSeen: 0, status: 'online',
        })
      }
      auth.patchAuthorityState(OFFICE, { term: 1, authorityNodeId: 'A', rosterEpoch: 1 }, 0)
      const emits: ReplicaEmit[] = []
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
        onReplicaApplied: (info) => emits.push(info),
        schedule: () => () => {},
        jitter: () => 0,
      })
      registry.set(id, { id, dbm, team, office, emits })
    }
    return Object.fromEntries(registry) as Record<string, Node>
  }

  it('post_task: both standbys emit once with the op + taskId; the authority does not emit', () => {
    const nodes = build()
    nodes.A.office.captureLocalWrite({
      teamId: OFFICE, epochId: EPOCH, op: 'post_task',
      payload: task('t1') as unknown as Record<string, unknown>, taskId: 't1',
    })

    expect(nodes.A.office.getCommittedSeq()).toBe(1)
    expect(nodes.B.team.getTaskById('t1')).toBeTruthy()
    expect(nodes.C.team.getTaskById('t1')).toBeTruthy()

    expect(nodes.B.emits).toEqual([{ officeId: OFFICE, op: 'post_task', taskId: 't1' }])
    expect(nodes.C.emits).toEqual([{ officeId: OFFICE, op: 'post_task', taskId: 't1' }])

    expect(nodes.A.emits).toEqual([])
  })

  it('post_finding: standbys emit with the op (no taskId for a finding)', () => {
    const nodes = build()
    nodes.A.office.captureLocalWrite({
      teamId: OFFICE, epochId: EPOCH, op: 'post_finding',
      payload: finding('f1') as unknown as Record<string, unknown>,
    })

    expect(nodes.B.emits).toEqual([{ officeId: OFFICE, op: 'post_finding' }])
    expect(nodes.C.emits).toEqual([{ officeId: OFFICE, op: 'post_finding' }])
    expect(nodes.B.emits[0].taskId).toBeUndefined()
  })

  it('two writes → two emits per standby (one per applied replicate, in order)', () => {
    const nodes = build()
    nodes.A.office.captureLocalWrite({
      teamId: OFFICE, epochId: EPOCH, op: 'post_task',
      payload: task('t1') as unknown as Record<string, unknown>, taskId: 't1',
    })
    nodes.A.office.captureLocalWrite({
      teamId: OFFICE, epochId: EPOCH, op: 'post_task',
      payload: task('t2') as unknown as Record<string, unknown>, taskId: 't2',
    })

    expect(nodes.B.emits.map((e) => e.taskId)).toEqual(['t1', 't2'])
    expect(nodes.C.emits.map((e) => e.taskId)).toEqual(['t1', 't2'])
  })
})
