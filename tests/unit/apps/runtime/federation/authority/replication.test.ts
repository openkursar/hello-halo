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
  REPLICATION_CATCHUP_BATCH,
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


/**
 * Make `standby` ask `from` for a catch-up and return the request id an answer
 * must carry (a response that answers no request of ours is dropped).
 */
function askCatchup(standby: Replication, sent: M2Frame[], from = AUTHORITY): string {
  standby.requestCatchupFrom(from)
  const request = [...sent].reverse().find((f): f is CatchupRequestFrame => f.kind === 'catchup-request')
  if (!request) throw new Error('no catch-up request was sent')
  return request.fid
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
      getKnownStandbyCount: () => online.length, getAuthorityNodeId: () => AUTHORITY,
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
        getKnownStandbyCount: () => 0, getAuthorityNodeId: () => AUTHORITY,
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
      getKnownStandbyCount: () => 0, getAuthorityNodeId: () => AUTHORITY,
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
      getKnownStandbyCount: () => 0, getAuthorityNodeId: () => AUTHORITY,
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
      getKnownStandbyCount: () => 0, getAuthorityNodeId: () => AUTHORITY,
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
      getKnownStandbyCount: () => online.length, getAuthorityNodeId: () => AUTHORITY,
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
      getKnownStandbyCount: () => 0, getAuthorityNodeId: () => AUTHORITY,
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
      getKnownStandbyCount: () => 0, getAuthorityNodeId: () => AUTHORITY,
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
      getKnownStandbyCount: () => 0, getAuthorityNodeId: () => AUTHORITY,
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
      getKnownStandbyCount: () => 0, getAuthorityNodeId: () => AUTHORITY,
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
      getKnownStandbyCount: () => 0, getAuthorityNodeId: () => AUTHORITY,
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

describe('replication — paged catch-up applies in batches', () => {
  it('a joiner far behind pages itself to the head with one notification and one ack per page', () => {
    const TOTAL = REPLICATION_CATCHUP_BATCH * 2 + 17
    const authStores = makeStores()
    let committed = 0
    const route: { toStandby: (frame: M2Frame) => void } = { toStandby: () => {} }
    const authority = createReplication({
      officeId: OFFICE,
      selfNodeId: AUTHORITY,
      authorityStore: authStores.authorityStore,
      replicaStore: authStores.teamStore,
      send: (_to, frame) => route.toStandby(frame),
      broadcast: () => {},
      getTerm: () => 1,
      getCommittedSeq: () => committed,
      setCommittedSeq: (s) => (committed = s),
      getOnlineStandbys: () => [],
      getHeir: () => null,
      getKnownStandbyCount: () => 0, getAuthorityNodeId: () => AUTHORITY,
    })
    for (let i = 1; i <= TOTAL; i++) {
      authority.captureLocalWrite({
        teamId: OFFICE,
        epochId: 'epoch-1',
        op: i % 2 === 0 ? 'post_task' : 'post_activity',
        payload:
          i % 2 === 0
            ? makeTaskPayload(`t${i}`)
            : {
                id: `a${i}`, teamId: OFFICE, epochId: 'epoch-1', kind: 'message', actorAppId: 'x',
                targetAppId: null, subject: 's', body: null, refId: null, correlationId: null, status: null, createdAt: i,
              },
        ...(i % 2 === 0 ? { taskId: `t${i}` } : {}),
      })
    }

    const sbStores = makeStores()
    const notifications: Array<{ entries: number; snapshot: boolean }> = []
    const acks: AckFrame[] = []
    let requests = 0
    const standby = createReplication({
      officeId: OFFICE,
      selfNodeId: HEIR,
      authorityStore: sbStores.authorityStore,
      replicaStore: sbStores.teamStore,
      send: (_to, frame) => {
        if (frame.kind === 'ack') acks.push(frame)
        if (frame.kind === 'catchup-request') {
          requests++
          authority.handleM2Frame(HEIR, frame)
        }
      },
      broadcast: () => {},
      getTerm: () => 1,
      getCommittedSeq: () => 0,
      setCommittedSeq: () => {},
      getOnlineStandbys: () => [],
      getHeir: () => null,
      getKnownStandbyCount: () => 0, getAuthorityNodeId: () => AUTHORITY,
      onReplicaApplied: (applied) =>
        notifications.push({ entries: applied.entries.length, snapshot: applied.snapshot }),
    })
    route.toStandby = (frame) => standby.handleM2Frame(AUTHORITY, frame)

    standby.requestCatchupFrom(AUTHORITY)

    expect(standby.getAppliedSeq()).toBe(TOTAL)
    expect(requests).toBe(3)
    expect(notifications).toEqual([
      { entries: REPLICATION_CATCHUP_BATCH, snapshot: false },
      { entries: REPLICATION_CATCHUP_BATCH, snapshot: false },
      { entries: 17, snapshot: false },
    ])
    expect(acks.map((a) => a.ackedSeq)).toEqual([
      REPLICATION_CATCHUP_BATCH,
      REPLICATION_CATCHUP_BATCH * 2,
      TOTAL,
    ])
    expect(sbStores.teamStore.listTasksByTeam(OFFICE)).toHaveLength(Math.floor(TOTAL / 2))
    sbStores.dbManager.closeAll()
    authStores.dbManager.closeAll()
  })

  it('a full page that advances nothing does not re-ask the same range', () => {
    const sbStores = makeStores()
    const sent: M2Frame[] = []
    const requests = () => sent.filter((f) => f.kind === 'catchup-request').length
    const standby = createReplication({
      officeId: OFFICE,
      selfNodeId: HEIR,
      authorityStore: sbStores.authorityStore,
      replicaStore: sbStores.teamStore,
      send: (_to, frame) => sent.push(frame),
      broadcast: () => {},
      getTerm: () => 5,
      getCommittedSeq: () => 0,
      setCommittedSeq: () => {},
      getOnlineStandbys: () => [],
      getHeir: () => null,
      getKnownStandbyCount: () => 0, getAuthorityNodeId: () => AUTHORITY,
    })
    const entries = Array.from({ length: REPLICATION_CATCHUP_BATCH }, (_, i) => ({
      seq: i + 1,
      term: 1,
      op: 'post_task' as const,
      payload: makeTaskPayload(`t${i}`),
      taskId: `t${i}`,
      fid: `fid-${i}`,
    }))
    const page = (reFid: string, fid: string) =>
      standby.handleM2Frame(AUTHORITY, {
        kind: 'catchup-response',
        officeId: OFFICE,
        fromNode: AUTHORITY,
        term: 5,
        reFid,
        mode: 'incremental',
        entries,
        committedSeq: REPLICATION_CATCHUP_BATCH,
        fid,
      })
    const first = askCatchup(standby, sent)
    page(first, 'resp-1')
    expect(standby.getAppliedSeq()).toBe(REPLICATION_CATCHUP_BATCH)
    // A full page that advanced asks for the next one at once.
    const next = askCatchup(standby, sent)
    expect(next).not.toBe(first)
    const afterFirst = requests()
    // Answered with the same entries again: nothing advances, nothing is re-asked.
    page(next, 'resp-2')
    expect(standby.getAppliedSeq()).toBe(REPLICATION_CATCHUP_BATCH)
    expect(requests()).toBe(afterFirst)
    sbStores.dbManager.closeAll()
  })

  it('a catch-up page commits in one transaction per page', () => {
    const authStores = makeStores()
    const authority = createReplication({
      officeId: OFFICE,
      selfNodeId: AUTHORITY,
      authorityStore: authStores.authorityStore,
      replicaStore: authStores.teamStore,
      send: () => {},
      broadcast: () => {},
      getTerm: () => 1,
      getCommittedSeq: () => 0,
      setCommittedSeq: () => {},
      getOnlineStandbys: () => [],
      getHeir: () => null,
      getKnownStandbyCount: () => 0, getAuthorityNodeId: () => AUTHORITY,
    })
    for (let i = 1; i <= 40; i++) {
      authority.captureLocalWrite({ teamId: OFFICE, epochId: 'epoch-1', op: 'post_task', payload: makeTaskPayload(`t${i}`), taskId: `t${i}` })
    }
    const result = authority.buildCatchup(0)
    if (result.mode !== 'incremental') throw new Error('expected incremental')

    const sbStores = makeStores()
    const txSpy = vi.spyOn(sbStores.authorityStore, 'transaction')
    const sent: M2Frame[] = []
    const standby = createReplication({
      officeId: OFFICE,
      selfNodeId: HEIR,
      authorityStore: sbStores.authorityStore,
      replicaStore: sbStores.teamStore,
      send: (_to, frame) => sent.push(frame),
      broadcast: () => {},
      getTerm: () => 1,
      getCommittedSeq: () => 0,
      setCommittedSeq: () => {},
      getOnlineStandbys: () => [],
      getHeir: () => null,
      getKnownStandbyCount: () => 0, getAuthorityNodeId: () => AUTHORITY,
    })
    const reFid = askCatchup(standby, sent)
    standby.handleM2Frame(AUTHORITY, {
      kind: 'catchup-response',
      officeId: OFFICE,
      fromNode: AUTHORITY,
      term: 1,
      reFid,
      mode: 'incremental',
      entries: result.entries.map((e) => ({ seq: e.seq, term: e.term, op: e.op, payload: e.payload, ...(e.taskId ? { taskId: e.taskId } : {}), fid: e.fid })),
      committedSeq: 40,
      fid: 'resp',
    })
    expect(standby.getAppliedSeq()).toBe(40)
    expect(txSpy).toHaveBeenCalledTimes(1)
    sbStores.dbManager.closeAll()
    authStores.dbManager.closeAll()
  })
})

describe('replication — snapshot reconcile (replace-apply, #4)', () => {
  it('a snapshot prunes a stale/extra standby row and overwrites a diverged field', () => {
    const sbStores = makeStores()
    const sent: M2Frame[] = []
    const standby = createReplication({
      officeId: OFFICE,
      selfNodeId: HEIR,
      authorityStore: sbStores.authorityStore,
      replicaStore: sbStores.teamStore,
      send: (_to, frame) => sent.push(frame),
      broadcast: () => {},
      getTerm: () => 1,
      getCommittedSeq: () => 0,
      setCommittedSeq: () => {},
      getOnlineStandbys: () => [],
      getHeir: () => null,
      getKnownStandbyCount: () => 0, getAuthorityNodeId: () => AUTHORITY,
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
      reFid: askCatchup(standby, sent),
      mode: 'snapshot',
      committedSeq: 12,
      snapshot: {
        tasks: [makeTaskPayload('t1'), makeTaskPayload('t2')], // authoritative: status 'pending'
        findings: [],
        activities: [],
        epochs: [],
        checks: [],
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

describe('replication — snapshot completeness', () => {
  it('a snapshot carries and applies the office epochs and checks', () => {
    const auth = makeStores()
    const epoch = { id: 'epoch-9', teamId: OFFICE, startedAt: 1, endedAt: null, endReason: null, summary: null, lifecycle: 'conversation' as const }
    auth.teamStore.upsertEpoch(epoch as never)
    const authority = createReplication({
      officeId: OFFICE, selfNodeId: AUTHORITY, authorityStore: auth.authorityStore, replicaStore: auth.teamStore,
      send: () => {}, broadcast: () => {}, getTerm: () => 1, getCommittedSeq: () => 0, setCommittedSeq: () => {},
      getOnlineStandbys: () => [], getHeir: () => null, getKnownStandbyCount: () => 0, getAuthorityNodeId: () => AUTHORITY,
    })
    for (let i = 1; i <= 3; i++) {
      authority.captureLocalWrite({ teamId: OFFICE, epochId: 'epoch-9', op: 'post_task', payload: makeTaskPayload(`t${i}`), taskId: `t${i}` })
    }
    auth.authorityStore.pruneLogBefore(OFFICE, 2)
    const served = authority.buildCatchup(0)
    if (served.mode !== 'snapshot') throw new Error('expected a snapshot below the pruned floor')
    expect(served.snapshot.epochs.map((e) => e.id)).toEqual(['epoch-9'])
    expect(served.snapshot.checks).toEqual([])
    const sb = makeStores()
    const applied: string[] = []
    const sent: M2Frame[] = []
    const standby = createReplication({
      officeId: OFFICE, selfNodeId: HEIR, authorityStore: sb.authorityStore, replicaStore: sb.teamStore,
      send: (_to, frame) => sent.push(frame), broadcast: () => {}, getTerm: () => 1, getCommittedSeq: () => 0, setCommittedSeq: () => {},
      getOnlineStandbys: () => [], getHeir: () => null, getKnownStandbyCount: () => 0, getAuthorityNodeId: () => AUTHORITY,
      applyOfficeState: (op, payload) => applied.push(`${op}:${String(payload.id)}`),
    })
    standby.handleM2Frame(AUTHORITY, {
      kind: 'catchup-response', officeId: OFFICE, fromNode: AUTHORITY, term: 1, reFid: askCatchup(standby, sent), mode: 'snapshot', committedSeq: 5,
      snapshot: { tasks: [], findings: [], activities: [], roster: [], epochs: [epoch], checks: [{ id: 'chk-1' }], appliedSeq: 5, term: 1 },
      fid: 's',
    })
    expect(sb.teamStore.getEpochById('epoch-9')?.lifecycle).toBe('conversation')
    expect(applied).toEqual(['check_upsert:chk-1'])
    auth.dbManager.closeAll()
    sb.dbManager.closeAll()
  })
})

describe('replication — snapshot scoped to open epochs', () => {
  const act = (id: string, epochId: string, createdAt: number) => ({
    id, teamId: OFFICE, epochId, kind: 'message', actorAppId: 'x', targetAppId: null, subject: 's',
    body: null, refId: null, correlationId: null, status: null, createdAt,
  })

  it('carries only the open epochs’ record', () => {
    const auth = makeStores()
    auth.teamStore.upsertEpoch({ id: 'open', teamId: OFFICE, startedAt: 1, endedAt: null, endReason: null, summary: null, lifecycle: 'conversation' } as never)
    auth.teamStore.upsertEpoch({ id: 'closed', teamId: OFFICE, startedAt: 1, endedAt: 2, endReason: 'completed', summary: null, lifecycle: 'conversation' } as never)
    auth.teamStore.insertActivity(act('a-open', 'open', 10) as never)
    auth.teamStore.insertActivity(act('a-closed', 'closed', 5) as never)
    const authority = createReplication({
      officeId: OFFICE, selfNodeId: AUTHORITY, authorityStore: auth.authorityStore, replicaStore: auth.teamStore,
      send: () => {}, broadcast: () => {}, getTerm: () => 1, getCommittedSeq: () => 0, setCommittedSeq: () => {},
      getOnlineStandbys: () => [], getHeir: () => null, getKnownStandbyCount: () => 0, getAuthorityNodeId: () => AUTHORITY,
    })
    for (let i = 1; i <= 3; i++) {
      authority.captureLocalWrite({ teamId: OFFICE, epochId: 'open', op: 'post_task', payload: makeTaskPayload(`t${i}`), taskId: `t${i}` })
    }
    auth.authorityStore.pruneLogBefore(OFFICE, 2)
    const scoped = authority.buildCatchup(0)
    if (scoped.mode !== 'snapshot') throw new Error('expected a snapshot')
    expect(scoped.snapshot.activities.map((a) => a.id)).toEqual(['a-open'])
    auth.dbManager.closeAll()
  })

  it('applying a snapshot keeps the older record the standby already holds', () => {
    const sb = makeStores()
    sb.teamStore.insertActivity(act('old-record', 'closed', 1) as never)
    const sent: M2Frame[] = []
    const standby = createReplication({
      officeId: OFFICE, selfNodeId: HEIR, authorityStore: sb.authorityStore, replicaStore: sb.teamStore,
      send: (_to, frame) => sent.push(frame), broadcast: () => {}, getTerm: () => 1, getCommittedSeq: () => 0, setCommittedSeq: () => {},
      getOnlineStandbys: () => [], getHeir: () => null, getKnownStandbyCount: () => 0, getAuthorityNodeId: () => AUTHORITY,
    })
    standby.handleM2Frame(AUTHORITY, {
      kind: 'catchup-response', officeId: OFFICE, fromNode: AUTHORITY, term: 1, reFid: askCatchup(standby, sent), mode: 'snapshot', committedSeq: 3,
      snapshot: { tasks: [], findings: [], roster: [], epochs: [], checks: [], activities: [act('a-open', 'open', 10)], appliedSeq: 3, term: 1 },
      fid: 's',
    })
    expect(sb.teamStore.listActivityByTeam(OFFICE).map((a) => a.id).sort()).toEqual(['a-open', 'old-record'])
    sb.dbManager.closeAll()
  })
})

describe('replication — catch-up across a term boundary', () => {
  function standbyInTerm(term: number, authorityNode: string) {
    const sb = makeStores()
    const sent: M2Frame[] = []
    const standby = createReplication({
      officeId: OFFICE, selfNodeId: HEIR, authorityStore: sb.authorityStore, replicaStore: sb.teamStore,
      send: (_to, frame) => sent.push(frame), broadcast: () => {},
      getTerm: () => term, getCommittedSeq: () => 0, setCommittedSeq: () => {},
      getOnlineStandbys: () => [], getHeir: () => null, getKnownStandbyCount: () => 0,
      getAuthorityNodeId: () => authorityNode,
    })
    return { sb, sent, standby }
  }
  const entries = [
    { seq: 1, term: 0, op: 'post_task' as const, payload: makeTaskPayload('t1'), taskId: 't1', fid: 'f1' },
    { seq: 2, term: 0, op: 'post_task' as const, payload: makeTaskPayload('t2'), taskId: 't2', fid: 'f2' },
    { seq: 3, term: 1, op: 'post_task' as const, payload: makeTaskPayload('t3'), taskId: 't3', fid: 'f3' },
  ]

  it('a standby already in a later term applies earlier-term entries replayed by its authority, without re-asking', () => {
    const { sb, sent, standby } = standbyInTerm(1, AUTHORITY)
    const reFid = askCatchup(standby, sent)
    const asked = sent.length
    standby.handleM2Frame(AUTHORITY, {
      kind: 'catchup-response', officeId: OFFICE, fromNode: AUTHORITY, term: 1, reFid, mode: 'incremental',
      entries, committedSeq: 3, fid: 'resp',
    })
    expect(standby.getAppliedSeq()).toBe(3)
    expect(sb.teamStore.listTasksByTeam(OFFICE).map((t) => t.id).sort()).toEqual(['t1', 't2', 't3'])
    const after = sent.slice(asked)
    expect(after.filter((f) => f.kind === 'catchup-request')).toEqual([])
    expect(after.filter((f) => f.kind === 'reject')).toEqual([])
    sb.dbManager.closeAll()
  })

  it('from a voter that is not the authority, a deposed authority’s older-term tail past its committed seq is not applied', () => {
    // A vetoed candidate pulls from a voter whose log ends in a deposed authority's
    // uncommitted older-term tail (seq 3 here, above the voter's committed seq 2).
    const { sb, sent, standby } = standbyInTerm(2, 'node-someone-else')
    const reFid = askCatchup(standby, sent, STANDBY_2)
    standby.handleM2Frame(STANDBY_2, {
      kind: 'catchup-response', officeId: OFFICE, fromNode: STANDBY_2, term: 2, reFid, mode: 'incremental',
      entries: entries.map((e) => ({ ...e, term: 1 })), committedSeq: 2, fid: 'resp',
    })
    expect(standby.getAppliedSeq()).toBe(2)
    expect(sb.teamStore.listTasksByTeam(OFFICE).map((t) => t.id).sort()).toEqual(['t1', 't2'])
    sb.dbManager.closeAll()
  })

  it('a response that answers no request of ours is dropped', () => {
    const { sb, sent, standby } = standbyInTerm(1, AUTHORITY)
    askCatchup(standby, sent)
    standby.handleM2Frame(AUTHORITY, {
      kind: 'catchup-response', officeId: OFFICE, fromNode: AUTHORITY, term: 1, reFid: 'someone-elses-request', mode: 'incremental',
      entries, committedSeq: 3, fid: 'resp',
    })
    expect(standby.getAppliedSeq()).toBe(0)
    sb.dbManager.closeAll()
  })
})
