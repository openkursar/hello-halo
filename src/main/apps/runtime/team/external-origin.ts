/**
 * Whether the work a member is doing was asked for from another machine.
 *
 * A message carries that explicitly (`TeamTriggerContext.external`, stamped
 * where the request crossed into this node), but a member's work is woken again
 * by its own runtime — an answer it was blocked on, a periodic check, a
 * quiescence nudge. Those wakes are authored HERE and so carry no origin, which
 * is the bypass: ask for something that needs a decision, wait for the owner to
 * answer their digital human's question, and the resumed turn runs with the
 * owner's own reach.
 *
 * Origin sticks to the team session until its owner types here or the task is
 * permanently closed. Resting a task must not reset its authority.
 */

import type { TeamTriggerContext } from '../../../../shared/apps/team-types'
import { parseTeamSessionKey } from '../../../../shared/apps/im-keys'

/**
 * Bounded so a long-lived process cannot accumulate one entry per external
 * thread ever opened. Eviction is oldest-first and only ever LOSES stickiness:
 * an evicted thread falls back to what its next message says about itself.
 */
const MAX_TRACKED_SESSIONS = 2000
const externalSessions = new Set<string>()

/**
 * Resolve this turn's origin and remember it for the wakes that follow.
 *
 * @param sessionKey the member's team session (see `buildTeamSessionKey`)
 */
export function resolveTurnOrigin(sessionKey: string, trigger: TeamTriggerContext): boolean {
  if (isOwnPersonTurn(trigger)) {
    externalSessions.delete(sessionKey)
    return false
  }
  if (trigger.external) {
    // Re-inserted so the entry counts as the newest for eviction.
    externalSessions.delete(sessionKey)
    externalSessions.add(sessionKey)
    if (externalSessions.size > MAX_TRACKED_SESSIONS) {
      const oldest = externalSessions.values().next()
      if (!oldest.done) externalSessions.delete(oldest.value)
    }
  }
  return peekTurnOrigin(sessionKey, trigger)
}

/**
 * The origin a turn on this session runs — or would have run — under, without
 * remembering it. For describing a turn from outside it (one that timed out, or
 * never ran), so the description and the turn itself cannot disagree.
 */
export function peekTurnOrigin(sessionKey: string, trigger: TeamTriggerContext): boolean {
  if (trigger.external) return true
  if (isOwnPersonTurn(trigger)) return false
  // Runtime-authored, or a teammate's message that started here: inherit.
  return externalSessions.has(sessionKey)
}

/**
 * A person typed this, here. A person on ANOTHER machine reaches the member
 * through the office endpoint, and a guest through an IM chat, both stamped
 * before it gets this far — so an unstamped one is the owner (at their own
 * keyboard, or in a chat that counts them as one), and that is the one act
 * that ends a borrowed thread of work.
 */
function isOwnPersonTurn(trigger: TeamTriggerContext): boolean {
  return !trigger.external && (!trigger.kind || trigger.kind === 'human_message')
}

/** Forget a thread of work that no longer exists. */
export function forgetTurnOrigin(sessionKey: string): void {
  externalSessions.delete(sessionKey)
}

/** Permanently closed epochs release every member, including members removed from the roster. */
export function forgetEpochTurnOrigins(teamId: string, epochId: string): void {
  for (const sessionKey of externalSessions) {
    const session = parseTeamSessionKey(sessionKey)
    if (session?.teamId === teamId && session.epochId === epochId) externalSessions.delete(sessionKey)
  }
}
