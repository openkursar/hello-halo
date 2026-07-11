/**
 * Survivor continuation: the authority host dies and a survivor takes over the
 * single-writer role AND keeps accepting coordination writes — driven through the
 * REAL presence FSM + REAL election + REAL replication over the fault-injection
 * rig.
 *
 * Scenario: A=authority@term1 over [A,B,C]. A (the host) is killed. B,C miss A's
 * heartbeats for a full confirmed window → confirm A offline through the genuine
 * FSM → B (front by joined_at) wins the election at term 2 (quorum 2 of 3 with C's
 * confirm). The new authority B then captures a NEW write, which replicates to the
 * surviving standby C and commits — proving the coordination plane CONTINUES on the
 * survivor with no gap and a single committed writer.
 *
 * This rig asserts the AUTHORITY-PLANE continuation (election + single-writer
 * hand-off + replicated commit) that the in-process coordinators fully implement.
 * The LINK-REDIRECT half — a survivor's outbound leg re-pointed onto the new
 * authority's inbound after the host dies — is covered end-to-end against the real
 * FederationManager/LanMeshLink in `../transport-repoint-seam.test.ts`.
 *
 * What still needs a true two-process harness: that the LIVE member runtimes (the
 * digital humans' WS sessions formerly attached to the dead host) re-attach and
 * resume STREAMING over real sockets — wall-clock/WS-framing fidelity on top of the
 * now-proven seam.
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

describe('AC-5.1 — survivor becomes authority and keeps accepting writes (D8 rig)', () => {
  let rig: FaultCluster
  afterEach(() => rig?.dispose())

  it('authority host dies: a survivor wins the election and a new write replicates + commits on its tenure', () => {
    rig = buildCluster({ ids: ['A', 'B', 'C'] })
    rig.beat()

    rig.nodes.A.office.captureLocalWrite({
      teamId: RIG_OFFICE,
      epochId: RIG_EPOCH,
      op: 'post_task',
      payload: task('t1') as unknown as Record<string, unknown>,
      taskId: 't1',
    })
    rig.flush()
    expect(rig.nodes.A.office.isAuthoritySelf()).toBe(true)
    expect(rig.nodes.A.office.getTerm()).toBe(1)
    expect(rig.nodes.B.office.replication.getAppliedSeq()).toBe(1)
    expect(rig.nodes.C.office.replication.getAppliedSeq()).toBe(1)
    expect(rig.committedWriteAuthorityCount()).toBe(1)

    rig.kill('A')

    // Survivors B,C miss A's heartbeats for a full confirmed window → confirm A
    // offline through the genuine FSM, which drives B (front by joined_at) into an
    // election.
    rig.advance(CONFIRMED_MS + 1)
    rig.beat() // B,C still heartbeat each other (stay mutually online)
    rig.tick()

    expect(rig.nodes.B.fed.getNode('A')!.status).toBe('offline')
    expect(rig.nodes.C.fed.getNode('A')!.status).toBe('offline')

    // Drive the election to completion: B claims term 2, C confirms → quorum 2 of 3.
    rig.advance(1)
    rig.flush()

    expect(rig.nodes.B.becameAuthority).toHaveBeenCalledWith(2)
    expect(rig.nodes.B.office.isAuthoritySelf()).toBe(true)
    expect(rig.nodes.B.office.getTerm()).toBe(2)
    expect(rig.nodes.C.office.isAuthoritySelf()).toBe(false)
    expect(rig.nodes.C.becameAuthority).not.toHaveBeenCalled()

    rig.nodes.B.office.captureLocalWrite({
      teamId: RIG_OFFICE,
      epochId: RIG_EPOCH,
      op: 'post_task',
      payload: task('t2') as unknown as Record<string, unknown>,
      taskId: 't2',
    })
    rig.flush()

    expect(rig.nodes.C.office.replication.getAppliedSeq()).toBe(2)
    expect(rig.taskIdsByNode().C).toEqual(['t1', 't2'])
    // B advanced its committed water mark on its own tenure (C's ack → majority of 1
    // online standby ∧ heir C).
    expect(rig.nodes.B.office.getCommittedSeq()).toBe(2)

    expect(rig.committedWriteAuthorityCount()).toBe(1)
    expect(rig.nodes.B.office.isAuthoritySelf()).toBe(true)
  })
})
