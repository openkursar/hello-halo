/**
 * Unit tests for apps/runtime/federation/authority -- blackboard replication.
 *
 * Drives createReplication directly with in-memory better-sqlite3 stores (an
 * AuthorityStore for the durable log + water marks, a TeamStore for the replica)
 * and injected term / committed-seq / online-standby / heir callbacks, so each
 * test controls quorum membership without a real cluster.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createDatabaseManager } from '../../../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../../../src/main/platform/store/types'
import { AuthorityStore } from '../../../../../../src/main/apps/federation/authority-store'
import { TeamStore } from '../../../../../../src/main/apps/team/store'
import {
  MIGRATION_NAMESPACE as FED_NS,
  migrations as fedMigrations,
} from '../../../../../../src/main/apps/federation/migrations'
import {
  MIGRATION_NAMESPACE as TEAM_NS,
  migrations as teamMigrations,
} from '../../../../../../src/main/apps/team/migrations'
import {
  createReplication,
  type Replication,
  type ReplicationDeps,
} from '../../../../../../src/main/apps/runtime/federation/authority/replication'
import type {
  AckFrame,
  BlackboardReplicateFrame,
  BlackboardWriteFrame,
  CatchupRequestFrame,
  CatchupResponseFrame,
  M2Frame,
} from '../../../../../../src/main/apps/runtime/federation/protocol-m2'
import type { BlackboardWriteRecord } from '../../../../../../src/main/apps/runtime/team/blackboard'
import type { BlackboardTask } from '../../../../../../src/shared/apps/team-types'

const OFFICE = 'office-1'
const AUTHORITY = 'node-authority'
const HEIR = 'node-heir' // earliest joined_at online standby
const STANDBY_2 = 'node-standby-2'
const STANDBY_3 = 'node-standby-3'

function makeTaskPayload(id: string, title = 'task'): Record<string, unknown> {
  const now = Date.now()
  const task: BlackboardTask = {
    id,
    teamId: OFFICE,
    epochId: 'epoch-1',
    title,
    assigneeAppId: null,
    status: 'pending',
    resultRef: null,
    note: null,
    parentId: null,
    createdByAppId: 'app-x',
    createdAt: now,
    updatedAt: now,
  }
  return task as unknown as Record<string, unknown>
}

/** Build an isolated db + the two stores. */
function makeStores() {
  const dbManager = createDatabaseManager(':memory:')
  const db = dbManager.getAppDatabase()
  dbManager.runMigrations(db, FED_NS, fedMigrations)
  dbManager.runMigrations(db, TEAM_NS, teamMigrations)
  return {
    dbManager,
    authorityStore: new AuthorityStore(db),
    teamStore: new TeamStore(db),
  }
}

