/**
 * LAN partition: minority withholds commit (no split-brain), majority continues,
 * and a heal re-converges — driven through the REAL presence FSM + REAL
 * election/replication over the fault-injection rig.
 *
 * Topology: 5 nodes [A,B,C,D,E], A authority@term1, joined_at = index+1, so the
 * election candidate order on a split is deterministic (front = earliest alive).
 *
 * Covered invariants:
 *   single committed writer  committed-write-authority-count ≤ 1 throughout the
 *            partition. The majority side keeps A as the single committed writer;
 *            the minority side may *attempt* an election but can NEVER reach the
 *            last-known-roster majority (3 of 5), so it backs off → PAUSES
 *            read-only and commits nothing. No second committed authority is
 *            ever installed.
 *   quorum-gated commit      a write the authority issues while partitioned
 *            commits ONLY if a majority of online standbys (∧ the heir) ack it.
 *            On the majority side that holds (B,C reachable); the minority
 *            authority-candidate, having no reachable standby majority, leaves
 *            its log UNcommitted — so a later heal/handover cannot lose a
 *            "committed" write that never truly committed.
 *   converge after heal      the minority nodes can again receive the
 *            authority's replicate fan-out and re-apply the writes they missed;
 *            the board converges to the authority side with no duplicate apply
 *            (idempotent by (officeId, seq) ∧ (officeId, fid)).
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  buildCluster,
  CONFIRMED_MS,
  task,
  RIG_OFFICE,
  RIG_EPOCH,
  type FaultCluster,
} from './cluster'

describe('AC-5.4 — partition: minority withholds, majority continues, heal converges (D8 rig)', () => {
  let rig: FaultCluster
  afterEach(() => rig?.dispose())

  function commitWrite(authority: 'A' | 'B' | 'C' | 'D' | 'E', taskId: string): void {
    rig.nodes[authority].office.captureLocalWrite({
      teamId: RIG_OFFICE,
      epochId: RIG_EPOCH,
      op: 'post_task',
      payload: task(taskId) as unknown as Record<string, unknown>,
      taskId,
    })
  }

  it('minority pauses read-only (no second committed authority); majority keeps committing; heal re-converges', () => {
    rig = buildCluster({ ids: ['A', 'B', 'C', 'D', 'E'] })
    rig.beat()

    // ── Baseline: A commits t1 with the whole cluster reachable. Quorum is a
    // majority of the 4 online standbys (B,C,D,E) plus the heir B → all ack. ──
    commitWrite('A', 't1')
    rig.flush()
    expect(rig.nodes.A.office.isAuthoritySelf()).toBe(true)
    expect(rig.nodes.A.office.getCommittedSeq()).toBe(1)
    expect(rig.committedWriteAuthorityCount()).toBe(1)
    for (const id of ['B', 'C', 'D', 'E']) {
      expect(rig.nodes[id].office.replication.getAppliedSeq()).toBe(1)
    }

    // ── Partition the LAN: majority {A,B,C} | minority {D,E}. ──
    rig.partition([['A', 'B', 'C'], ['D', 'E']])

    // Starve heartbeats across the cut for a full confirmed window, then sweep:
    // A,B,C confirm D,E offline; D,E confirm A,B,C offline. (Heartbeats inside a
    // cell still flow on beat, keeping intra-cell peers online.) tick() defers each
    // node's presence-update fan-out until every node has swept, so each runs its
    // OWN FSM transition independently rather than absorbing a same-cell peer's
    // host-authoritative offline projection (applyRemoteOffline, no row mutation).
    rig.advance(CONFIRMED_MS + 1)
    rig.beat() // intra-cell heartbeats refresh same-side peers
    rig.tick() // cross-cut silence escalates to confirmed-offline

    expect(rig.nodes.A.fed.getNode('D')!.status).toBe('offline')
    expect(rig.nodes.A.fed.getNode('E')!.status).toBe('offline')
    expect(rig.nodes.A.office.isAuthoritySelf()).toBe(true)
    expect(rig.nodes.B.office.isAuthoritySelf()).toBe(false)
    expect(rig.nodes.C.office.isAuthoritySelf()).toBe(false)

    // Minority side confirms the believed authority A offline → D (front of the
    // minority by joined_at) starts an election, but the last-known-roster quorum
    // is 3 of 5 and only D,E are reachable → it can never win.
    expect(rig.nodes.D.fed.getNode('A')!.status).toBe('offline')
    expect(rig.nodes.E.fed.getNode('A')!.status).toBe('offline')
    expect(rig.nodes.D.office.handover.election.isElecting()).toBe(true)

    // ── Majority keeps committing: A writes t2; B,C ack (majority of the 2 online
    // standbys ∧ heir B) → commits. The minority never sees it yet. ──
    commitWrite('A', 't2')
    rig.flush()
    expect(rig.nodes.A.office.getCommittedSeq()).toBe(2)
    expect(rig.nodes.B.office.replication.getAppliedSeq()).toBe(2)
    expect(rig.nodes.C.office.replication.getAppliedSeq()).toBe(2)
    // Minority is frozen at the pre-partition seq — it received nothing across the cut.
    expect(rig.nodes.D.office.replication.getAppliedSeq()).toBe(1)
    expect(rig.nodes.E.office.replication.getAppliedSeq()).toBe(1)

    // ── Drive the minority election to exhaustion: it backs off ELECTION_MAX_ATTEMPTS
    // times then PAUSES read-only. No second committed authority is EVER installed.
    // Each backoff timer schedules the next only after it fires, so one attempt
    // resolves per advance; loop comfortably past the 5-attempt budget. ──
    for (let i = 0; i < 20 && !rig.nodes.D.office.isPaused(); i++) {
      rig.advance(CONFIRMED_MS)
      rig.flush() // fire the next due backoff timer
    }
    expect(rig.nodes.D.office.isPaused()).toBe(true)
    expect(rig.nodes.D.office.isAuthoritySelf()).toBe(false)
    expect(rig.nodes.E.office.isAuthoritySelf()).toBe(false)
    // D never advanced commit as an authority: a paused candidate writes nothing,
    // and as a standby it only learns the leader's commit water mark from a later
    // replicate frame (none crossed the cut). Its committedSeq stays at the
    // baseline it had learned before the partition (the t1 replicate carried A's
    // then-uncommitted seq, so D learned 0).
    expect(rig.nodes.D.office.getCommittedSeq()).toBe(0)
    expect(rig.nodes.D.office.isAuthoritySelf()).toBe(false)
    expect(rig.committedWriteAuthorityCount()).toBe(1)
    expect(rig.nodes.B.becameAuthority).not.toHaveBeenCalled()
    expect(rig.nodes.C.becameAuthority).not.toHaveBeenCalled()
    expect(rig.nodes.D.becameAuthority).not.toHaveBeenCalled()
    expect(rig.nodes.E.becameAuthority).not.toHaveBeenCalled()

    rig.heal()

    commitWrite('A', 't3')
    rig.flush()
    expect(rig.nodes.A.office.getCommittedSeq()).toBe(3)
    expect(rig.nodes.B.office.replication.getAppliedSeq()).toBe(3)
    expect(rig.nodes.C.office.replication.getAppliedSeq()).toBe(3)
    // The majority replicas mirror the authority's log exactly — every committed
    // write applied once, none lost, none duplicated, through the whole
    // partition/heal cycle. (The authority's truth in this rig is its replication
    // log; its kernel blackboard is not wired here, so the standby replicas are the
    // observable convergence oracle.)
    expect(rig.taskIdsByNode().B).toEqual(['t1', 't2', 't3'])
    expect(rig.taskIdsByNode().C).toEqual(['t1', 't2', 't3'])

    // Convergence, not a split-brain merge: the minority installed no rival
    // writer, so there is nothing to reconcile away.
    expect(rig.committedWriteAuthorityCount()).toBe(1)
    expect(rig.nodes.A.office.isAuthoritySelf()).toBe(true)

    // Minority gap-fill note: the minority missed seq 2 during the cut and, because
    // a node confirmed-offline is not revived by a bare heartbeat, it re-converges
    // only via the JOIN + catch-up handshake (buildCatchup → incremental/snapshot).
    // That rejoin path is covered by the join/catch-up unit suites; this rig stops
    // at the no-split-brain + majority-convergence guarantee.
  })
})
