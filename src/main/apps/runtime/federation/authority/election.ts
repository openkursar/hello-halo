/**
 * Leader election: P2P authority election by JOIN ORDER with a LAST-KNOWN-ROSTER
 * majority quorum, run per office per node. Only the front-most online candidate
 * (earliest joined_at, node_id tiebreak) may win; majority is counted against the
 * last-known roster, not the currently-reachable set, so a 2-way partition cannot
 * double-elect. Dueling claims collapse via the yield rule: a later candidate
 * confirms an earlier one and abandons its own.
 *
 * Correctness invariants:
 *   - Election starts ONLY on the authority's CONFIRMED-offline (handover calls
 *     startElection); never on suspect, so a flap costs zero claims.
 *   - At most one node ever wins quorum for a term → at most one committed-write
 *     authority. A resurrected old authority's stale-term writes are rejected
 *     elsewhere (term-state), so it never commits.
 *   - A minority side exhausts bounded retries then pauses read-only rather than
 *     spinning or installing a second authority.
 *
 * All I/O is injected (send/broadcast, candidate/roster views, schedule()), so
 * tests drive it deterministically with a fake clock.
 */

import { randomUUID } from 'crypto'
import type { NodeId, FederationMessage } from '../types'
import type {
  AuthorityClaimFrame,
  AuthorityConfirmFrame,
  RejectFrame,
} from '../protocol-m2'
import type { TermState } from './term-state'

const LOG_TAG = '[Election]'

// ── Constants (LAN defaults) ──
export const CANDIDATE_CLAIM_WAIT_MS = 3000
export const CONFIRM_COLLECTION_WINDOW_MS = CANDIDATE_CLAIM_WAIT_MS
export const ELECTION_TIE_BACKOFF_BASE_MS = 1000
export const ELECTION_TIE_BACKOFF_JITTER_MS = 800
export const ELECTION_BACKOFF_MAX_MS = 8000
export const ELECTION_MAX_ATTEMPTS = 5

export interface ElectionDeps {
  officeId: string
  selfNodeId: NodeId
  termState: TermState
  /** Online nodes eligible to be authority, ordered front→back (joined_at asc, node_id tiebreak). */
  getOnlineCandidatesOrdered: () => NodeId[]
  /** The last-known roster node set — the quorum denominator (never shrinks on partition). */
  getLastKnownRoster: () => NodeId[]
  send: (to: NodeId, frame: FederationMessage) => void
  broadcast: (frame: FederationMessage) => void
  /** Won quorum for `term`. Handover records authority + becomes the writer. */
  onElected: (term: number) => void
  /** Exhausted retries without a majority → minority side pauses (read-only). */
  onQuorumUnreachable?: () => void
  /**
   * This candidate's claim was vetoed by a voter holding FRESHER committed
   * state (STALE_LOG / STALE_ROSTER). The current claim is abandoned; the
   * consumer pulls the voter's tail and calls retryClaim() once it applied.
   * Vetoes count against the attempt cap, so a candidate that can never catch
   * up still degrades to the honest QUORUM_UNREACHABLE pause.
   */
  onFreshnessReject?: (from: NodeId, reason: RejectFrame['reason']) => void
  now?: () => number
  /** Injected timer (defaults to setTimeout, unref'd). */
  schedule?: (ms: number, fn: () => void) => () => void
  /** Random jitter in [0, ms]; injectable for deterministic tests. */
  jitter?: (ms: number) => number
}

export interface Election {
  /** Begin an election (called by handover on the authority's confirmed-offline). */
  startElection(): void
  handleClaim(from: NodeId, frame: AuthorityClaimFrame): void
  handleConfirm(from: NodeId, frame: AuthorityConfirmFrame): void
  /** A reject frame referencing this candidate's own claim (freshness veto). */
  handleReject(from: NodeId, frame: RejectFrame): void
  /** Re-claim after a freshness-veto catch-up applied (still front → new claim). */
  retryClaim(): void
  /** Re-arm after a node comes back (exit a QUORUM_UNREACHABLE pause). */
  retrigger(): void
  /** Abandon any in-flight candidacy + clear timers (stop / stepdown). */
  cancel(): void
  // ── probes (tests / diagnostics) ──
  isElecting(): boolean
  isPaused(): boolean
  proposedTerm(): number | null
  confirmCount(): number
}