describe('replication — authority commit + heir inclusion (O-R5-1/2)', () => {
  let dbManager: DatabaseManager
  let authorityStore: AuthorityStore
  let teamStore: TeamStore
  let committedSeq: number
  let online: string[]
  let heir: string | null
  let sent: Array<{ to: string; frame: M2Frame }>
  let broadcasts: M2Frame[]
  let repl: Replication

  beforeEach(() => {
    const s = makeStores()
    dbManager = s.dbManager
    authorityStore = s.authorityStore
    teamStore = s.teamStore
    committedSeq = 0
    online = [HEIR, STANDBY_2, STANDBY_3]
    heir = HEIR
    sent = []
    broadcasts = []
    repl = createReplication({
      officeId: OFFICE,
      selfNodeId: AUTHORITY,
      authorityStore,
      replicaStore: teamStore,
      send: (to, frame) => sent.push({ to, frame }),
      broadcast: (frame) => broadcasts.push(frame),
      getTerm: () => 1,
      getCommittedSeq: () => committedSeq,
      setCommittedSeq: (s2) => (committedSeq = s2),
      getOnlineStandbys: () => online,
      getHeir: () => heir,
      getKnownStandbyCount: () => online.length,
    })
  })

  afterEach(() => dbManager.closeAll())

  function ack(from: string, ackedSeq: number) {
    const frame: AckFrame = {
      kind: 'ack',
      officeId: OFFICE,
      fromNode: from,
      reFid: 'n/a',
      ackedSeq,
      fid: `ack-${from}-${ackedSeq}`,
    }
    repl.handleAck(from, frame)
  }

  it('O-R5-2: majority WITHOUT heir does not commit; heir ack commits', () => {
    const rec: BlackboardWriteRecord = {
      teamId: OFFICE,
      epochId: 'epoch-1',
      op: 'post_task',
      payload: makeTaskPayload('t1'),
      taskId: 't1',
    }
    repl.captureLocalWrite(rec)
    expect(authorityStore.getMaxSeq(OFFICE)).toBe(1)

    // Majority (2 of 3) ack but the heir is NOT among them → NOT committed.
    ack(STANDBY_2, 1)
    ack(STANDBY_3, 1)
    expect(committedSeq).toBe(0)

    // Heir acks → quorum (majority ∧ heir) reached → committed.
    ack(HEIR, 1)
    expect(committedSeq).toBe(1)
  })

  it('O-R5-1: a committed write is present on the heir (survives handover)', () => {
    repl.captureLocalWrite({
      teamId: OFFICE,
      epochId: 'epoch-1',
      op: 'post_task',
      payload: makeTaskPayload('t1'),
      taskId: 't1',
    })
    const replicate = broadcasts[0] as BlackboardReplicateFrame
    expect(replicate.kind).toBe('blackboard-replicate')
    expect(replicate.seq).toBe(1)

    // Build the HEIR's own replication node sharing the SAME db (so its replica +
    // log live where a promoted authority would read them). The heir applies the
    // replicated frame, then acks.
    const heirStores = makeStores()
    try {
      const heirRepl = createReplication({
        officeId: OFFICE,
        selfNodeId: HEIR,
        authorityStore: heirStores.authorityStore,
        replicaStore: heirStores.teamStore,
        send: () => {},
        broadcast: () => {},
        getTerm: () => 1,
        getCommittedSeq: () => 0,
        setCommittedSeq: () => {},
        getOnlineStandbys: () => [],
        getHeir: () => null,
        getKnownStandbyCount: () => 0,
      })
      heirRepl.handleReplicate(AUTHORITY, replicate)
      expect(heirStores.teamStore.getTaskById('t1')).not.toBeNull()
      // And the authority commits once heir + majority ack.
      ack(HEIR, 1)
      ack(STANDBY_2, 1)
      expect(committedSeq).toBe(1)
    } finally {
      heirStores.dbManager.closeAll()
    }
  })

  it('commits a contiguous run only up to the first non-quorum gap', () => {
    repl.captureLocalWrite({ teamId: OFFICE, epochId: 'epoch-1', op: 'post_task', payload: makeTaskPayload('t1'), taskId: 't1' })
    repl.captureLocalWrite({ teamId: OFFICE, epochId: 'epoch-1', op: 'post_task', payload: makeTaskPayload('t2'), taskId: 't2' })
    ack(HEIR, 1)
    ack(STANDBY_2, 1)
    expect(committedSeq).toBe(1)
    ack(HEIR, 2)
    ack(STANDBY_2, 2)
    expect(committedSeq).toBe(2)
  })

  it('single-node office (no online standbys) commits immediately', () => {
    online = []
    heir = null
    repl.captureLocalWrite({ teamId: OFFICE, epochId: 'epoch-1', op: 'post_task', payload: makeTaskPayload('t1'), taskId: 't1' })
    expect(committedSeq).toBe(1)
  })
})

