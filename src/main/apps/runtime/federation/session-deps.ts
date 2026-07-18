/**
 * apps/runtime/federation -- Location-aware session deps (authority role)
 *
 * The single seam where a team turn becomes position-transparent. It wraps the
 * local OrchestrationSessionDeps and, per call, resolves whether the target
 * member is owned by THIS node or a remote one:
 *
 *   local member  → delegate straight to the local impl (unchanged path).
 *   remote member → send a 'wake' frame to the owner node and resolve when the
 *                   matching 'turn-complete' arrives. The kernel sees the same
 *                   "fire and get woken" contract; it never learns of position.
 *
 * No local/remote parameter is added to the agent calling convention — position
 * lives inside sendAppChatMessage. getMemberSpaceId MUST stay synchronous
 * (orchestration calls it inline before waking), so a remote spaceId comes from
 * a join-time cache, never a network round-trip.
 *
 * Dependency direction: no http/* import. The transport hooks
 * (sendWake/registerTurnComplete/resolveOfficeId) are INJECTED by bootstrap.
 */

import { SELF_NODE_ID, TEAM_CIRCUIT_DEFAULTS } from '../../../../shared/apps/team-types'
import type { OrchestrationSessionDeps } from '../team'
import type { TurnCompletion } from '../team/message-bus'
import type { SerializedWakeRequest } from './types'

type SendAppChatRequest = Parameters<OrchestrationSessionDeps['sendAppChatMessage']>[0]

export interface LocationAwareSessionDepsConfig {
  /** The existing local impl, reused verbatim for self-owned members. */
  local: OrchestrationSessionDeps
  /**
   * Owner node of a member's appId; SELF_NODE_ID for a locally-owned member.
   * One app may be a member of SEVERAL teams with a DIFFERENT owner in each
   * (a template digital human brought into multiple offices), so the lookup
   * must be scoped to the team whose turn is running. `teamId` is absent only
   * on team-agnostic calls (getMemberSpaceId) where any membership works as a
   * fallback.
   */
  resolveOwnerNode: (appId: string, teamId?: string) => string
  /** This node's own stable node id (kept for parity/diagnostics). */
  selfNodeId: string
  /** Authority → owner wake send; false when the owner is unreachable. */
  sendWake: (p: {
    officeId: string
    ownerNodeId: string
    request: SerializedWakeRequest
    correlationId: string
  }) => boolean
  /** Register a one-shot completion callback keyed by correlationId; returns an unregister. */
  registerTurnComplete: (correlationId: string, cb: (outcome: TurnCompletion) => void) => () => void
  /** Cached spaceId of a remote member (populated at join). */
  getRemoteSpaceId: (appId: string) => string | undefined
}

const LOG_TAG = '[FedSessionDeps]'

/**
 * Backstop for a remote wake whose `turn-complete` never returns (frame lost,
 * owner crashed mid-turn). Bounded at the run's own max duration: a turn cannot
 * legitimately outlive the run circuit that spawns it, so timing out here never
 * truncates a live turn — it only reclaims a genuinely dead wake instead of
 * leaking the waiter and hanging the orchestration turn forever. The common
 * "owner went offline" case is resolved far sooner by the bus's
 * resolvePendingWaitsForMember on confirmed-offline; this only catches the
 * pathological lost-completion path.
 */
const WAKE_COMPLETION_BACKSTOP_MS = TEAM_CIRCUIT_DEFAULTS.maxDurationMs

function serialize(request: SendAppChatRequest): SerializedWakeRequest {
  return {
    appId: request.appId,
    spaceId: request.spaceId,
    message: request.message,
    conversationId: request.conversationId,
    teamContext: request.teamContext,
  }
}

function finalMessageFor(outcome: TurnCompletion): string | null {
  if (outcome.kind === 'result') return outcome.content
  if (outcome.kind === 'escalation') return outcome.content
  return null
}

/**
 * Owner-side counterpart to the remote `getMemberSpaceId` sentinel.
 *
 * A wake frame's `request.spaceId` is the SENDER's value. For a member the
 * sender does not own that value is a non-null sentinel (the appId — see
 * `getMemberSpaceId` below), because only the OWNER can resolve the member's
 * real space. When a wake lands on the owner it runs the member locally, so it
 * must substitute its own authoritative space before the turn runs; otherwise
 * the session persists under `getSpace(appId)` (which does not exist) and the
 * transcript is silently never written — the member's reply then has no record
 * to reload or to serve to a cross-node viewer.
 *
 * `resolveOwnSpaceId` returns the member's installed space on this node, or null
 * when this node does not own it (then the wire value is kept unchanged so an
 * unexpected wake degrades to the prior behaviour rather than corrupting input).
 */
