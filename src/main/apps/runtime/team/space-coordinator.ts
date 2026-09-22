/**
 * Delivery of team traffic to a SPACE COORDINATOR — the space conversation
 * coordinating an ephemeral collaboration.
 *
 * The bus routes anything addressed to a coordinator sentinel appId here
 * instead of app-chat (see `TeamDeliveryHooks.deliverToCoordinator`). This
 * module renders the envelope for the space agent and gates on the epoch still
 * being open; the actual conversation wake/queue mechanics are injected by
 * bootstrap (conversation-interop owns that machinery, and this module must
 * stay importable without it).
 */

import { oneLineExcerpt } from '../text-truncate'
import { parseSpaceCoordinatorAppId } from '../../../../shared/apps/team-types'
import type { TeamEnvelope, TeamTriggerContext } from '../../../../shared/apps/team-types'
import type { TeamStore } from '../../team'

const LOG_TAG = '[TeamSpaceCoord]'

/** One team message as the space conversation receives it. */
export interface CoordinatorDeliveryRequest {
  spaceId: string
  conversationId: string
  /** What the model reads as this turn's input (framed). */
  turnInput: string
  /** What the transcript keeps: the raw body plus rendering metadata. */
  persist: {
    content: string
    metadata: {
      teamId: string
      epochId: string
      teamName: string
      fromMemberName: string | null
      teamTriggerKind: string
    }
  }
}

export type DeliverToSpaceConversation = (request: CoordinatorDeliveryRequest) => Promise<void>

const SUMMARY_LIMIT = 120

/**
 * Frame a teammate's message for the coordinating space agent. System-authored
 * wakes (turn-end reports, periodic checks) carry their own headers and pass
 * verbatim; only a member's directed message needs provenance and the reminder
 * that a teammate's words are not the user's.
 */
function renderTurnInput(
  body: string,
  fromMemberName: string | null,
  teamName: string,
  kind: TeamTriggerContext['kind']
): string {
  if (kind === 'member_stopped' || kind === 'periodic_check' || !fromMemberName) return body
  return (
    `[Team message from ${fromMemberName} — collaboration "${teamName}". ` +
    `A teammate is reporting to you, the coordinator; this is not a message from your user. ` +
    `Weigh it against the goal, coordinate further work with the team tools if needed, ` +
    `and tell the user only what matters.]\n\n${body}`
  )
}

/**
 * Build the bus hook that lands coordinator-addressed envelopes in their space
 * conversation. Deliberately drops (with a log) rather than throws for a
 * closed collaboration: the sender's turn already happened, and an error here
 * would surface as a failed send for work that simply finished.
 */
export function createCoordinatorDelivery(deps: {
  store: TeamStore
  deliver: DeliverToSpaceConversation
}): (params: { envelope: TeamEnvelope; trigger: TeamTriggerContext }) => Promise<void> {
  const { store, deliver } = deps

  return async ({ envelope, trigger }) => {
    const team = store.getTeamById(envelope.teamId)
    const epoch = store.getEpochById(envelope.epochId)
    if (!team || !epoch || epoch.endedAt !== null || epoch.workItem?.status === 'completed') {
      console.log(
        `${LOG_TAG} delivery dropped (collaboration closed): team=${envelope.teamId} ` +
          `epoch=${envelope.epochId} kind=${trigger.kind ?? 'message'}`
      )
      return
    }
    const conversationId =
      team.coordinatorConversationId ?? parseSpaceCoordinatorAppId(envelope.toAppId)
    if (!conversationId) {
      console.warn(`${LOG_TAG} delivery dropped (no coordinating conversation): team=${envelope.teamId}`)
      return
    }

    const fromMemberName =
      trigger.fromAppId && !parseSpaceCoordinatorAppId(trigger.fromAppId)
        ? store.getMember(envelope.teamId, trigger.fromAppId)?.memberName ?? null
        : null

    console.log(
      `${LOG_TAG} deliver: team=${envelope.teamId} epoch=${envelope.epochId} ` +
        `conversation=${conversationId} from=${fromMemberName ?? 'system'} ` +
        `kind=${trigger.kind ?? 'message'} "${oneLineExcerpt(envelope.body, SUMMARY_LIMIT)}"`
    )

    await deliver({
      spaceId: team.owningSpaceId,
      conversationId,
      turnInput: renderTurnInput(envelope.body, fromMemberName, team.name, trigger.kind),
      persist: {
        content: envelope.body,
        metadata: {
          teamId: envelope.teamId,
          epochId: envelope.epochId,
          teamName: team.name,
          fromMemberName,
          teamTriggerKind: trigger.kind ?? 'message',
        },
      },
    })
  }
}