describe('replication — idempotent apply (O-R5-3)', () => {
  let dbManager: DatabaseManager
  let authorityStore: AuthorityStore
  let teamStore: TeamStore
  let repl: Replication
  let acks: AckFrame[]

  beforeEach(() => {
    const s = makeStores()
    dbManager = s.dbManager
    authorityStore = s.authorityStore
    teamStore = s.teamStore
    acks = []
    repl = createReplication({
      officeId: OFFICE,
      selfNodeId: HEIR,
      authorityStore,
      replicaStore: teamStore,
      send: (_to, frame) => {
        if (frame.kind === 'ack') acks.push(frame)
      },
      broadcast: () => {},
      getTerm: () => 1,
      getCommittedSeq: () => 0,
      setCommittedSeq: () => {},
      getOnlineStandbys: () => [],
      getHeir: () => null,
      getKnownStandbyCount: () => 0,
    })
  })

  afterEach(() => dbManager.closeAll())

  function replicate(seq: number, fid: string, id: string): BlackboardReplicateFrame {
    return {
      kind: 'blackboard-replicate',
      officeId: OFFICE,
      fromNode: AUTHORITY,
      term: 1,
      seq,
      op: 'post_task',
      payload: makeTaskPayload(id),
      taskId: id,
      fid,
    }
  }

  it('applies a write exactly once across fid retransmit and seq replay', () => {
    const frame = replicate(1, 'fid-1', 't1')
    repl.handleReplicate(AUTHORITY, frame)
    repl.handleReplicate(AUTHORITY, frame) // retransmit (same fid + seq)
    repl.handleReplicate(AUTHORITY, replicate(1, 'fid-1', 't1')) // replay via dispatch
    // The task exists exactly once (a second INSERT would have thrown on PK clash).
    expect(teamStore.getTaskById('t1')).not.toBeNull()
    expect(teamStore.listTasksByTeam(OFFICE)).toHaveLength(1)
    // Every delivery acked (ack may be lost in production → re-ack is correct).
    expect(acks.length).toBe(3)
  })

  it('a lower seq with a NEW fid is still dropped by the seq monotonic gate', () => {
    repl.handleReplicate(AUTHORITY, replicate(1, 'fid-1', 't1'))
    repl.handleReplicate(AUTHORITY, replicate(2, 'fid-2', 't2'))
    // seq 1 again but a different fid: still a duplicate by (officeId, seq).
    repl.handleReplicate(AUTHORITY, replicate(1, 'fid-3', 't1-dup'))
    expect(teamStore.listTasksByTeam(OFFICE)).toHaveLength(2)
    expect(teamStore.getTaskById('t1-dup')).toBeNull()
  })

  it('BK-1: replicate of an id the author already applied optimistically converges (no livelock)', () => {
    // Reproduce the shadow-write round-trip on the AUTHOR's own node: the author
    // optimistically inserted t1 locally (location-aware-blackboard), THEN the
    // authority echoes the same id back as a replicate. A bare INSERT would throw on
    // the primary-key clash, strand replicaAppliedSeq at 0, and livelock every later
    // seq behind hasFid. The idempotent upsert must converge instead.
    teamStore.insertTask(makeTaskPayload('t1') as unknown as BlackboardTask) // optimistic local row

    expect(() => repl.handleReplicate(AUTHORITY, replicate(1, 'fid-1', 't1'))).not.toThrow()
    // The applied water mark advanced past the echoed write — not stranded at 0.
    expect(repl.getAppliedSeq()).toBe(1)
    expect(teamStore.listTasksByTeam(OFFICE)).toHaveLength(1)

    // The next contiguous seq applies cleanly (proves no permanent hole/livelock).
    repl.handleReplicate(AUTHORITY, replicate(2, 'fid-2', 't2'))
    expect(repl.getAppliedSeq()).toBe(2)
    expect(teamStore.listTasksByTeam(OFFICE).map((t) => t.id).sort()).toEqual(['t1', 't2'])

    // Every delivery acked (author, then the follow-on) — the log did not stall.
    expect(acks.length).toBe(2)
  })

  it('BK-1: an optimistic finding row (same id) converges on replicate instead of throwing', () => {
    const findingPayload = {
      id: 'f1',
      teamId: OFFICE,
      epochId: 'epoch-1',
      authorAppId: 'app-x',
      body: 'finding',
      ref: null,
      createdAt: Date.now(),
    }
    teamStore.insertFinding(findingPayload as never) // optimistic local finding

    const frame: BlackboardReplicateFrame = {
      kind: 'blackboard-replicate',
      officeId: OFFICE,
      fromNode: AUTHORITY,
      term: 1,
      seq: 1,
      op: 'post_finding',
      payload: findingPayload,
      fid: 'fid-f1',
    }
    expect(() => repl.handleReplicate(AUTHORITY, frame)).not.toThrow()
    expect(repl.getAppliedSeq()).toBe(1)
    expect(teamStore.listFindingsByEpoch(OFFICE, 'epoch-1')).toHaveLength(1)
  })

  it('cross-restart dedup via authorityStore.hasFid (in-memory dedup bypassed)', () => {
    const frame = replicate(1, 'fid-persist', 't1')
    repl.handleReplicate(AUTHORITY, frame)
    // A fresh replication instance (simulating a restart: empty in-memory dedup)
    // sharing the SAME db must still treat the fid as seen.
    const repl2 = createReplication({
      officeId: OFFICE,
      selfNodeId: HEIR,
      authorityStore,
      replicaStore: teamStore,
      send: () => {},
      broadcast: () => {},
      getTerm: () => 1,
      getCommittedSeq: () => 0,
      setCommittedSeq: () => {},
      getOnlineStandbys: () => [],
      getHeir: () => null,
      getKnownStandbyCount: () => 0,
    })
    repl2.handleReplicate(AUTHORITY, frame) // same fid; seq 1 also already in log
    expect(teamStore.listTasksByTeam(OFFICE)).toHaveLength(1)
  })

  it('restart recovery: a rebuilt standby recovers its applied water mark and keeps applying (no post-restart livelock)', () => {
    // A standby applies seqs 1..3, then "restarts": a fresh instance over the SAME
    // db. Its in-memory replicaAppliedSeq must be seeded from the persisted log, or
    // the next frame (seq 4) looks like a gap that catch-up can never fill (every
    // replayed entry is already persisted → hasFid → ack without advancing).
    for (let i = 1; i <= 3; i++) {
      repl.handleReplicate(AUTHORITY, replicate(i, `fid-${i}`, `t${i}`))
    }
    expect(repl.getAppliedSeq()).toBe(3)

    const repl2 = createReplication({
      officeId: OFFICE,
      selfNodeId: HEIR,
      authorityStore,
      replicaStore: teamStore,
      send: (_to, f) => {
        if (f.kind === 'ack') acks.push(f)
      },
      broadcast: () => {},
      getTerm: () => 1,
      getCommittedSeq: () => 0,
      setCommittedSeq: () => {},
      getOnlineStandbys: () => [],
      getHeir: () => null,
      getKnownStandbyCount: () => 0,
    })
    // The rebuilt instance already knows it is at seq 3 (seeded from the log).
    expect(repl2.getAppliedSeq()).toBe(3)

    // A NEW frame (seq 4) applies contiguously — no gap, no catch-up livelock.
    repl2.handleReplicate(AUTHORITY, replicate(4, 'fid-4', 't4'))
    expect(repl2.getAppliedSeq()).toBe(4)
    expect(teamStore.getTaskById('t4')).not.toBeNull()
    expect(teamStore.listTasksByTeam(OFFICE).map((t) => t.id).sort()).toEqual(['t1', 't2', 't3', 't4'])
  })
})

