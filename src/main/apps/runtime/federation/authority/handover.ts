/**
 * Handover composition root: owns a TermState + an Election + a Reconciler for
 * one office and turns presence + election outcomes into authority changes.
 *
 * Responsibilities:
 *   - Trigger an election ONLY when the believed authority is CONFIRMED-offline;
 *     a suspect authority is a HOLD, never a claim.
 *   - On winning: record the new tenure, become the writer, announce the change
 *     with a person-friendly UI signal (Lead maps it to t('Reconnected
 *     automatically'); never a technical word), then reconcile in_progress
 *     tasks against owner presence without blocking the office's writability.
 *   - Step down a resurrected old authority the moment it observes a higher term
 *     (within a short grace) — its stale-term writes are rejected elsewhere, so
 *     the single committed-writer invariant holds throughout.
 *   - Pause read-only on a partition minority, recovering automatically when
 *     connectivity returns.
 *
 * Election frames (claim/confirm) are delegated to its Election; the manager
 * routes onM2Frame here. Everything is injected so it unit-tests with a fake
 * clock + in-memory stores.
 */

import { randomUUID } from 'crypto'
import type { NodeId, FederationMessage } from '../types'
import type {
  AuthorityAnnounceFrame,
  AuthorityClaimFrame,
  AuthorityConfirmFrame,
  RejectFrame,
} from '../protocol-m2'
import { createElection, type Election } from './election'
import type { TermState } from './term-state'
import type { Reconciler } from './reconcile'

const LOG_TAG = '[Handover]'

export const OLD_AUTHORITY_STEPDOWN_GRACE_MS = 2000

/**
 * How long a freshness-vetoed candidate waits for the catch-up it requested to
 * apply before re-claiming. Short: the catch-up is a single request/response
 * over a live link; a candidate that is still behind after it is vetoed again
 * (bounded by the election's attempt cap → honest pause, never a stale winner).
 */
export const CATCHUP_RECLAIM_DELAY_MS = 1500

export interface HandoverDeps {
  officeId: string
  selfNodeId: NodeId
  termState: TermState
  reconciler: Reconciler
  // ── election views (forwarded) ──
  getOnlineCandidatesOrdered: () => NodeId[]
  getLastKnownRoster: () => NodeId[]
  send: (to: NodeId, frame: FederationMessage) => void
  broadcast: (frame: FederationMessage) => void
  // ── handover callbacks (Lead wires these to the manager/bootstrap) ──
  /** The office's open run epoch, for post-handover task reconciliation. */
  getCurrentRunEpoch: () => { teamId: string; epochId: string } | null
  /** This node won: become the office authority (re-host, start writing). */
  onBecomeAuthority: (term: number) => void
  /** Authority changed (to self on win, or to a higher-term peer on step-down). */
  onAuthorityChange: (authorityNodeId: NodeId, term: number) => void
  /** This node must stop acting as authority (resurrected old authority steps down). */
  onStepdown?: () => void
  /** Pause/resume the office (read-only) on partition minority. */
  onPausedChange?: (paused: boolean) => void
  /**
   * Pull the replication tail from a peer that vetoed this candidate's claim
   * for log freshness (STALE_LOG / STALE_ROSTER — the peer holds committed
   * state this node lacks). Wired to replication's catch-up request; after the
   * pull applies the candidate re-claims, turning "safe but paused" into
   * "safe and available".
   */
  requestCatchup?: (from: NodeId) => void
  now?: () => number
  schedule?: (ms: number, fn: () => void) => () => void
  jitter?: (ms: number) => number
  stepdownGraceMs?: number
}

export interface Handover {
  /** Wire from the coordinator's onNodePresence. Reacts only to the authority node. */
  onNodePresence: (nodeId: NodeId, status: 'online' | 'suspect' | 'offline') => void
  /** Observe any inbound frame's tenure; step down if a higher term is seen. */
  observeFrameTerm: (fromNode: NodeId, term: number) => void
  /** Election frames routed by the manager (onM2Frame). */
  handleClaim: (from: NodeId, frame: AuthorityClaimFrame) => void
  handleConfirm: (from: NodeId, frame: AuthorityConfirmFrame) => void
  /** A reject referencing this node's own claim (freshness veto → catch-up). */
  handleReject: (from: NodeId, frame: RejectFrame) => void
  getBelievedAuthority: () => NodeId | null
  isAuthoritySelf: () => boolean
  isPaused: () => boolean
  /** Expose the election for diagnostics/tests. */
  election: Election
  stop: () => void
}