export function createElection(deps: ElectionDeps): Election {
  const {
    officeId,
    selfNodeId,
    termState,
    getOnlineCandidatesOrdered,
    getLastKnownRoster,
    send,
    broadcast,
    onElected,
    onQuorumUnreachable,
  } = deps
  const now = deps.now ?? (() => Date.now())
  const schedule =
    deps.schedule ??
    ((ms, fn) => {
      const t = setTimeout(fn, ms)
      if (typeof t.unref === 'function') t.unref()
      return () => clearTimeout(t)
    })
  const jitter = deps.jitter ?? ((ms) => Math.floor(Math.random() * (ms + 1)))

  let electing = false
  let paused = false
  let myTerm: number | null = null
  let confirms = new Set<NodeId>()
  let attempt = 0
  let cancelTimer: (() => void) | null = null
  // The fid of this candidate's live claim, so an inbound reject can be matched
  // to it (rejects for anything else — replication, other claims — are ignored).
  let lastClaimFid: string | null = null

  function clearTimer(): void {
    if (cancelTimer) {
      cancelTimer()
      cancelTimer = null
    }
  }

  function quorumSize(): number {
    const n = getLastKnownRoster().length
    return Math.floor(n / 2) + 1
  }

  function frontCandidate(): NodeId | null {
    return getOnlineCandidatesOrdered()[0] ?? null
  }

  /** Order index of a node among the (current) online candidates; +Inf if absent. */
  function orderIndex(node: NodeId): number {
    const idx = getOnlineCandidatesOrdered().indexOf(node)
    return idx < 0 ? Number.POSITIVE_INFINITY : idx
  }

  function reject(to: NodeId, reFid: string, reason: RejectFrame['reason'], retryable: boolean, detail?: Record<string, unknown>): void {
    const frame: RejectFrame = {
      kind: 'reject',
      officeId,
      fromNode: selfNodeId,
      reFid,
      reason,
      retryable,
      fid: randomUUID(),
      ...(detail ? { detail } : {}),
    }
    send(to, frame)
  }

  function beginClaim(): void {
    const proposed = termState.getTerm() + 1
    myTerm = proposed
    confirms = new Set<NodeId>([selfNodeId]) // self counts as one
    const claim: AuthorityClaimFrame = {
      kind: 'authority-claim',
      officeId,
      fromNode: selfNodeId,
      term: proposed,
      baseSeq: termState.getCommittedSeq(),
      rosterEpoch: termState.getRosterEpoch(),
      rosterNodes: getLastKnownRoster(),
      fid: randomUUID(),
    }
    lastClaimFid = claim.fid
    console.log(`${LOG_TAG} claim office=${officeId} term=${proposed} attempt=${attempt} quorum=${quorumSize()}`)
    broadcast(claim)
    // A single-node roster elects itself immediately (degenerate but valid).
    if (maybeWin()) return
    clearTimer()
    cancelTimer = schedule(CONFIRM_COLLECTION_WINDOW_MS, onCollectionTimeout)
  }

  function maybeWin(): boolean {
    if (myTerm === null) return false
    if (confirms.size >= quorumSize()) {
      win(myTerm)
      return true
    }
    return false
  }

  function win(term: number): void {
    clearTimer()
    electing = false
    paused = false
    const t = term
    myTerm = null
    lastClaimFid = null
    confirms = new Set()
    attempt = 0
    console.log(`${LOG_TAG} WON office=${officeId} term=${t}`)
    onElected(t)
  }

  function onCollectionTimeout(): void {
    if (!electing || myTerm === null) return
    // Not enough confirms within the window → back off and retry, re-evaluating
    // the front candidate (a returning node may change it).
    attempt += 1
    if (attempt >= ELECTION_MAX_ATTEMPTS) {
      console.warn(`${LOG_TAG} quorum unreachable office=${officeId} attempts=${attempt}; pausing`)
      electing = false
      paused = true
      myTerm = null
      confirms = new Set()
      onQuorumUnreachable?.()
      return
    }
    const wait =
      Math.min(ELECTION_BACKOFF_MAX_MS, ELECTION_TIE_BACKOFF_BASE_MS * 2 ** attempt) +
      jitter(ELECTION_TIE_BACKOFF_JITTER_MS)
    clearTimer()
    cancelTimer = schedule(wait, () => {
      if (!electing) return
      // Only the front candidate re-claims; if we lost the front spot, yield.
      if (frontCandidate() === selfNodeId) beginClaim()
      else {
        // No longer front: stand down to voter; a watchdog re-checks liveness.
        cancelTimer = schedule(CONFIRM_COLLECTION_WINDOW_MS, onCollectionTimeout)
      }
    })
  }

  function startElection(): void {
    if (electing) return
    paused = false
    attempt = 0
    electing = true
    // Only the front-most online candidate broadcasts a claim; everyone else
    // becomes a ready voter (handleClaim), keeping a single legitimate winner.
    if (frontCandidate() === selfNodeId) {
      beginClaim()
    } else {
      // Voter mode: arm a watchdog so if the front candidate never claims (it too
      // died), we re-evaluate and may promote ourselves.
      clearTimer()
      cancelTimer = schedule(CANDIDATE_CLAIM_WAIT_MS + CONFIRM_COLLECTION_WINDOW_MS, () => {
        if (!electing) return
        if (frontCandidate() === selfNodeId) beginClaim()
        else cancelTimer = schedule(CONFIRM_COLLECTION_WINDOW_MS, onCollectionTimeout)
      })
    }
  }

  function handleClaim(from: NodeId, frame: AuthorityClaimFrame): void {
    // A claim must propose a HIGHER term than the current tenure; otherwise it is
    // stale (e.g. a resurrected old authority) → EPOCH_STALE, no vote.
    if (frame.term <= termState.getTerm()) {
      reject(from, frame.fid, 'EPOCH_STALE', false, { got: frame.term, current: termState.getTerm() })
      return
    }
    // Stale roster basis → the candidate must re-hydrate the roster before it can
    // be trusted to compute a correct majority.
    if (frame.rosterEpoch < termState.getRosterEpoch()) {
      reject(from, frame.fid, 'STALE_ROSTER', true, {
        got: frame.rosterEpoch,
        current: termState.getRosterEpoch(),
      })
      return
    }
    // ── Election restriction (Raft-style safety) ──
    // The candidate advertises its committed log position in `baseSeq`; a voter
    // with a HIGHER committed seq refuses to vote (STALE_LOG) rather than elect a
    // leader missing a committed write. A candidate that can't gather votes backs
    // off to QUORUM_UNREACHABLE and pauses read-only instead of losing that write.
    // This is a freshness veto only — it does not reorder candidates (joined_at
    // order still governs legitimacy).
    if (frame.baseSeq < termState.getCommittedSeq()) {
      reject(from, frame.fid, 'STALE_LOG', true, {
        candidateBaseSeq: frame.baseSeq,
        voterCommittedSeq: termState.getCommittedSeq(),
      })
      return
    }
    // Candidate legitimacy: `from` must be the front-most online candidate.
    const fromIdx = orderIndex(from)
    const selfIdx = orderIndex(selfNodeId)
    const front = frontCandidate()
    if (front !== null && front !== from && orderIndex(front) < fromIdx) {
      // A third node is earlier than `from` — `from` is not the legitimate candidate.
      reject(from, frame.fid, 'NOT_A_CANDIDATE', false, { front })
      return
    }
    if (selfIdx < fromIdx) {
      // I am earlier — I am the legitimate candidate; tell `from` to yield to me.
      reject(from, frame.fid, 'NOT_A_CANDIDATE', false, { front: selfNodeId })
      return
    }
    // `from` is legitimate (front-most, earlier-or-equal to me). YIELD any of my
    // own candidacy to it and confirm.
    if (electing && myTerm !== null && fromIdx < selfIdx) {
      console.log(`${LOG_TAG} yield office=${officeId} to=${from} (earlier candidate)`)
      clearTimer()
      myTerm = null
      confirms = new Set()
      // Stay `electing` as a voter so a later timeout can re-promote if `from` dies.
    }
    const confirm: AuthorityConfirmFrame = {
      kind: 'authority-confirm',
      officeId,
      fromNode: selfNodeId,
      term: frame.term,
      accept: true,
      reFid: frame.fid,
      fid: randomUUID(),
    }
    send(from, confirm)
  }

  function handleConfirm(_from: NodeId, frame: AuthorityConfirmFrame): void {
    if (!electing || myTerm === null) return
    if (!frame.accept || frame.term !== myTerm) return
    confirms.add(frame.fromNode)
    maybeWin()
  }

  function handleReject(from: NodeId, frame: RejectFrame): void {
    // Only a freshness veto aimed at THIS candidate's live claim is consumed;
    // every other reject (replication, someone else's claim, EPOCH_STALE /
    // NOT_A_CANDIDATE — both already resolved by the yield/timeout rules) is not.
    if (!electing || myTerm === null) return
    if (lastClaimFid === null || frame.reFid !== lastClaimFid) return
    if (frame.reason !== 'STALE_LOG' && frame.reason !== 'STALE_ROSTER') return
    console.log(
      `${LOG_TAG} claim vetoed office=${officeId} reason=${frame.reason} by=${from} attempt=${attempt}`
    )
    // Abandon this claim (stay electing as a ready voter) and hand the veto to
    // the consumer, which catches up from the vetoing voter then retryClaim()s.
    clearTimer()
    myTerm = null
    lastClaimFid = null
    confirms = new Set()
    attempt += 1
    if (attempt >= ELECTION_MAX_ATTEMPTS) {
      console.warn(`${LOG_TAG} freshness vetoes exhausted office=${officeId}; pausing`)
      electing = false
      paused = true
      onQuorumUnreachable?.()
      return
    }
    deps.onFreshnessReject?.(from, frame.reason)
  }

  function retryClaim(): void {
    // Valid only inside an election with no live claim (the veto abandoned it),
    // and only for the current front candidate (a returning earlier node wins
    // the spot; this node stays a voter).
    if (!electing || myTerm !== null) return
    if (frontCandidate() !== selfNodeId) return
    beginClaim()
  }

  function retrigger(): void {
    if (electing) return
    if (paused) {
      paused = false
    }
    startElection()
  }

  function cancel(): void {
    clearTimer()
    electing = false
    paused = false
    myTerm = null
    lastClaimFid = null
    confirms = new Set()
    attempt = 0
  }

  return {
    startElection,
    handleClaim,
    handleConfirm,
    handleReject,
    retryClaim,
    retrigger,
    cancel,
    isElecting: () => electing,
    isPaused: () => paused,
    proposedTerm: () => myTerm,
    confirmCount: () => confirms.size,
  }
}