describe('replication — roster quorum gating (O-R5-4/5)', () => {
  let dbManager: DatabaseManager
  let deps: ReplicationDeps
  let repl: Replication
  let committedSeq: number
  let rosterEpoch: number
  let online: string[]
  let heir: string | null

  beforeEach(() => {
    vi.useFakeTimers()
    const s = makeStores()
    dbManager = s.dbManager
    committedSeq = 0
    rosterEpoch = 0
    online = [HEIR, STANDBY_2]
    heir = HEIR
    deps = {
      officeId: OFFICE,
      selfNodeId: AUTHORITY,
      authorityStore: s.authorityStore,
      replicaStore: s.teamStore,
      send: () => {},
      broadcast: () => {},
      getTerm: () => 1,
      getCommittedSeq: () => committedSeq,
      setCommittedSeq: (n) => (committedSeq = n),
      getOnlineStandbys: () => online,
      getHeir: () => heir,
      getKnownStandbyCount: () => online.length,
      onRosterCommitted: (epoch) => (rosterEpoch = epoch ?? rosterEpoch + 1),
    }
    repl = createReplication(deps)
  })

  afterEach(() => {
    vi.useRealTimers()
    dbManager.closeAll()
  })

  it('O-R5-4: roster write commits + bumps rosterEpoch only on quorum (incl heir)', async () => {
    const promise = repl.replicateRoster('roster_join', { nodeId: 'node-new' })
    expect(rosterEpoch).toBe(0) // not yet committed

    // Heir + majority ack → quorum.
    repl.handleAck(HEIR, { kind: 'ack', officeId: OFFICE, fromNode: HEIR, reFid: 'x', ackedSeq: 1, fid: 'a1' })
    repl.handleAck(STANDBY_2, { kind: 'ack', officeId: OFFICE, fromNode: STANDBY_2, reFid: 'x', ackedSeq: 1, fid: 'a2' })

    await expect(promise).resolves.toBe(true)
    expect(committedSeq).toBe(1)
    expect(rosterEpoch).toBe(1)
  })

  it('O-R5-5: partition (no quorum) → roster write does NOT commit, no rosterEpoch bump', async () => {
    online = []
    heir = null
    // Quorum can never be met: 2 standbys are known online but never ack.
    online = [HEIR, STANDBY_2]
    heir = HEIR

    const promise = repl.replicateRoster('roster_join', { nodeId: 'node-new' })
    // No acks arrive. Advance past the ack timeout.
    vi.advanceTimersByTime(2000)
    await expect(promise).resolves.toBe(false)
    expect(committedSeq).toBe(0)
    expect(rosterEpoch).toBe(0)
  })
})

