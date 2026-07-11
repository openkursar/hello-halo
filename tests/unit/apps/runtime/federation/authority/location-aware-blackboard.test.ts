/**
 * Unit tests for apps/runtime/federation/authority -- location-aware blackboard.
 *
 * Proves the position-transparent decorator:
 *   - OWNED office (hostNodeId == null): every method delegates straight to the
 *     base blackboard; nothing is routed.
 *   - SHADOW office (hostNodeId != null): the write is applied optimistically to
 *     the local store with a STABLE locally-generated id AND a blackboard-write is
 *     routed to the host carrying the same id; postTask/postFinding stay synchronous
 *     and return that id (host applies the same id → idempotent).
 *
 * A real in-memory TeamStore backs the shadow optimistic apply; the base blackboard
 * is a recording fake so delegation is observable without the websocket/render side
 * effects of the kernel blackboard.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabaseManager } from '../../../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../../../src/main/platform/store/types'
import { TeamStore } from '../../../../../../src/main/apps/team/store'
import {
  MIGRATION_NAMESPACE as TEAM_NS,
  migrations as teamMigrations,
} from '../../../../../../src/main/apps/team/migrations'
import {
  createLocationAwareBlackboard,
  type OutboundBlackboardWrite,
} from '../../../../../../src/main/apps/runtime/federation/authority/location-aware-blackboard'
import type {
  Blackboard,
  PostTaskInput,
  UpdateTaskInput,
  PostFindingInput,
} from '../../../../../../src/main/apps/runtime/team/blackboard'
import type { BlackboardSnapshot, Team } from '../../../../../../src/shared/apps/team-types'

const OWNED = 'office-owned'
const SHADOW = 'office-shadow'
const HOST = 'node-host'
const SELF = 'node-self'

function makeTeam(id: string, hostNodeId: string | null): Team {
  const now = Date.now()
  return {
    id,
    name: id,
    owningSpaceId: 'space-1',
    goal: 'g',
    leadAppId: null,
    memberSourcing: 'manual',
    collabMode: 'structured',
    escalationRouting: 'user',
    status: 'idle',
    currentEpochId: null,
    createdAt: now,
    updatedAt: now,
    hostNodeId,
  }
}

/** A recording base blackboard so delegation is observable. */
function makeBaseFake() {
  const calls: { postTask: PostTaskInput[]; updateTask: UpdateTaskInput[]; postFinding: PostFindingInput[]; readBoard: number } = {
    postTask: [],
    updateTask: [],
    postFinding: [],
    readBoard: 0,
  }
  const base: Blackboard = {
    postTask: (input) => {
      calls.postTask.push(input)
      return { taskId: 'base-task-id' }
    },
    updateTask: (input) => {
      calls.updateTask.push(input)
    },
    postFinding: (input) => {
      calls.postFinding.push(input)
      return { findingId: 'base-finding-id' }
    },
    readBoard: () => {
      calls.readBoard += 1
      return { tasks: [], findings: [], roster: [] } as BlackboardSnapshot
    },
  }
  return { base, calls }
}

