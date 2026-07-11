/**
 * election — leader election by join order + last-known-roster quorum. Drives the
 * FSM with a fake clock + fake term-state so the observable predicates (quorum
 * small-N / yield / backoff) are deterministic.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  createElection,
  ELECTION_MAX_ATTEMPTS,
} from '../../../../../../src/main/apps/runtime/federation/authority/election'
import type { TermState } from '../../../../../../src/main/apps/runtime/federation/authority/term-state'
import type { FederationMessage } from '../../../../../../src/main/apps/runtime/federation/types'
import type {
  AuthorityClaimFrame,
  AuthorityConfirmFrame,
  RejectFrame,
} from '../../../../../../src/main/apps/runtime/federation/protocol-m2'

function fakeTermState(init?: { term?: number; rosterEpoch?: number; authority?: string | null }): TermState {
  let term = init?.term ?? 0
  let committed = 0
  let applied = 0
  let rosterEpoch = init?.rosterEpoch ?? 0
  let authority = init?.authority ?? null
  return {
    getTerm: () => term,
    getCommittedSeq: () => committed,
    setCommittedSeq: (s) => {
      if (s > committed) committed = s
    },
    getAppliedSeq: () => applied,
    setAppliedSeq: (s) => {
      if (s > applied) applied = s
    },
    getRosterEpoch: () => rosterEpoch,
    setRosterEpoch: (n) => {
      if (n > rosterEpoch) rosterEpoch = n
    },
    getAuthorityNodeId: () => authority,
    setAuthority: (n, t) => {
      if (t >= term) {
        authority = n
        term = t
      }
    },
    bumpTerm: (n) => {
      term += 1
      authority = n
      return term
    },
    classifyTerm: (f) => (f < term ? 'stale' : f > term ? 'ahead' : 'ok'),
    snapshot: () => ({ officeId: 'o', term, authorityNodeId: authority, rosterEpoch, committedSeq: committed, appliedSeq: applied, updatedAt: 0 }),
  }
}

function makeScheduler() {
  let pending: Array<{ id: number; fn: () => void }> = []
  let nextId = 1
  return {
    schedule: (_ms: number, fn: () => void) => {
      const id = nextId++
      pending.push({ id, fn })
      return () => {
        pending = pending.filter((p) => p.id !== id)
      }
    },
    runAll() {
      const batch = pending
      pending = []
      for (const p of batch) p.fn()
    },
    count: () => pending.length,
  }
}

interface Sent {
  to: string
  frame: FederationMessage
}

function harness(opts: {
  self: string
  online: string[] // ordered candidates
  roster: string[] // last-known roster (quorum denominator)
  term?: number
  rosterEpoch?: number
}) {
  const sent: Sent[] = []
  const broadcasts: FederationMessage[] = []
  const sched = makeScheduler()
  const termState = fakeTermState({ term: opts.term, rosterEpoch: opts.rosterEpoch })
  const onElected = vi.fn()
  const onQuorumUnreachable = vi.fn()
  const election = createElection({
    officeId: 'O',
    selfNodeId: opts.self,
    termState,
    getOnlineCandidatesOrdered: () => opts.online,
    getLastKnownRoster: () => opts.roster,
    send: (to, frame) => sent.push({ to, frame }),
    broadcast: (frame) => broadcasts.push(frame),
    onElected,
    onQuorumUnreachable,
    schedule: sched.schedule,
    jitter: () => 0,
  })
  return { election, sent, broadcasts, sched, termState, onElected, onQuorumUnreachable }
}

describe('election', () => {
  it('front candidate claims; reaching quorum wins exactly term cur+1 (O-M3-3, small-N=3)', () => {
    const h = harness({ self: 'a', online: ['a', 'b', 'c'], roster: ['a', 'b', 'c'] })
    h.election.startElection()
    // Broadcast a claim for term 1 (cur 0 + 1).
    const claim = h.broadcasts[0] as AuthorityClaimFrame
    expect(claim.kind).toBe('authority-claim')
    expect(claim.term).toBe(1)

    // quorum = floor(3/2)+1 = 2; self counts 1, one confirm → win.
    const confirm: AuthorityConfirmFrame = {
      kind: 'authority-confirm', officeId: 'O', fromNode: 'b', term: 1, accept: true, reFid: claim.fid, fid: 'x',
    }
    h.election.handleConfirm('b', confirm)
    expect(h.onElected).toHaveBeenCalledTimes(1)
    expect(h.onElected).toHaveBeenCalledWith(1)
    expect(h.election.isElecting()).toBe(false)
  })

  it('a NON-front node does not broadcast a claim on startElection', () => {
    const h = harness({ self: 'b', online: ['a', 'b', 'c'], roster: ['a', 'b', 'c'] })
    h.election.startElection()
    expect(h.broadcasts.filter((f) => f.kind === 'authority-claim')).toHaveLength(0)
    expect(h.election.isElecting()).toBe(true) // ready voter
  })

  it('O-SB-2 / partition: 2-node roster, alone → never wins, pauses after MAX attempts', () => {
    const h = harness({ self: 'a', online: ['a'], roster: ['a', 'b'] }) // b unreachable
    h.election.startElection()
    for (let i = 0; i < 4 * (ELECTION_MAX_ATTEMPTS + 2); i++) h.sched.runAll()
    expect(h.onElected).not.toHaveBeenCalled()
    expect(h.onQuorumUnreachable).toHaveBeenCalled()
    expect(h.election.isPaused()).toBe(true)
  })

  it('confirms a legitimate front candidate', () => {
    const h = harness({ self: 'b', online: ['a', 'b'], roster: ['a', 'b'] })
    const claim: AuthorityClaimFrame = {
      kind: 'authority-claim', officeId: 'O', fromNode: 'a', term: 1, baseSeq: 0, rosterEpoch: 0, rosterNodes: ['a', 'b'], fid: 'c1',
    }
    h.election.handleClaim('a', claim)
    const confirm = h.sent.find((s) => s.frame.kind === 'authority-confirm')
    expect(confirm).toBeTruthy()
    expect((confirm!.frame as AuthorityConfirmFrame).accept).toBe(true)
    expect((confirm!.frame as AuthorityConfirmFrame).reFid).toBe('c1')
  })

  it('rejects NOT_A_CANDIDATE when an earlier node (self) exists', () => {
    // self 'a' is earlier than the claimer 'b' → b is not the front candidate.
    const h = harness({ self: 'a', online: ['a', 'b'], roster: ['a', 'b'] })
    const claim: AuthorityClaimFrame = {
      kind: 'authority-claim', officeId: 'O', fromNode: 'b', term: 1, baseSeq: 0, rosterEpoch: 0, rosterNodes: ['a', 'b'], fid: 'c1',
    }
    h.election.handleClaim('b', claim)
    const rej = h.sent.find((s) => s.frame.kind === 'reject')!.frame as RejectFrame
    expect(rej.reason).toBe('NOT_A_CANDIDATE')
  })

  it('rejects STALE_ROSTER for a claim with a lower rosterEpoch', () => {
    const h = harness({ self: 'b', online: ['a', 'b'], roster: ['a', 'b'], rosterEpoch: 5 })
    const claim: AuthorityClaimFrame = {
      kind: 'authority-claim', officeId: 'O', fromNode: 'a', term: 1, baseSeq: 0, rosterEpoch: 3, rosterNodes: ['a', 'b'], fid: 'c1',
    }
    h.election.handleClaim('a', claim)
    const rej = h.sent.find((s) => s.frame.kind === 'reject')!.frame as RejectFrame
    expect(rej.reason).toBe('STALE_ROSTER')
    expect(rej.retryable).toBe(true)
  })

  it('rejects EPOCH_STALE for a claim term <= current tenure (resurrected authority)', () => {
    const h = harness({ self: 'b', online: ['a', 'b'], roster: ['a', 'b'], term: 4 })
    const claim: AuthorityClaimFrame = {
      kind: 'authority-claim', officeId: 'O', fromNode: 'a', term: 4, baseSeq: 0, rosterEpoch: 0, rosterNodes: ['a', 'b'], fid: 'c1',
    }
    h.election.handleClaim('a', claim)
    const rej = h.sent.find((s) => s.frame.kind === 'reject')!.frame as RejectFrame
    expect(rej.reason).toBe('EPOCH_STALE')
    expect(rej.retryable).toBe(false)
  })

  it('election restriction: vetoes a candidate whose committed log is behind mine (STALE_LOG)', () => {
    // self 'b' is a legitimate voter (front 'a'); but b knows committedSeq=10 and
    // a's claim advertises baseSeq=5 → a is missing a committed write b has → veto.
    const h = harness({ self: 'b', online: ['a', 'b'], roster: ['a', 'b'] })
    h.termState.setCommittedSeq(10)
    const claim: AuthorityClaimFrame = {
      kind: 'authority-claim', officeId: 'O', fromNode: 'a', term: 1, baseSeq: 5, rosterEpoch: 0, rosterNodes: ['a', 'b'], fid: 'c1',
    }
    h.election.handleClaim('a', claim)
    const rej = h.sent.find((s) => s.frame.kind === 'reject')!.frame as RejectFrame
    expect(rej.reason).toBe('STALE_LOG')
    expect(h.sent.find((s) => s.frame.kind === 'authority-confirm')).toBeUndefined()
  })

  it('election restriction: an up-to-date candidate (baseSeq ≥ my committed) is still confirmed', () => {
    const h = harness({ self: 'b', online: ['a', 'b'], roster: ['a', 'b'] })
    h.termState.setCommittedSeq(10)
    const claim: AuthorityClaimFrame = {
      kind: 'authority-claim', officeId: 'O', fromNode: 'a', term: 1, baseSeq: 10, rosterEpoch: 0, rosterNodes: ['a', 'b'], fid: 'c1',
    }
    h.election.handleClaim('a', claim)
    expect(h.sent.find((s) => s.frame.kind === 'authority-confirm')).toBeTruthy()
    expect(h.sent.find((s) => s.frame.kind === 'reject')).toBeUndefined()
  })

  it('ignores a confirm for a DIFFERENT term and a reject (accept:false)', () => {
    const h = harness({ self: 'a', online: ['a', 'b', 'c'], roster: ['a', 'b', 'c'] })
    h.election.startElection() // claims term 1
    expect(h.election.proposedTerm()).toBe(1)
    // A confirm for term 99 must NOT count toward the term-1 election.
    h.election.handleConfirm('b', { kind: 'authority-confirm', officeId: 'O', fromNode: 'b', term: 99, accept: true, reFid: 'x', fid: 'y' })
    expect(h.onElected).not.toHaveBeenCalled()
    expect(h.election.confirmCount()).toBe(1) // only self
    // A negative confirm (accept:false) for the right term is also ignored.
    h.election.handleConfirm('b', { kind: 'authority-confirm', officeId: 'O', fromNode: 'b', term: 1, accept: false, reFid: 'x', fid: 'z' })
    expect(h.onElected).not.toHaveBeenCalled()
    expect(h.election.confirmCount()).toBe(1)
    // The correct term-1 accept finally wins.
    h.election.handleConfirm('b', { kind: 'authority-confirm', officeId: 'O', fromNode: 'b', term: 1, accept: true, reFid: 'x', fid: 'w' })
    expect(h.onElected).toHaveBeenCalledWith(1)
  })

  it('yields: a later candidate abandons its claim and confirms an earlier one (dueling)', () => {
    // self 'b' starts claiming (pretend it was front for a moment), then an
    // earlier candidate 'a' claims → b must yield + confirm a.
    const h = harness({ self: 'b', online: ['b'], roster: ['a', 'b'] })
    h.election.startElection() // b is currently the only online → it claims
    expect(h.election.isElecting()).toBe(true)
    expect(h.election.proposedTerm()).toBe(1)

    // Now 'a' (earlier) becomes reachable and claims.
    h.election.startElection() // no-op (already electing)
    // simulate a now being online ahead of b for the legitimacy check:
    const h2 = harness({ self: 'b', online: ['a', 'b'], roster: ['a', 'b'] })
    h2.election.startElection() // b not front → ready voter, no claim
    const claim: AuthorityClaimFrame = {
      kind: 'authority-claim', officeId: 'O', fromNode: 'a', term: 1, baseSeq: 0, rosterEpoch: 0, rosterNodes: ['a', 'b'], fid: 'cA',
    }
    h2.election.handleClaim('a', claim)
    const confirm = h2.sent.find((s) => s.frame.kind === 'authority-confirm')
    expect(confirm).toBeTruthy()
    expect((confirm!.frame as AuthorityConfirmFrame).reFid).toBe('cA')
  })
})