describe('replication — catch-up (O-R5-6)', () => {
  let dbManager: DatabaseManager
  let authorityStore: AuthorityStore
  let teamStore: TeamStore
  let repl: Replication

  beforeEach(() => {
    const s = makeStores()
    dbManager = s.dbManager
    authorityStore = s.authorityStore
    teamStore = s.teamStore
    repl = createReplication({
      officeId: OFFICE,
      selfNodeId: AUTHORITY,
      authorityStore,
      replicaStore: teamStore,
      send: () => {},
      broadcast: () => {},
      getTerm: () => 1,
      getCommittedSeq: () => 0,
      setCommittedSeq: () => {},
      getOnlineStandbys: () => [],
      getHeir: () => null,
      getKnownStandbyCount: () => 0,
    })
  })

  afterEach(() => dbManager.closeAll())

  it('incremental returns the log gap after lastAckedSeq', () => {
    for (let i = 1; i <= 5; i++) {
      authorityStore.appendLogEntry({
        officeId: OFFICE,
        seq: i,
        term: 1,
        op: 'post_task',
        payload: makeTaskPayload(`t${i}`),
        fid: `fid-${i}`,
        taskId: `t${i}`,
        createdAt: Date.now(),
      })
    }
    const result = repl.buildCatchup(2)
    expect(result.mode).toBe('incremental')
    if (result.mode === 'incremental') {
      expect(result.entries.map((e) => e.seq)).toEqual([3, 4, 5])
    }
  })

  it('snapshot when the gap predates the retained log', () => {
    // Retained log starts at seq 10 (older entries pruned). A standby at seq 3 is
    // behind the retained window → snapshot.
    for (let i = 10; i <= 12; i++) {
      authorityStore.appendLogEntry({
        officeId: OFFICE,
        seq: i,
        term: 1,
        op: 'post_task',
        payload: makeTaskPayload(`t${i}`),
        fid: `fid-${i}`,
        taskId: `t${i}`,
        createdAt: Date.now(),
      })
    }
    // Seed the replica so the snapshot has board content.
    teamStore.insertTask(makeTaskPayload('t10') as unknown as BlackboardTask)
    const result = repl.buildCatchup(3)
    expect(result.mode).toBe('snapshot')
    if (result.mode === 'snapshot') {
      expect(result.snapshot.appliedSeq).toBe(12)
      expect(result.snapshot.tasks.length).toBeGreaterThanOrEqual(1)
    }
  })

  it('snapshot/incremental converge: applying a snapshot reproduces the board', () => {
    teamStore.insertTask(makeTaskPayload('t1', 'alpha') as unknown as BlackboardTask)
    teamStore.insertTask(makeTaskPayload('t2', 'beta') as unknown as BlackboardTask)
    for (let i = 10; i <= 11; i++) {
      authorityStore.appendLogEntry({
        officeId: OFFICE, seq: i, term: 1, op: 'post_task',
        payload: makeTaskPayload(`t${i}`), fid: `fid-${i}`, taskId: `t${i}`, createdAt: Date.now(),
      })
    }
    const result = repl.buildCatchup(0) // far behind → snapshot
    expect(result.mode).toBe('snapshot')
    if (result.mode === 'snapshot') {
      const fresh = makeStores()
      try {
        for (const t of result.snapshot.tasks) fresh.teamStore.insertTask(t)
        const ids = fresh.teamStore.listTasksByTeam(OFFICE).map((t) => t.id).sort()
        expect(ids).toEqual(['t1', 't2'])
      } finally {
        fresh.dbManager.closeAll()
      }
    }
  })
})