export function withOwnerResolvedSpace(
  request: SerializedWakeRequest,
  resolveOwnSpaceId: (appId: string) => string | null
): SerializedWakeRequest {
  const ownSpaceId = resolveOwnSpaceId(request.appId)
  return ownSpaceId ? { ...request, spaceId: ownSpaceId } : request
}

export function makeLocationAwareSessionDeps(
  config: LocationAwareSessionDepsConfig
): OrchestrationSessionDeps {
  const {
    local,
    resolveOwnerNode,
    selfNodeId,
    sendWake,
    registerTurnComplete,
    getRemoteSpaceId,
  } = config

  function isLocal(appId: string, teamId?: string): boolean {
    return resolveOwnerNode(appId, teamId) === SELF_NODE_ID
  }

  return {
    sendAppChatMessage(request) {
      const owner = resolveOwnerNode(request.appId, request.teamContext.teamId)
      if (owner === SELF_NODE_ID) return local.sendAppChatMessage(request)

      const correlationId = request.teamContext.correlationId
      // The turn's team IS the office (a federated team's id is its office id).
      // Never derived from the appId: the same app in another office would route
      // the wake over the wrong link (a silent black hole when that office's
      // transport cannot reach the owner).
      const officeId = request.teamContext.teamId
      console.log(
        `${LOG_TAG} remote wake app=${request.appId} owner=${owner} office=${officeId} corr=${correlationId} self=${selfNodeId}`
      )

      return new Promise<{ finalMessage: string | null; undelivered?: { reason: string } }>((resolve) => {
        // Idempotent settle: whichever of {completion, backstop, unsent} fires
        // first wins; the rest are no-ops. Mirrors the relay wake path so a lost
        // turn-complete can never leak the waiter or hang the turn forever.
        let done = false
        let timer: ReturnType<typeof setTimeout>
        // A genuine completion (even an empty reply) resolves with finalMessage;
        // a non-delivery resolves with an `undelivered` marker so the sender learns
        // the truth rather than reading an empty message as a real reply.
        const finishCompleted = (finalMessage: string | null): void => {
          if (done) return
          done = true
          clearTimeout(timer)
          unregister()
          resolve({ finalMessage })
        }
        const finishUndelivered = (reason: string): void => {
          if (done) return
          done = true
          clearTimeout(timer)
          unregister()
          resolve({ finalMessage: null, undelivered: { reason } })
        }
        const unregister = registerTurnComplete(correlationId, (outcome) =>
          finishCompleted(finalMessageFor(outcome))
        )
        // Long last-resort backstop: a turn may legitimately run up to the run's max
        // duration, so this must NOT be shortened to minutes (that would truncate a
        // live long turn into a false timeout). It only reclaims the pathological
        // "owner online but no completion ever arrives" case; the common offline
        // case unblocks far sooner via the bus's resolvePendingWaitsForMember, and a
        // lost completion is prevented at the source by turn-complete retransmission.
        // Crucially it now resolves as UNDELIVERED, not a fake empty success.
        timer = setTimeout(() => {
          console.warn(
            `${LOG_TAG} turn-complete backstop fired app=${request.appId} owner=${owner} corr=${correlationId}`
          )
          finishUndelivered('no-completion-signal')
        }, WAKE_COMPLETION_BACKSTOP_MS)
        if (typeof timer.unref === 'function') timer.unref()

        const sent = sendWake({
          officeId,
          ownerNodeId: owner,
          request: serialize(request),
          correlationId,
        })
        if (!sent) {
          // Owner unreachable at send time: the wake definitively did NOT go out.
          // Resolve as undelivered (not empty success) so the sender can reassign;
          // the lead's wait=true hang is additionally covered by the message bus's
          // resolvePendingWaitsForMember on confirmed-offline.
          console.warn(`${LOG_TAG} wake not sent app=${request.appId} owner=${owner}; resolving undelivered`)
          finishUndelivered('owner-unreachable')
        }
      })
    },

    isSessionActive(sessionKey) {
      // Remote members run their session on the owner; the authority does not
      // track it. Returning false makes the bus deliver rather than buffer.
      return local.isSessionActive(sessionKey)
    },

    closeTeamSession(appId, teamId, epochId) {
      if (isLocal(appId, teamId)) return local.closeTeamSession(appId, teamId, epochId)
      // The owner tears down its own session; nothing to close here.
      return Promise.resolve()
    },

    getMemberSpaceId(appId) {
      if (isLocal(appId)) return local.getMemberSpaceId(appId)
      // Synchronous, non-null sentinel: the owner resolves the real space
      // locally and ignores this value. Must not become async — orchestration
      // calls it inline before waking.
      return getRemoteSpaceId(appId) ?? appId
    },
  }
}
