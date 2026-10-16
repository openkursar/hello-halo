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

import { SELF_NODE_ID, type TeamTriggerContext } from '../../../../shared/apps/team-types'
import { parseTeamSessionKey } from '../../../../shared/apps/im-keys'
import type { OrchestrationSessionDeps } from '../team'
import type { TurnCompletion } from '../team/message-bus'
import type { SerializedWakeRequest } from './types'
import { oneLineExcerpt } from '../text-truncate'

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
  /**
   * Ask the owner node to abort a member's running turn, resolving with whether
   * one was running. Injected like `sendWake` so this module keeps no transport.
   * Rejects when the owner refuses or cannot be reached.
   */
  sendStop: (p: { officeId: string; ownerNodeId: string; appId: string; epochId: string }) => Promise<boolean>
  /** Cached spaceId of a remote member (populated at join). */
  getRemoteSpaceId: (appId: string) => string | undefined
}

const LOG_TAG = '[FedSessionDeps]'

/**
 * Backstop for a remote wake whose `turn-complete` never returns (frame lost,
 * owner crashed mid-turn). Timing out here never truncates a live turn — it
 * only reclaims a genuinely dead wake instead of leaking the waiter and
 * hanging the orchestration turn forever. The common "owner went offline"
 * case is resolved far sooner by the bus's resolvePendingWaitsForMember on
 * confirmed-offline; this only catches the pathological lost-completion path.
 */
export const WAKE_COMPLETION_BACKSTOP_MS = 2 * 60 * 60 * 1000
const MAX_REMOTE_MESSAGE_RECEIPTS = 1024

