/**
 * Local vs remote member equivalence.
 *
 * A digital human contributing the SAME task/finding must produce an EQUIVALENT
 * observable coordination stream whether it runs as a LOCAL member of the authority
 * node or as a REMOTE member on another node. The federation design achieves this
 * by funnelling BOTH paths through the one single-writer replication log:
 *
 *   LOCAL  member write → kernel blackboard → onWrite → captureLocalWrite → log + fan-out
 *   REMOTE member write → blackboard-write frame → admitMemberWrite (scope) →
 *                          applyMemberWrite → kernel blackboard → captureLocalWrite →
 *                          log + fan-out
 *
 * So the bytes a hot-standby applies — the (seq, op, payload) replicated entry and
 * the resulting board state — are the same for both origins. This test runs the two
 * origins on two identical clusters and asserts the standbys converge to the same
 * observable state and replication position.
 *
 * What this in-process rig cannot prove: wall-clock latency/jitter parity, real WS
 * framing/backpressure, and byte-for-byte member-runtime stream equality — those
 * need a true two-process harness. Here we assert only the coordination-plane
 * equivalence the replication log guarantees.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { buildCluster, task, RIG_OFFICE, RIG_EPOCH, type FaultCluster } from './cluster'
import type { TeamMember } from '../../../../../../src/main/apps/team'
import type { BlackboardWriteFrame } from '../../../../../../src/main/apps/runtime/federation/protocol-m2'

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
    origin: ownerNodeId === 'A' ? 'local' : 'remote',
    memberIdentity: appId,
    scopeJson: null,
  }
}

/** Stable projection of a standby's observable board for cross-origin comparison. */
function boardOf(rig: FaultCluster, node: string) {
  return rig.nodes[node].team
    .listTasksByTeam(RIG_OFFICE)
    .map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      assigneeAppId: t.assigneeAppId,
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

describe('AC-2.0 — local member vs remote member produce an equivalent stream (D8 rig)', () => {
  let rigLocal: FaultCluster
  let rigRemote: FaultCluster
  afterEach(() => {
    rigLocal?.dispose()
    rigRemote?.dispose()
  })

  it('the same task from a local vs a remote member yields the same replicated board + position', () => {
    // ── LOCAL origin: the member is owned by the authority node A; A captures the
    // write directly (the local kernel path). ──
    rigLocal = buildCluster({ ids: ['A', 'B', 'C'] })
    rigLocal.beat()
    for (const id of ['A', 'B', 'C']) {
      rigLocal.nodes[id].team.addMember(member('wkr', 'A'))
    }
    rigLocal.nodes.A.office.captureLocalWrite({
      teamId: RIG_OFFICE,
      epochId: RIG_EPOCH,
      op: 'post_task',
      payload: task('shared-1', 'wkr', 'in_progress') as unknown as Record<string, unknown>,
      taskId: 'shared-1',
    })
    rigLocal.flush()

    // ── REMOTE origin: the SAME member appId is owned by node B; B sends the write
    // as a member→authority blackboard-write frame, which A admits (scope) and
    // applies through the same single-writer log. ──
    rigRemote = buildCluster({ ids: ['A', 'B', 'C'] })
    rigRemote.beat()
    for (const id of ['A', 'B', 'C']) {
      rigRemote.nodes[id].team.addMember(member('wkr', 'B'))
    }
    const remoteWrite: BlackboardWriteFrame = {
      kind: 'blackboard-write',
      officeId: RIG_OFFICE,
      fromNode: 'B',
      term: rigRemote.nodes.A.office.getTerm(),
      op: 'post_task',
      // The authority resolves the scope SUBJECT from the authenticated sender's
      // OWNED members and the payload's self-reported author (confused-deputy
      // guard, office-authority.resolveWriteSubjectAppId). Node B owns member
      // `wkr`, so the write must declare `wkr` as its author — a node cannot
      // borrow an author it does not own.
      payload: {
        ...(task('shared-1', 'wkr', 'in_progress') as unknown as Record<string, unknown>),
        createdByAppId: 'wkr',
      },
      taskId: 'shared-1',
      fid: 'fid-remote-1',
    }
    // Route it through A's authority dispatcher exactly as the manager would.
    rigRemote.nodes.A.office.handle('B', remoteWrite)
    rigRemote.flush()

    // ── Equivalence on the standbys (the observers of the coordination stream): ──
    expect(rigLocal.nodes.B.office.replication.getAppliedSeq()).toBe(1)
    expect(rigLocal.nodes.C.office.replication.getAppliedSeq()).toBe(1)
    expect(rigRemote.nodes.C.office.replication.getAppliedSeq()).toBe(1)
    // (Remote: B is the WRITER so it does not apply its own replicate; the other
    // standbys do. We compare a standby present in both — C.)

    const localBoardC = boardOf(rigLocal, 'C')
    const remoteBoardC = boardOf(rigRemote, 'C')
    expect(remoteBoardC).toEqual(localBoardC)
    expect(remoteBoardC).toEqual([
      { id: 'shared-1', title: 'shared-1', status: 'in_progress', assigneeAppId: 'wkr' },
    ])

    expect(rigLocal.committedWriteAuthorityCount()).toBe(1)
    expect(rigRemote.committedWriteAuthorityCount()).toBe(1)
    expect(rigLocal.nodes.A.office.isAuthoritySelf()).toBe(true)
    expect(rigRemote.nodes.A.office.isAuthoritySelf()).toBe(true)
  })

  it('a read-only (out-of-scope) remote member write is admitted-denied, producing NO stream (asymmetry vs a local trusted write)', () => {
    // Scope is enforced authority-side on the REMOTE path only (a local kernel write
    // is the authority's own single-writer capture, not member-gated). A spectator
    // remote member whose scope forbids coordination writes must produce NO
    // replicated entry — the equivalence holds for ADMITTED writes, and the gate is
    // the one legitimate asymmetry.
    rigRemote = buildCluster({ ids: ['A', 'B', 'C'] })
    rigRemote.beat()
    for (const id of ['A', 'B', 'C']) {
      rigRemote.nodes[id].team.addMember(member('spectator', 'B'))
      // Deny coordination writes for the spectator on the authority A: a
      // read-only-visibility member cannot post tasks/findings.
      rigRemote.nodes.A.team.setMemberScope(
        RIG_OFFICE,
        'spectator',
        JSON.stringify({ visibility: 'readonly' })
      )
    }
    const denied: BlackboardWriteFrame = {
      kind: 'blackboard-write',
      officeId: RIG_OFFICE,
      fromNode: 'B',
      term: rigRemote.nodes.A.office.getTerm(),
      op: 'post_task',
      payload: task('spec-1', 'spectator', 'in_progress') as unknown as Record<string, unknown>,
      taskId: 'spec-1',
      fid: 'fid-denied-1',
    }
    rigRemote.nodes.A.office.handle('B', denied)
    rigRemote.flush()

    expect(rigRemote.nodes.C.office.replication.getAppliedSeq()).toBe(0)
    expect(boardOf(rigRemote, 'C')).toEqual([])
  })
})
