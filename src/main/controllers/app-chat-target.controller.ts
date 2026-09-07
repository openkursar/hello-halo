/**
 * App Chat Target Controller — the trust boundary for a caller-supplied
 * app-chat conversationId, and the one place a team turn's identity is derived.
 *
 * Shape validation lives in `shared/apps/im-keys` because the renderer builds
 * the same keys. The questions a team key raises are not answerable from the
 * string — does this epoch belong to this team, is this app a member of it —
 * and answering them needs the team store, so they are answered here, once, for
 * every app-chat entry point rather than per route.
 *
 * The team context is DERIVED here rather than accepted from the request. It
 * decides whether traffic is recorded as a teammate's work or a person's words,
 * and whether it is charged to the run's message budget; a caller that could
 * supply it could speak as any member of the office.
 */

import { randomUUID } from 'crypto'
import { getTeamStore } from '../apps/team'
import { resolveHttpConversationId } from '../../shared/apps/im-keys'
import { isRemoteMember } from '../../shared/apps/team-types'
import type { TeamTriggerContext } from '../../shared/apps/team-types'

/** An accepted target: the session to address, plus the team identity it implies. */
export interface AppChatTarget {
  ok: true
  conversationId: string
  /**
   * Present only for a team-channel session. Carries no `kind`, which is what
   * marks it as the OWNER's own turn: the remote web client reaching this
   * endpoint is the same person as the desktop one, and an office credential
   * cannot reach it at all (`http/auth/route-scope`). A `kind` here would put
   * the owner's own chat under the delegated capability policy meant for
   * someone else's traffic (see `apps/runtime/capability-policy`).
   */
  teamContext?: TeamTriggerContext
}

export interface AppChatTargetRejected {
  ok: false
  /** HTTP status the transport should answer with. */
  status: number
  error: string
}

export type AppChatTargetResult = AppChatTarget | AppChatTargetRejected

/**
 * Validate a caller-supplied conversationId for `appId` and resolve what it
 * addresses. Rejections carry the status the caller should answer with, so the
 * transport stays a pass-through.
 */
export function resolveAppChatTarget(appId: string, conversationId: unknown): AppChatTargetResult {
  const shape = resolveHttpConversationId(appId, conversationId)
  if (!shape.ok) return { ok: false, status: 400, error: shape.error }
  if (!shape.team) return { ok: true, conversationId: shape.conversationId }

  const store = getTeamStore()
  if (!store) {
    return { ok: false, status: 503, error: 'Team store is not yet initialized. Please try again shortly.' }
  }

  const { teamId, epochId } = shape.team
  // Both halves matter: an epoch id alone would let a caller address one team's
  // session through another team's id, and the pair is what the session key —
  // and therefore the transcript file — is built from.
  //
  // A SEALED epoch is deliberately still addressable: `noteEpochTurn` treats a
  // seal as reversible and wakes the epoch on the next turn, which is what lets
  // a person pick a finished conversation back up. The desktop client can do
  // this; refusing it here would make remote the weaker of the two.
  const epoch = store.getEpochById(epochId)
  if (!epoch || epoch.teamId !== teamId) {
    return { ok: false, status: 404, error: 'Unknown team conversation' }
  }
  // Membership is not enough — the same pair of conditions the IM binding is
  // held to (`dispatch-inbound.ts`'s `resolveTeamBacking`). A federated member's
  // app is not installed on this machine, so nothing here could run its turn:
  // without this the send is accepted, answered 200, and only fails later inside
  // a fire-and-forget promise the caller never sees. Its own machine serves it.
  const member = store.getMember(teamId, appId)
  if (!member) {
    return { ok: false, status: 403, error: 'This digital human is not a member of that team' }
  }
  if (isRemoteMember(member)) {
    return {
      ok: false,
      status: 403,
      error: 'That teammate runs on another machine; only its owner can serve this session',
    }
  }

  return {
    ok: true,
    conversationId: shape.conversationId,
    teamContext: {
      teamId,
      epochId,
      correlationId: randomUUID(),
      fromAppId: null,
      wait: false,
    },
  }
}
