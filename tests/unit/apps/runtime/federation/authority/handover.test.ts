/**
 * handover — composition: presence-driven election trigger (hold on suspect),
 * become-authority + reconcile, step-down on higher term, partition pause/resume.
 */

import { describe, it, expect, vi } from 'vitest'
import { createHandover } from '../../../../../../src/main/apps/runtime/federation/authority/handover'
import type { TermState } from '../../../../../../src/main/apps/runtime/federation/authority/term-state'
import type { Reconciler } from '../../../../../../src/main/apps/runtime/federation/authority/reconcile'
import type { FederationMessage } from '../../../../../../src/main/apps/runtime/federation/types'
import type { AuthorityConfirmFrame } from '../../../../../../src/main/apps/runtime/federation/protocol-m2'

function fakeTermState(init?: { term?: number; authority?: string | null }): TermState {
  let term = init?.term ?? 0
  let committed = 0
  let applied = 0
  let rosterEpoch = 0
  let authority = init?.authority ?? null
  return {
    getTerm: () => term,
    getCommittedSeq: () => committed,
    setCommittedSeq: (s) => { if (s > committed) committed = s },
    getAppliedSeq: () => applied,
    setAppliedSeq: (s) => { if (s > applied) applied = s },
    getRosterEpoch: () => rosterEpoch,
    setRosterEpoch: (n) => { if (n > rosterEpoch) rosterEpoch = n },
    getAuthorityNodeId: () => authority,
    setAuthority: (n, t) => { if (t >= term) { authority = n; term = t } },
    bumpTerm: (n) => { term += 1; authority = n; return term },
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
      return () => { pending = pending.filter((p) => p.id !== id) }
    },
    runAll() {
      const batch = pending
      pending = []
      for (const p of batch) p.fn()
    },
  }
}

function mockReconciler(): Reconciler {
  return { reconcileEpoch: vi.fn().mockReturnValue([]), stop: vi.fn() }
}

function setup(opts: { self: string; online: string[]; roster: string[]; authority: string; term?: number }) {
  const sched = makeScheduler()
  const termState = fakeTermState({ term: opts.term ?? 1, authority: opts.authority })
  const reconciler = mockReconciler()
  const sent: Array<{ to: string; frame: FederationMessage }> = []
  const onBecomeAuthority = vi.fn()
  const onAuthorityChange = vi.fn()
  const onStepdown = vi.fn()
  const onPausedChange = vi.fn()
  const handover = createHandover({
    officeId: 'O',
    selfNodeId: opts.self,
    termState,
    reconciler,
    getOnlineCandidatesOrdered: () => opts.online,
    getLastKnownRoster: () => opts.roster,
    send: (to, frame) => sent.push({ to, frame }),
    broadcast: () => {},
    getCurrentRunEpoch: () => ({ teamId: 'T', epochId: 'E' }),
    onBecomeAuthority,
    onAuthorityChange,
    onStepdown,
    onPausedChange,
    schedule: sched.schedule,
    jitter: () => 0,
  })
  return { handover, sched, termState, reconciler, onBecomeAuthority, onAuthorityChange, onStepdown, onPausedChange }
}

describe('handover', () => {
  it('M-3: authority SUSPECT does not trigger an election', () => {
    const s = setup({ self: 'self', online: ['self', 'b'], roster: ['old', 'self', 'b'], authority: 'old' })
    s.handover.onNodePresence('old', 'suspect')
    expect(s.handover.election.isElecting()).toBe(false)
  })

  it('authority CONFIRMED-offline → election → self wins → becomeAuthority + reconcile (M-10)', () => {
    const s = setup({ self: 'self', online: ['self', 'b'], roster: ['old', 'self', 'b'], authority: 'old' })
    s.handover.onNodePresence('old', 'offline') // confirmed
    expect(s.handover.election.isElecting()).toBe(true)
    // quorum = floor(3/2)+1 = 2; self counts 1, one confirm from b → win term 2.
    const confirm: AuthorityConfirmFrame = {
      kind: 'authority-confirm', officeId: 'O', fromNode: 'b', term: 2, accept: true, reFid: 'x', fid: 'y',
    }
    s.handover.handleConfirm('b', confirm)
    expect(s.onBecomeAuthority).toHaveBeenCalledWith(2)
    expect(s.onAuthorityChange).toHaveBeenCalledWith('self', 2)
    expect(s.handover.isAuthoritySelf()).toBe(true)
    expect(s.reconciler.reconcileEpoch).toHaveBeenCalledWith('T', 'E')
  })

  it('a non-authority node going offline does not trigger an election', () => {
    const s = setup({ self: 'self', online: ['self', 'b'], roster: ['old', 'self', 'b'], authority: 'old' })
    s.handover.onNodePresence('b', 'offline') // not the authority
    expect(s.handover.election.isElecting()).toBe(false)
  })

  it('O-SB-1: a resurrected authority steps down on seeing a higher term', () => {
    const s = setup({ self: 'self', online: ['self'], roster: ['self', 'new'], authority: 'self', term: 2 })
    expect(s.handover.isAuthoritySelf()).toBe(true)
    s.handover.observeFrameTerm('new', 3)
    expect(s.onAuthorityChange).toHaveBeenCalledWith('new', 3)
    expect(s.handover.getBelievedAuthority()).toBe('new')
    s.sched.runAll() // the grace timer fires
    expect(s.onStepdown).toHaveBeenCalledTimes(1)
  })

  it('partition pause then resume: QUORUM_UNREACHABLE pauses; a returning node retriggers', () => {
    // self alone vs a 2-node roster → cannot reach quorum.
    const s = setup({ self: 'self', online: ['self'], roster: ['self', 'b'], authority: 'old' })
    s.handover.onNodePresence('old', 'offline')
    for (let i = 0; i < 40; i++) s.sched.runAll()
    expect(s.handover.isPaused()).toBe(true)
    expect(s.onPausedChange).toHaveBeenCalledWith(true)
    s.handover.onNodePresence('b', 'online')
    expect(s.handover.election.isElecting()).toBe(true)
  })
})