describe('replication — member write admission (O-R5-7)', () => {
  let dbManager: DatabaseManager
  let authorityStore: AuthorityStore
  let teamStore: TeamStore
  let currentTerm: number
  let applied: Array<{ op: string; taskId?: string }>
  let sent: Array<{ to: string; frame: M2Frame }>
  let repl: Replication

  beforeEach(() => {
    const s = makeStores()
    dbManager = s.dbManager
    authorityStore = s.authorityStore
    teamStore = s.teamStore
    currentTerm = 2
    applied = []
    sent = []
    repl = createReplication({
      officeId: OFFICE,
      selfNodeId: AUTHORITY,
      authorityStore,
      replicaStore: teamStore,
      send: (to, frame) => sent.push({ to, frame }),
      broadcast: () => {},
      getTerm: () => currentTerm,
      getCommittedSeq: () => 0,
      setCommittedSeq: () => {},
      getOnlineStandbys: () => [],
      getHeir: () => null,
      getKnownStandbyCount: () => 0,
      applyMemberWrite: (rec) => applied.push({ op: rec.op, taskId: rec.taskId }),
    })
  })

  afterEach(() => dbManager.closeAll())

  function memberWrite(term: number, fid: string): BlackboardWriteFrame {
    return {
      kind: 'blackboard-write',
      officeId: OFFICE,
      fromNode: 'node-member',
      term,
      op: 'post_task',
      payload: { ...makeTaskPayload('mt1'), teamId: OFFICE, epochId: 'epoch-1' },
      taskId: 'mt1',
      fid,
    }
  }

  it('O-R5-7: a stale-term member write is rejected (EPOCH_STALE), no apply', () => {
    repl.handleBlackboardWrite('node-member', memberWrite(1, 'fid-stale')) // term 1 < 2
    expect(applied).toHaveLength(0)
    const reject = sent.find((s) => s.frame.kind === 'reject')
    expect(reject).toBeDefined()
    if (reject && reject.frame.kind === 'reject') {
      expect(reject.frame.reason).toBe('EPOCH_STALE')
    }
  })

  it('a current-term member write is admitted and applied through the kernel', () => {
    repl.handleBlackboardWrite('node-member', memberWrite(2, 'fid-ok'))
    expect(applied).toEqual([{ op: 'post_task', taskId: 'mt1' }])
  })

  it('a member write denied by the scope gate is rejected (SCOPE_DENIED)', () => {
    const gated = createReplication({
      officeId: OFFICE,
      selfNodeId: AUTHORITY,
      authorityStore,
      replicaStore: teamStore,
      send: (to, frame) => sent.push({ to, frame }),
      broadcast: () => {},
      getTerm: () => currentTerm,
      getCommittedSeq: () => 0,
      setCommittedSeq: () => {},
      getOnlineStandbys: () => [],
      getHeir: () => null,
      getKnownStandbyCount: () => 0,
      applyMemberWrite: (rec) => applied.push({ op: rec.op, taskId: rec.taskId }),
      admitMemberWrite: () => false,
    })
    gated.handleBlackboardWrite('node-member', memberWrite(2, 'fid-scoped'))
    expect(applied).toHaveLength(0)
    const reject = sent.find((s) => s.frame.kind === 'reject' && s.frame.reason === 'SCOPE_DENIED')
    expect(reject).toBeDefined()
  })

  it('a duplicate member write (same fid) is not applied twice', () => {
    repl.handleBlackboardWrite('node-member', memberWrite(2, 'fid-dup'))
    repl.handleBlackboardWrite('node-member', memberWrite(2, 'fid-dup'))
    expect(applied).toHaveLength(1)
  })
})