function serialize(request: SendAppChatRequest): SerializedWakeRequest {
  return {
    appId: request.appId,
    spaceId: request.spaceId,
    message: request.message,
    recordedMessages: request.recordedMessages,
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

/**
 * Mark an arriving wake as what it is: a request from another machine.
 *
 * Set here rather than trusted from the frame, for the same reason the space is
 * re-resolved above — the sender authored every field, so a sender that simply
 * omitted this one would have its request run as if the owner had started it.
 * Arriving over the link IS the evidence, and it is evidence only this side has.
 */
export function withExternalOrigin(
  request: SerializedWakeRequest,
  source?: { teamName?: string; fromMemberName?: string | null },
): SerializedWakeRequest {
  const incoming = request.teamContext
  const kind: TeamTriggerContext['kind'] = incoming.kind === 'run_start' || incoming.kind === 'periodic_check' || incoming.kind === 'member_stopped'
    ? incoming.kind : 'message'
  const teamContext: TeamTriggerContext = {
    teamId: incoming.teamId,
    epochId: incoming.epochId,
    correlationId: incoming.correlationId,
    fromAppId: typeof incoming.fromAppId === 'string' ? incoming.fromAppId : null,
    wait: incoming.wait === true,
    kind,
    external: true,
    // Forging this only withholds a turn report; it grants nothing.
    ...(incoming.kind === 'human_message' && incoming.fromAppId == null ? { personalChat: true } : {}),
    ...(typeof incoming.taskId === 'string' ? { taskId: incoming.taskId } : {}),
    ...(Number.isSafeInteger(incoming.forwardDepth) && incoming.forwardDepth! >= 0 ? { forwardDepth: incoming.forwardDepth } : {}),
  }
  if (incoming.kind === undefined || !['run_start', 'message', 'periodic_check', 'human_message', 'member_stopped'].includes(incoming.kind)) {
    console.warn(`${LOG_TAG} Remote wake kind normalized: team=${teamContext.teamId} app=${request.appId} corr=${teamContext.correlationId}`)
  }
  const records = Array.isArray(request.recordedMessages) && request.recordedMessages.length > 0
    ? request.recordedMessages : [{ content: request.message }]
  const recordedMessages = records.map(record => {
    if (!record || typeof record.content !== 'string') throw new TypeError('Remote message records must contain text')
    // A person's own words read as theirs, as the same chat on one machine does;
    // only the authority above is narrowed.
    if (teamContext.personalChat) {
      return { content: record.content, teamOrigin: { kind: 'human_message' as const, correlationId: teamContext.correlationId } }
    }
    // Display only, and bounded: the sender's own words for the card.
    const summary = record.provenance?.metadata?.summary
    return {
      content: record.content,
      teamOrigin: { kind, correlationId: teamContext.correlationId },
      provenance: {
        source: 'team-message' as const,
        metadata: {
          teamId: teamContext.teamId, epochId: teamContext.epochId, teamTriggerKind: kind,
          fromMemberName: source?.fromMemberName ?? null,
          ...(source?.teamName ? { teamName: source.teamName } : {}),
          ...(typeof summary === 'string' && summary.trim() ? { summary: oneLineExcerpt(summary, 200) } : {}),
        },
      },
    }
  })
  // Runtime holds, callbacks, IM standing and transcript authority never come from a peer's JSON.
  return {
    appId: request.appId,
    spaceId: request.spaceId,
    message: request.message,
    conversationId: request.conversationId,
    teamContext,
    recordedMessages,
    ...(typeof request.coalescingKey === 'string' ? { coalescingKey: request.coalescingKey } : {}),
  }
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
    sendStop,
    getRemoteSpaceId,
  } = config

  const remoteMessages = new Map<string, {
    appId: string
    teamId: string
    epochId: string
    finish: (outcome: TurnCompletion) => void
  }>()

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
        // A completion that says the wake never arrived is NOT a completion. The
        // owner's node never ran a turn, so routing it through `finishCompleted`
        // handed the sender an empty reply that reads as "they answered nothing" —
        // the board then recorded the message as delivered and nothing anywhere
        // reported the failure.
        const unregister = registerTurnComplete(correlationId, (outcome) => {
          if (outcome.kind === 'undelivered') {
            console.warn(
              `${LOG_TAG} wake reported undelivered app=${request.appId} owner=${owner} ` +
                `corr=${correlationId} reason=${outcome.reason}`
            )
            finishUndelivered(outcome.reason)
            return
          }
          finishCompleted(finalMessageFor(outcome))
        })
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
          // a person's 1:1 chat blocking on a completion receipt is additionally
          // covered by the bus's resolvePendingWaitsForMember on confirmed-offline.
          console.warn(`${LOG_TAG} wake not sent app=${request.appId} owner=${owner}; resolving undelivered`)
          finishUndelivered('owner-unreachable')
        }
      })
    },

    deliverRemoteMessage(request) {
      const owner = resolveOwnerNode(request.appId, request.teamContext.teamId)
      if (owner === SELF_NODE_ID) return undefined
      const correlationId = request.teamContext.correlationId
      if (remoteMessages.has(correlationId)) return true
      if (remoteMessages.size >= MAX_REMOTE_MESSAGE_RECEIPTS) {
        console.warn(`${LOG_TAG} remote message refused app=${request.appId} owner=${owner} reason=receipt capacity count=${remoteMessages.size}`)
        return false
      }
      let finished = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let unregister = () => {}
      const finish = (outcome: TurnCompletion): void => {
        if (finished) return
        finished = true
        remoteMessages.delete(correlationId)
        if (timer) clearTimeout(timer)
        unregister()
        if (outcome.kind === 'error' || outcome.kind === 'undelivered' || outcome.kind === 'timeout') {
          console.warn(`${LOG_TAG} remote message failed app=${request.appId} owner=${owner} corr=${correlationId} outcome=${outcome.kind}`)
        }
        try { request.onCompletion(outcome) } catch (error) {
          console.error(`${LOG_TAG} remote message completion observer failed app=${request.appId} corr=${correlationId}`, error)
        }
      }
      remoteMessages.set(correlationId, {
        appId: request.appId, teamId: request.teamContext.teamId, epochId: request.teamContext.epochId, finish,
      })
      unregister = registerTurnComplete(correlationId, finish)
      timer = setTimeout(() => finish({ kind: 'undelivered', reason: 'no-completion-signal' }), WAKE_COMPLETION_BACKSTOP_MS)
      timer.unref?.()
      try {
        const accepted = sendWake({
          officeId: request.teamContext.teamId,
          ownerNodeId: owner,
          correlationId,
          request: { ...serialize(request), coalescingKey: request.coalescingKey },
        })
        if (!accepted) finish({ kind: 'undelivered', reason: 'owner-unreachable' })
        return accepted
      } catch (error) {
        finish({ kind: 'undelivered', reason: error instanceof Error ? error.message : String(error) })
        return false
      }
    },

    getTurnIdentity(sessionKey) { return local.getTurnIdentity?.(sessionKey) },

    holdTurn(sessionKey) {
      // Only a session this machine runs can be raced here; a remote member's
      // owner holds its own when the wake lands.
      const parsed = parseTeamSessionKey(sessionKey)
      return parsed && isLocal(parsed.appId, parsed.teamId) ? local.holdTurn?.(sessionKey) : undefined
    },

    isSessionActive(sessionKey) {
      // Remote members run their session on the owner, so this answers false and
      // the bus hands the wake straight over. Deliberate: busyness is only
      // knowable on the machine that runs the turn, so the OWNER applies the gate
      // when the wake lands (app-chat delivery). Do not answer this from a
      // remote status view — it is already stale when the wake arrives.
      return local.isSessionActive(sessionKey)
    },

    injectIntoSession(sessionKey, message, messages, trigger, onTakenBack) {
      return local.injectIntoSession(sessionKey, message, messages, trigger, onTakenBack)
    },

    recordStoppedInputs(sessionKey, records) {
      local.recordStoppedInputs?.(sessionKey, records)
    },

    closeTeamSession(appId, teamId, epochId) {
      for (const pending of remoteMessages.values()) {
        if (pending.appId === appId && pending.teamId === teamId && pending.epochId === epochId) {
          pending.finish({ kind: 'undelivered', reason: 'task-closed-before-completion' })
        }
      }
      if (isLocal(appId, teamId)) return local.closeTeamSession(appId, teamId, epochId)
      // The owner tears down its own session; nothing to close here.
      return Promise.resolve()
    },

    stopTeamSession(appId, teamId, epochId) {
      const owner = resolveOwnerNode(appId, teamId)
      if (owner === SELF_NODE_ID) return local.stopTeamSession(appId, teamId, epochId)
      // Unlike closeTeamSession, doing nothing here would be a lie: the turn is
      // running on the owner and somebody just asked for it to stop. The request
      // travels, and its answer is the owner's.
      console.log(`${LOG_TAG} remote stop app=${appId} owner=${owner} office=${teamId}`)
      return sendStop({ officeId: teamId, ownerNodeId: owner, appId, epochId })
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