export function createHandover(deps: HandoverDeps): Handover {
  const { officeId, selfNodeId, termState, reconciler } = deps
  const now = deps.now ?? (() => Date.now())
  const schedule =
    deps.schedule ??
    ((ms, fn) => {
      const t = setTimeout(fn, ms)
      if (typeof t.unref === 'function') t.unref()
      return () => clearTimeout(t)
    })
  const stepdownGraceMs = deps.stepdownGraceMs ?? OLD_AUTHORITY_STEPDOWN_GRACE_MS

  let paused = false

  function setPaused(p: boolean): void {
    if (paused === p) return
    paused = p
    deps.onPausedChange?.(p)
  }

  function becomeAuthority(term: number): void {
    // Record the new tenure with self as authority (term already = cur+1 proposed
    // by the election; setAuthority persists it without a second increment).
    termState.setAuthority(selfNodeId, term)
    setPaused(false)
    console.log(`${LOG_TAG} became authority office=${officeId} term=${term}`)
    // Convergence accelerator: tell every reachable peer the election concluded
    // so losers/late voters realign + re-form transport NOW (observeFrameTerm),
    // instead of on the next replicate frame. Best-effort — the replication
    // stream remains the guaranteed carrier of the new tenure.
    const announce: AuthorityAnnounceFrame = {
      kind: 'authority-announce',
      officeId,
      fromNode: selfNodeId,
      term,
      fid: randomUUID(),
    }
    deps.broadcast(announce)
    deps.onBecomeAuthority(term)
    deps.onAuthorityChange(selfNodeId, term)
    // Reconcile in_progress tasks against owner presence. Async; does NOT block
    // the office becoming writable (the 5s liveness is the becomeAuthority path
    // above, independent of per-task reconciliation).
    const run = deps.getCurrentRunEpoch()
    if (run) {
      try {
        reconciler.reconcileEpoch(run.teamId, run.epochId)
      } catch (err) {
        console.error(`${LOG_TAG} reconcileEpoch failed office=${officeId}:`, err)
      }
    }
  }

  const election = createElection({
    officeId,
    selfNodeId,
    termState,
    getOnlineCandidatesOrdered: deps.getOnlineCandidatesOrdered,
    getLastKnownRoster: deps.getLastKnownRoster,
    send: deps.send,
    broadcast: deps.broadcast,
    onElected: becomeAuthority,
    onQuorumUnreachable: () => setPaused(true),
    // Freshness veto (STALE_LOG / STALE_ROSTER): the voter holds committed
    // state this candidate lacks. Pull its tail, then re-claim once the pull
    // had a chance to apply — the loop is bounded by the election attempt cap,
    // so a candidate that cannot catch up still degrades to the honest pause.
    onFreshnessReject: (from) => {
      console.log(`${LOG_TAG} claim vetoed for freshness office=${officeId}; catching up from=${from}`)
      deps.requestCatchup?.(from)
      schedule(CATCHUP_RECLAIM_DELAY_MS, () => election.retryClaim())
    },
    now,
    schedule,
    jitter: deps.jitter,
  })

  function isAuthoritySelf(): boolean {
    return termState.getAuthorityNodeId() === selfNodeId
  }

  function onNodePresence(nodeId: NodeId, status: 'online' | 'suspect' | 'offline'): void {
    const authority = termState.getAuthorityNodeId()
    if (status === 'online') {
      // A node returned: if we were paused as a partition minority, re-attempt —
      // the majority may now be reachable.
      if (paused) election.retrigger()
      return
    }
    if (nodeId !== authority) return // only the authority's loss triggers a handover
    if (status === 'suspect') {
      // A suspect authority is a HOLD — never start an election on a flap.
      return
    }
    // status === 'offline' = CONFIRMED-offline (the FSM only emits offline on
    // confirmed). The authority is gone → elect a successor.
    if (isAuthoritySelf()) return // self can't be both offline and running this
    console.log(`${LOG_TAG} authority confirmed-offline office=${officeId} node=${nodeId}; electing`)
    election.startElection()
  }

  function observeFrameTerm(fromNode: NodeId, term: number): void {
    const cur = termState.getTerm()
    if (term <= cur) return
    // A higher tenure exists → I missed (or lost) a handover. Re-align my believed
    // authority and, if I was acting as authority (resurrected old authority),
    // step down within the grace window. My own stale writes are EPOCH_STALE'd by
    // peers regardless, so the single-writer invariant holds even during this
    // window.
    const wasAuthoritySelf = isAuthoritySelf()
    termState.setAuthority(fromNode, term)
    election.cancel()
    deps.onAuthorityChange(fromNode, term)
    if (wasAuthoritySelf) {
      console.warn(`${LOG_TAG} higher term ${term} seen from=${fromNode}; stepping down within grace office=${officeId}`)
      schedule(stepdownGraceMs, () => {
        // Re-check: only step down if still superseded (avoid racing a re-win).
        if (termState.getTerm() >= term && termState.getAuthorityNodeId() !== selfNodeId) {
          deps.onStepdown?.()
        }
      })
    }
  }

  return {
    onNodePresence,
    observeFrameTerm,
    handleClaim: (from, frame) => election.handleClaim(from, frame),
    handleConfirm: (from, frame) => election.handleConfirm(from, frame),
    handleReject: (from, frame) => election.handleReject(from, frame),
    getBelievedAuthority: () => termState.getAuthorityNodeId(),
    isAuthoritySelf,
    isPaused: () => paused,
    election,
    stop: () => {
      election.cancel()
      reconciler.stop()
    },
  }
}
