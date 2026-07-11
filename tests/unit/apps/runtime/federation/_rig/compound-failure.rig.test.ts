/**
 * Compound failure: the authority is ALSO the owner of an in-flight task, and it
 * dies together with another member. Driven through the REAL presence FSM + REAL
 * election + REAL post-handover reconciler over the fault-injection rig.
 *
 * After a handover the new authority inherits the committed blackboard but NOT the
 * old authority's volatile coordination state. Some tasks are still `in_progress`.
 * It must NOT blindly reassign them — an owner that is still alive and busy would
 * double-execute. So it reconciles each in_progress task against its owner's live
 * presence + busy state:
 *   owner gone (confirmed-offline)  → REASSIGN (the work was lost with the node)
 *   owner alive but busy            → HOLD     (it is still running it; no dup)
 *   owner alive and idle            → REASSIGN (safe; it is not running it)
 *   owner suspect (flap)            → HOLD     (never act on a jitter window)
 *
 * Scenario: A=authority@term1 owns member `wkr-a` running task `t-a`; C owns member
 * `wkr-c` running task `t-c`. Killing A (authority + owner of t-a) and `wkr-a`'s node
 * leaves B (front survivor) to win the election and reconcile: t-a's owner is
 * confirmed-offline → REASSIGN exactly once; t-c's owner (alive C) is busy → HOLD.
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
import type { TeamMember } from '../../../../../../src/main/apps/team'

function member(appId: string, ownerNodeId: string): TeamMember {
  return {
    teamId: RIG_OFFICE,
    appId,
    memberName: appId,
    role: 'worker',
    isLead: false,
    aiProvisioned: false,
    addedAt: 1,
    ownerNodeId,
    origin: 'remote',
    memberIdentity: appId,
    scopeJson: null,
  }
}

describe('AC-5.5 — compound failure: handover reconciles interrupted tasks (D8 rig)', () => {
  let rig: FaultCluster
  afterEach(() => rig?.dispose())

  it('authority+owner dies with another member: gone-owner task reassigns once, busy-owner task holds', () => {
    rig = buildCluster({ ids: ['A', 'B', 'C'] })
    rig.beat()

    // Seed the shared team + two in_progress tasks into every node's replica so the
    // new authority B has them to reconcile. (In production these arrive via roster
    // + blackboard replication; the rig seeds them directly.)
    for (const id of ['A', 'B', 'C']) {
      const t = rig.nodes[id].team
      t.addMember(member('wkr-a', 'A'))
      t.addMember(member('wkr-c', 'C'))
      t.insertTask({ ...task('t-a', 'wkr-a', 'in_progress') })
      t.insertTask({ ...task('t-c', 'wkr-c', 'in_progress') })
    }

    // wkr-a's node (A) will die → confirmed-offline → REASSIGN; wkr-c stays alive
    // and busy on C → HOLD.
    rig.nodes.B.ownerStatus.set('wkr-a', 'confirmed-offline')
    rig.nodes.B.ownerStatus.set('wkr-c', 'busy')

    expect(rig.nodes.A.office.isAuthoritySelf()).toBe(true)
    expect(rig.nodes.A.office.getTerm()).toBe(1)

    rig.kill('A')

    // Survivors B,C miss A's heartbeats for a full confirmed window → confirm A
    // offline through the genuine FSM. That drives handover.onNodePresence(A,
    // 'offline') → B (front by joined_at) starts an election.
    rig.advance(CONFIRMED_MS + 1)
    rig.beat() // B,C still heartbeat each other (stay mutually online)
    rig.tick()

    expect(rig.nodes.B.fed.getNode(RIG_OFFICE, 'A')!.status).toBe('offline')
    expect(rig.nodes.C.fed.getNode(RIG_OFFICE, 'A')!.status).toBe('offline')

    // Drive the election to completion: B claims term 2, C confirms → quorum 2 of 3.
    rig.advance(1)
    rig.flush()

    expect(rig.nodes.B.becameAuthority).toHaveBeenCalledWith(2)
    expect(rig.nodes.B.office.isAuthoritySelf()).toBe(true)
    expect(rig.nodes.B.office.getTerm()).toBe(2)
    expect(rig.nodes.C.office.isAuthoritySelf()).toBe(false)

    // t-a's owner (dead A) is confirmed-offline → REASSIGN exactly once.
    expect(rig.nodes.B.reassigned).toHaveBeenCalledTimes(1)
    const reassignedTask = rig.nodes.B.reassigned.mock.calls[0][0] as { id: string }
    expect(reassignedTask.id).toBe('t-a')
    // t-c's owner (wkr-c on alive C) is busy → HELD → it was NOT reassigned, so no
    // double-execution of a turn that is still running.
    const reassignedIds = rig.nodes.B.reassigned.mock.calls.map(
      (c) => (c[0] as { id: string }).id
    )
    expect(reassignedIds).not.toContain('t-c')

    expect(rig.nodes.C.becameAuthority).not.toHaveBeenCalled()
    // A committed-write authority emerges once B captures a write at the new term.
    rig.nodes.B.office.captureLocalWrite({
      teamId: RIG_OFFICE,
      epochId: RIG_EPOCH,
      op: 'update_task',
      payload: { taskId: 't-a', status: 'pending', assigneeAppId: null } as Record<string, unknown>,
      taskId: 't-a',
    })
    rig.flush()
    expect(rig.committedWriteAuthorityCount()).toBe(1)
  })
})
