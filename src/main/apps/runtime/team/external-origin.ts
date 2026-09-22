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
 * So origin sticks to the thread of work and is cleared only by a person typing
 * into that thread on this machine. Keyed by team session, which is exactly the
 * granularity a thread of work has.
 */

import type { TeamTriggerContext } from '../../../../shared/apps/team-types'

/**
 * Bounded so a long-lived process cannot accumulate one entry per conversation
 * ever opened. Eviction is oldest-first and only ever LOSES stickiness, which
 * is why the cap can be generous rather than exact: an evicted thread falls
 * back to what its next message says about itself.
 */
const MAX_TRACKED_SESSIONS = 2000

const origins = new Map<string, boolean>()

/**
 * Resolve this turn's origin and remember it for the wakes that follow.
 *
 * @param sessionKey the member's team session (see `buildTeamSessionKey`)
 */
export function resolveTurnOrigin(sessionKey: string, trigger: TeamTriggerContext): boolean {
  if (trigger.external) {
    remember(sessionKey, true)
    return true
  }

  // A person typed this, here. A person on ANOTHER machine reaches the member
  // through the office endpoint, which stamps the message before it gets this
  // far — so an unstamped one is the owner at their own keyboard, and that is
  // the one act that ends a borrowed thread of work.
  if (!trigger.kind || trigger.kind === 'human_message') {
    remember(sessionKey, false)
    return false
  }

  // Runtime-authored, or a teammate's message that started here: inherit.
  return origins.get(sessionKey) ?? false
}

/** Forget a thread of work that no longer exists. */
export function forgetTurnOrigin(sessionKey: string): void {
  origins.delete(sessionKey)
}

function remember(sessionKey: string, external: boolean): void {
  // Re-insert so the entry counts as the newest for eviction.
  origins.delete(sessionKey)
  origins.set(sessionKey, external)
  if (origins.size > MAX_TRACKED_SESSIONS) {
    const oldest = origins.keys().next()
    if (!oldest.done) origins.delete(oldest.value)
  }
}