describe('replication — catch-up backfills a missed seq (C9)', () => {
  it('a standby that misses a middle frame requests catch-up and fills the hole', () => {
    // Authority produces three writes; capture the replicate frames it fans out
    // and any directed sends (the catch-up response).
    const authStores = makeStores()
    const broadcasts: BlackboardReplicateFrame[] = []
    const authSent: M2Frame[] = []
    let committed = 0
    const authority = createReplication({
      officeId: OFFICE,
      selfNodeId: AUTHORITY,
      authorityStore: authStores.authorityStore,
      replicaStore: authStores.teamStore,
      send: (_to, frame) => authSent.push(frame),
      broadcast: (f) => broadcasts.push(f as BlackboardReplicateFrame),
      getTerm: () => 1,
      getCommittedSeq: () => committed,
      setCommittedSeq: (s) => (committed = s),
      getOnlineStandbys: () => [],
      getHeir: () => null,
      getKnownStandbyCount: () => 0,
    })
    for (let i = 1; i <= 3; i++) {
      authority.captureLocalWrite({
        teamId: OFFICE,
        epochId: 'epoch-1',
        op: 'post_task',
        payload: makeTaskPayload(`t${i}`),
        taskId: `t${i}`,
      })
    }
    expect(broadcasts.map((f) => f.seq)).toEqual([1, 2, 3])

    // A standby on its own store. Its outbound frames route back to the authority.
    const sbStores = makeStores()
    const sbSent: Array<{ to: string; frame: M2Frame }> = []
    const standby = createReplication({
      officeId: OFFICE,
      selfNodeId: HEIR,
      authorityStore: sbStores.authorityStore,
      replicaStore: sbStores.teamStore,
      send: (to, frame) => sbSent.push({ to, frame }),
      broadcast: () => {},
      getTerm: () => 1,
      getCommittedSeq: () => 0,
      setCommittedSeq: () => {},
      getOnlineStandbys: () => [],
      getHeir: () => null,
      getKnownStandbyCount: () => 0,
    })

    // Deliver seq 1, DROP seq 2, deliver seq 3 → the standby sees a gap.
    standby.handleReplicate(AUTHORITY, broadcasts[0])
    standby.handleReplicate(AUTHORITY, broadcasts[2])

    // The hole is NOT skipped: applied stays at 1, and a catch-up was requested.
    expect(standby.getAppliedSeq()).toBe(1)
    const req = sbSent.find((s) => s.frame.kind === 'catchup-request')
    expect(req).toBeDefined()
    expect((req!.frame as CatchupRequestFrame).lastAckedSeq).toBe(1)

    // Authority serves the catch-up; deliver the response back to the standby.
    authority.handleM2Frame(HEIR, req!.frame)
    const resp = authSent.find((f) => f.kind === 'catchup-response') as CatchupResponseFrame
    expect(resp.mode).toBe('incremental')
    expect(resp.entries!.map((e) => e.seq)).toEqual([2, 3])

    standby.handleM2Frame(AUTHORITY, resp)

    // The hole is filled: standby now holds all three, contiguously.
    expect(standby.getAppliedSeq()).toBe(3)
    expect(sbStores.teamStore.listTasksByTeam(OFFICE).map((t) => t.id).sort()).toEqual(['t1', 't2', 't3'])
    sbStores.dbManager.closeAll()
    authStores.dbManager.closeAll()
  })
})

describe('replication — snapshot reconcile (replace-apply, #4)', () => {
  it('a snapshot prunes a stale/extra standby row and overwrites a diverged field', () => {
    const sbStores = makeStores()
    const standby = createReplication({
      officeId: OFFICE,
      selfNodeId: HEIR,
      authorityStore: sbStores.authorityStore,
      replicaStore: sbStores.teamStore,
      send: () => {},
      broadcast: () => {},
      getTerm: () => 1,
      getCommittedSeq: () => 0,
      setCommittedSeq: () => {},
      getOnlineStandbys: () => [],
      getHeir: () => null,
      getKnownStandbyCount: () => 0,
    })

    // Standby holds a stale board: t1 with a diverged status (e.g. a rejected
    // optimistic write) and an extra task the authority no longer has.
    sbStores.teamStore.insertTask({
      ...(makeTaskPayload('t1') as unknown as BlackboardTask),
      status: 'done',
    })
    sbStores.teamStore.insertTask(makeTaskPayload('t-stale') as unknown as BlackboardTask)

    const snapshot: CatchupResponseFrame = {
      kind: 'catchup-response',
      officeId: OFFICE,
      fromNode: AUTHORITY,
      term: 1,
      reFid: 'req-1',
      mode: 'snapshot',
      snapshot: {
        tasks: [makeTaskPayload('t1'), makeTaskPayload('t2')], // authoritative: status 'pending'
        findings: [],
        roster: [],
        appliedSeq: 12,
        term: 1,
      },
      fid: 'resp-1',
    }

    standby.handleM2Frame(AUTHORITY, snapshot)

    // Extra row pruned; missing row inserted; the board matches authority exactly.
    expect(sbStores.teamStore.listTasksByTeam(OFFICE).map((t) => t.id).sort()).toEqual(['t1', 't2'])
    // The diverged field was overwritten back to authority truth (not kept).
    expect(sbStores.teamStore.getTaskById('t1')!.status).toBe('pending')
    expect(standby.getAppliedSeq()).toBe(12)
    sbStores.dbManager.closeAll()
  })
})
