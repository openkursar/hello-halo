/**
 * Resilience-upgrade regressions on the fault rig (deterministic clock):
 *
 *  1. Freshness-vetoed candidate catches up then WINS — the "safe but paused"
 *     → "safe and available" upgrade: a behind front candidate is STALE_LOG-
 *     vetoed, pulls the voter's tail (catch-up now carries committedSeq), and
 *     re-claims with a passing baseSeq. No committed write is lost.
 *  2. Committed roster: a node admission/departure replicated through the
 *     blackboard log converges every replica's office_nodes ledger AND aligns
 *     rosterEpoch — the quorum denominator is the committed set everywhere.
 *  3. Two-node office, authority dies: the survivor cannot form a majority and
 *     pauses HONESTLY (no self-appointed authority, no fake liveness) — the
 *     consensus boundary the product explicitly keeps.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { buildCluster, task, RIG_OFFICE, type FaultCluster } from './cluster'
import { CATCHUP_RECLAIM_DELAY_MS } from '../../../../../../src/main/apps/runtime/federation/authority/handover'

describe('resilience upgrades (rig)', () => {
  let cluster: FaultCluster

  afterEach(() => {
    cluster.dispose()
  })

  it('a behind candidate is vetoed, catches up from the voter, then wins with the full committed log', () => {
    cluster = buildCluster({ ids: ['a', 'b', 'c'] })
    const { a, b, c } = cluster.nodes

    // b drops out (confirmed offline on a and c) so the office keeps committing
    // without it — the write set b will be missing at election time.
    a.fed.setNodeStatus(RIG_OFFICE, 'b', 'offline', 0)
    c.fed.setNodeStatus(RIG_OFFICE, 'b', 'offline', 0)
    cluster.partition([['a', 'c'], ['b']])

    a.team.insertTask(task('t1'))
    a.office.captureLocalWrite({ teamId: RIG_OFFICE, epochId: 'epoch-1', op: 'post_task', payload: task('t1') as unknown as Record<string, unknown>, taskId: 't1' })
    a.team.insertTask(task('t2'))
    a.office.captureLocalWrite({ teamId: RIG_OFFICE, epochId: 'epoch-1', op: 'post_task', payload: task('t2') as unknown as Record<string, unknown>, taskId: 't2' })
    cluster.flush()
    expect(a.office.getCommittedSeq()).toBe(2)
    expect(c.office.replication.getAppliedSeq()).toBe(2)
    expect(b.office.replication.getAppliedSeq()).toBe(0) // b missed everything

    // The authority dies; b returns. b is the FRONT candidate by join order but
    // holds none of the committed writes c knows about.
    cluster.kill('a')
    cluster.heal()
    b.fed.setNodeStatus(RIG_OFFICE, 'a', 'offline', 0)
    c.fed.setNodeStatus(RIG_OFFICE, 'a', 'offline', 0)
    b.fed.setNodeStatus(RIG_OFFICE, 'c', 'online', 0)
    c.fed.setNodeStatus(RIG_OFFICE, 'b', 'online', 0)

    b.office.onNodePresence('a', 'offline')
    c.office.onNodePresence('a', 'offline')
    cluster.flush()

    // The first claim was vetoed (STALE_LOG): candidacy abandoned, election
    // still open, catch-up requested from the vetoing voter.
    expect(b.office.handover.election.isElecting()).toBe(true)
    expect(b.office.handover.election.proposedTerm()).toBeNull()
    expect(b.becameAuthority).not.toHaveBeenCalled()

    // The catch-up applied the missing tail INCLUDING the committed water mark.
    expect(b.office.replication.getAppliedSeq()).toBe(2)
    expect(b.office.getCommittedSeq()).toBeGreaterThanOrEqual(1)

    // Catch-up → re-claim rounds are bounded by the attempt cap; the voter's
    // committed mark can advance while the candidate replays (its own ack
    // stream commits on the voter), so allow the couple of rounds the
    // production clock would take.
    for (let round = 0; round < 4 && !b.office.isAuthoritySelf(); round++) {
      cluster.advance(CATCHUP_RECLAIM_DELAY_MS + 1)
      cluster.flush()
    }
    expect(b.becameAuthority).toHaveBeenCalledWith(2)
    expect(b.office.isAuthoritySelf()).toBe(true)
    expect(b.office.isPaused()).toBe(false)
    // No committed write was lost across the handover.
    expect(b.team.listTasksByTeam(RIG_OFFICE).map((t) => t.id).sort()).toEqual(['t1', 't2'])
    // The voter converged on the winner.
    expect(c.auth.getAuthorityState(RIG_OFFICE)).toMatchObject({ authorityNodeId: 'b', term: 2 })
  })

  it('roster admissions/departures ride the committed log: every replica ledger + rosterEpoch converges', () => {
    cluster = buildCluster({ ids: ['a', 'b', 'c'] })
    const { a, b, c } = cluster.nodes

    a.office.replicateNodeAdmitted({
      nodeId: 'node-d',
      identity: 'node-d',
      displayName: 'D',
      joinedAt: 4,
      advertisedUrl: 'mem://d',
    })
    cluster.flush()

    for (const node of [b, c]) {
      const row = node.fed.getNode(RIG_OFFICE, 'node-d')
      expect(row).toMatchObject({ nodeId: 'node-d', joinedAt: 4, advertisedUrl: 'mem://d' })
      expect(node.office.termState.getRosterEpoch()).toBe(2)
    }
    expect(a.office.termState.getRosterEpoch()).toBe(2)

    // A non-authority cannot write the roster (single-writer guard): the log
    // does not grow and no replica changes.
    const seqBefore = a.office.replication.getAppliedSeq()
    b.office.replicateNodeAdmitted({
      nodeId: 'node-evil',
      identity: 'node-evil',
      displayName: null,
      joinedAt: 9,
      advertisedUrl: null,
    })
    cluster.flush()
    expect(a.office.replication.getAppliedSeq()).toBe(seqBefore)
    expect(c.fed.getNode(RIG_OFFICE, 'node-evil')).toBeNull()

    a.office.replicateNodeLeft('node-d')
    cluster.flush()
    for (const node of [b, c]) {
      expect(node.fed.getNode(RIG_OFFICE, 'node-d')).toBeNull()
      expect(node.office.termState.getRosterEpoch()).toBe(3)
    }

    // CONCURRENT roster writes (the failover re-enroll burst): both commits
    // adopt the ABSOLUTE epoch stamped in their payloads — the same value the
    // replicas apply — so the authority can never drift one ahead of its
    // replicas (a permanent split under the monotonic guard that would later
    // burn a resurrected voter's STALE_ROSTER vetoes through the attempt cap).
    cluster.setDelay(5)
    a.office.replicateNodeAdmitted({
      nodeId: 'node-e', identity: 'node-e', displayName: 'E', joinedAt: 5, advertisedUrl: null,
    })
    a.office.replicateNodeAdmitted({
      nodeId: 'node-f', identity: 'node-f', displayName: 'F', joinedAt: 6, advertisedUrl: null,
    })
    // Two rounds: the delayed replicate frames land first, then the equally
    // delayed acks that drive the authority's commits.
    for (let i = 0; i < 3; i++) {
      cluster.advance(10)
      cluster.flush()
    }
    cluster.setDelay(0)
    const epochs = [a, b, c].map((n) => n.office.termState.getRosterEpoch())
    expect(new Set(epochs).size).toBe(1)
    for (const node of [b, c]) {
      expect(node.fed.getNode(RIG_OFFICE, 'node-e')).not.toBeNull()
      expect(node.fed.getNode(RIG_OFFICE, 'node-f')).not.toBeNull()
    }
  })

  it('two-node office: the survivor pauses honestly when the authority dies (no self-appointed authority)', () => {
    cluster = buildCluster({ ids: ['a', 'b'] })
    const { b } = cluster.nodes

    cluster.kill('a')
    b.fed.setNodeStatus(RIG_OFFICE, 'a', 'offline', 0)
    b.office.onNodePresence('a', 'offline')
    cluster.flush()

    // Exhaust the bounded claim retries: quorum is 2 of 2 and only b lives.
    // Each attempt spans a collection window + a backoff, so give the clock
    // enough rounds to burn through all of them.
    for (let i = 0; i < 24 && !b.office.isPaused(); i++) {
      cluster.advance(15_000)
      cluster.flush()
    }

    expect(b.office.isPaused()).toBe(true)
    expect(b.office.isAuthoritySelf()).toBe(false)
    expect(b.becameAuthority).not.toHaveBeenCalled()
    // The tenure never advanced — no split brain is possible on revival.
    expect(b.office.getTerm()).toBe(1)
  })
})