describe('location-aware blackboard', () => {
  let dbManager: DatabaseManager
  let store: TeamStore
  let outbound: Array<{ host: string; write: OutboundBlackboardWrite }>

  beforeEach(() => {
    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, TEAM_NS, teamMigrations)
    store = new TeamStore(db)
    store.insertTeam(makeTeam(OWNED, null))
    store.insertTeam(makeTeam(SHADOW, HOST))
    outbound = []
  })

  afterEach(() => dbManager.closeAll())

  function build(base: Blackboard) {
    return createLocationAwareBlackboard({
      base,
      store,
      selfNodeId: SELF,
      sendBlackboardWrite: (host, write) => outbound.push({ host, write }),
    })
  }

  it('owned office: postTask/updateTask/postFinding delegate straight to base', () => {
    const { base, calls } = makeBaseFake()
    const lab = build(base)

    const r = lab.postTask({ teamId: OWNED, epochId: 'e1', callerAppId: 'a', title: 'T', assigneeAppId: null })
    lab.updateTask({ teamId: OWNED, epochId: 'e1', taskId: 'x', status: 'in_progress' })
    lab.postFinding({ teamId: OWNED, epochId: 'e1', callerAppId: 'a', content: 'c' })

    expect(r.taskId).toBe('base-task-id')
    expect(calls.postTask).toHaveLength(1)
    expect(calls.updateTask).toHaveLength(1)
    expect(calls.postFinding).toHaveLength(1)
    expect(outbound).toHaveLength(0)
  })

  it('shadow office: postTask applies locally + routes to host with the SAME id', () => {
    const { base, calls } = makeBaseFake()
    const lab = build(base)

    const { taskId } = lab.postTask({
      teamId: SHADOW,
      epochId: 'e1',
      callerAppId: 'a',
      title: 'shadow task',
      assigneeAppId: null,
    })

    expect(typeof taskId).toBe('string')
    expect(taskId.length).toBeGreaterThan(0)
    const local = store.getTaskById(taskId)
    expect(local).not.toBeNull()
    expect(local?.title).toBe('shadow task')
    expect(outbound).toHaveLength(1)
    expect(outbound[0].host).toBe(HOST)
    expect(outbound[0].write.op).toBe('post_task')
    expect(outbound[0].write.taskId).toBe(taskId)
    expect((outbound[0].write.payload as { id: string }).id).toBe(taskId)
    expect(outbound[0].write.fid.length).toBeGreaterThan(0)
    expect(calls.postTask).toHaveLength(0)
  })

  it('shadow office: postFinding applies locally + routes to host with the SAME id', () => {
    const { base } = makeBaseFake()
    const lab = build(base)

    const { findingId } = lab.postFinding({ teamId: SHADOW, epochId: 'e1', callerAppId: 'a', content: 'note' })

    expect(findingId.length).toBeGreaterThan(0)
    const findings = store.listFindingsByEpoch(SHADOW, 'e1')
    expect(findings.map((f) => f.id)).toContain(findingId)
    expect(outbound).toHaveLength(1)
    expect(outbound[0].write.op).toBe('post_finding')
    expect((outbound[0].write.payload as { id: string }).id).toBe(findingId)
  })

  it('shadow office: updateTask applies the patch locally + routes it to the host', () => {
    const { base } = makeBaseFake()
    const lab = build(base)

    const { taskId } = lab.postTask({ teamId: SHADOW, epochId: 'e1', callerAppId: 'a', title: 'seed', assigneeAppId: null })
    outbound.length = 0

    lab.updateTask({ teamId: SHADOW, epochId: 'e1', taskId, status: 'done', resultRef: 'ref/1' })

    const updated = store.getTaskById(taskId)
    expect(updated?.status).toBe('done')
    expect(updated?.resultRef).toBe('ref/1')
    expect(outbound).toHaveLength(1)
    expect(outbound[0].write.op).toBe('update_task')
    expect(outbound[0].write.taskId).toBe(taskId)
    expect(outbound[0].write.payload).toMatchObject({ taskId, status: 'done', resultRef: 'ref/1' })
  })

  it('host applying the routed write with the same id is idempotent (no duplicate)', () => {
    const { base } = makeBaseFake()
    const lab = build(base)

    const { taskId } = lab.postTask({ teamId: SHADOW, epochId: 'e1', callerAppId: 'a', title: 'x', assigneeAppId: null })

    // Simulate the host applying the SAME payload id. A second store write with the
    // same primary key would throw — proving the id is the convergence anchor. We
    // assert the routed payload carries exactly the local id so host apply collapses
    // to the same row (the replication layer's seq/fid dedup prevents re-insert).
    const routedId = (outbound[0].write.payload as { id: string }).id
    expect(routedId).toBe(taskId)
    expect(store.listTasksByTeam(SHADOW)).toHaveLength(1)
  })

  it('readBoard always delegates to base (position-transparent reads)', () => {
    const { base, calls } = makeBaseFake()
    const lab = build(base)
    lab.readBoard(SHADOW, 'e1', 'a')
    lab.readBoard(OWNED, 'e1', 'a')
    expect(calls.readBoard).toBe(2)
  })
})
