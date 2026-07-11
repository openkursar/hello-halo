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

import { SELF_NODE_ID } from '../../../../shared/apps/team-types'
import type { OrchestrationSessionDeps } from '../team'
import type { TurnCompletion } from '../team/message-bus'
import type { SerializedWakeRequest } from './types'

type SendAppChatRequest = Parameters<OrchestrationSessionDeps['sendAppChatMessage']>[0]

export interface LocationAwareSessionDepsConfig {
  /** The existing local impl, reused verbatim for self-owned members. */
  local: OrchestrationSessionDeps
  /** Owner node of a member's appId; SELF_NODE_ID for a locally-owned member. */
  resolveOwnerNode: (appId: string) => string
  /** This node's own stable node id (kept for parity/diagnostics). */
  selfNodeId: string
  /** Authority → owner wake send; false when the owner is unreachable. */
  sendWake: (p: {
    officeId: string
    ownerNodeId: string
    request: SerializedWakeRequest
    correlationId: string
  }) => boolean
  /** Register a one-shot completion callback keyed by correlationId. */
  registerTurnComplete: (correlationId: string, cb: (outcome: TurnCompletion) => void) => void
  /** Cached spaceId of a remote member (populated at join). */
  getRemoteSpaceId: (appId: string) => string | undefined
  /** Office a member belongs to, so the wake routes over the right host link. */
  resolveOfficeId: (appId: string) => string | null
}

const LOG_TAG = '[FedSessionDeps]'

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
    resolveOfficeId,
  } = config

  function isLocal(appId: string): boolean {
    return resolveOwnerNode(appId) === SELF_NODE_ID
  }

  return {
    sendAppChatMessage(request) {
      const owner = resolveOwnerNode(request.appId)
      if (owner === SELF_NODE_ID) return local.sendAppChatMessage(request)

      const correlationId = request.teamContext.correlationId
      const officeId = resolveOfficeId(request.appId)
      console.log(
        `${LOG_TAG} remote wake app=${request.appId} owner=${owner} office=${officeId} corr=${correlationId} self=${selfNodeId}`
      )

      return new Promise<{ finalMessage: string | null }>((resolve) => {
        registerTurnComplete(correlationId, (outcome) => {
          resolve({ finalMessage: finalMessageFor(outcome) })
        })
        // No office → no host link to reach the owner; treat as unreachable.
        const sent =
          officeId !== null &&
          sendWake({ officeId, ownerNodeId: owner, request: serialize(request), correlationId })
        if (!sent) {
          // Owner unreachable: resolve empty rather than reject (orchestration
          // treats rejection as error). The lead's wait=true hang is handled by
          // the message bus's resolvePendingWaitsForMember on confirmed-offline.
          console.warn(`${LOG_TAG} wake not sent app=${request.appId} owner=${owner}; resolving empty`)
          resolve({ finalMessage: null })
        }
      })
    },

    isSessionActive(sessionKey) {
      // Remote members run their session on the owner; the authority does not
      // track it. Returning false makes the bus deliver rather than buffer.
      return local.isSessionActive(sessionKey)
    },

    closeTeamSession(appId, teamId, epochId) {
      if (isLocal(appId)) return local.closeTeamSession(appId, teamId, epochId)
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
