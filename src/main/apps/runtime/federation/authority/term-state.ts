/**
 * Per-office tenure (term) state: a thin, persistent facade over the
 * AuthorityStore office_authority row. It owns the authority TENURE (`term`, a
 * monotonic integer, +1 per election), the believed authority node id, the
 * replicated roster version (`rosterEpoch`, the last-known-roster quorum basis),
 * and the two replication water marks (`appliedSeq` optimistic / `committedSeq`
 * quorum-acked).
 *
 * It also provides the EPOCH_STALE gate (`classifyTerm`) that lets every
 * receiver reject a frame from a stale tenure after a handover — the line that,
 * together with single-writer + the replication log, blocks duplicate execution
 * across a tenure change.
 *
 * Naming note: `term` here is the AUTHORITY TENURE, a DIFFERENT namespace from
 * the kernel run-`epochId` (a string in message-bus). They are only temporally
 * adjacent at handover; no field/semantic coupling.
 */

import type { AuthorityState, AuthorityStore } from '../../../federation'

export type TermClass = 'ok' | 'stale' | 'ahead'

export interface TermState {
  getTerm(): number
  getCommittedSeq(): number
  setCommittedSeq(seq: number): void
  getAppliedSeq(): number
  setAppliedSeq(seq: number): void
  getRosterEpoch(): number
  setRosterEpoch(n: number): void
  getAuthorityNodeId(): string | null
  /** Record the believed authority + its tenure (no +1; for followers learning a winner). */
  setAuthority(nodeId: string | null, term: number): void
  /** Win an election: bump the tenure by one and record self as the authority. */
  bumpTerm(newAuthorityNodeId: string): number
  /**
   * Classify an inbound frame's tenure against the current one:
   *   'stale' (frameTerm < cur) → reject EPOCH_STALE, no side effect;
   *   'ahead' (frameTerm > cur) → I missed a handover → re-align / step down;
   *   'ok'    (frameTerm == cur) → process normally.
   */
  classifyTerm(frameTerm: number): TermClass
  snapshot(): AuthorityState
}

export interface CreateTermStateDeps {
  store: AuthorityStore
  officeId: string
  now?: () => number
}

export function createTermState(deps: CreateTermStateDeps): TermState {
  const { store, officeId } = deps
  const now = deps.now ?? (() => Date.now())

  function read(): AuthorityState {
    return (
      store.getAuthorityState(officeId) ?? {
        officeId,
        term: 0,
        authorityNodeId: null,
        rosterEpoch: 0,
        committedSeq: 0,
        appliedSeq: 0,
        updatedAt: now(),
      }
    )
  }

  return {
    getTerm: () => read().term,
    getCommittedSeq: () => read().committedSeq,
    setCommittedSeq(seq) {
      const cur = read()
      // Monotonic: a committed water mark never retreats.
      if (seq <= cur.committedSeq) return
      store.patchAuthorityState(officeId, { committedSeq: seq }, now())
    },
    getAppliedSeq: () => read().appliedSeq,
    setAppliedSeq(seq) {
      const cur = read()
      if (seq <= cur.appliedSeq) return
      store.patchAuthorityState(officeId, { appliedSeq: seq }, now())
    },
    getRosterEpoch: () => read().rosterEpoch,
    setRosterEpoch(n) {
      const cur = read()
      if (n <= cur.rosterEpoch) return
      store.patchAuthorityState(officeId, { rosterEpoch: n }, now())
    },
    getAuthorityNodeId: () => read().authorityNodeId,
    setAuthority(nodeId, term) {
      const cur = read()
      // Never move the tenure backwards when learning an authority.
      if (term < cur.term) return
      store.patchAuthorityState(officeId, { authorityNodeId: nodeId, term }, now())
    },
    bumpTerm(newAuthorityNodeId) {
      const cur = read()
      const next = cur.term + 1
      store.patchAuthorityState(
        officeId,
        { term: next, authorityNodeId: newAuthorityNodeId },
        now()
      )
      return next
    },
    classifyTerm(frameTerm) {
      const t = read().term
      if (frameTerm < t) return 'stale'
      if (frameTerm > t) return 'ahead'
      return 'ok'
    },
    snapshot: read,
  }
}
