/**
 * The conversation part of the composer's `@` menu: which conversations match
 * a query, and whether that is enough to open the menu at all.
 *
 * An empty query deliberately keeps EVERY conversation a candidate rather
 * than none, because conversation titles are auto-generated ("Fix onboarding
 * bug") and rarely memorized verbatim — they exist to be browsed, not looked
 * up by a query the user would have to know already. How many of those
 * actually reach the screen on a bare `@` is the menu's call, not this
 * module's: it caps each kind so no single group crowds out the others.
 */

import type { ConversationMentionCandidate } from './cross-conversation'

/** Conversation candidates shown at once — the rest becomes "type more to narrow". */
const MAX_CONVERSATION_CANDIDATES = 20

export interface ConversationMentionDecision {
  /** Every conversation (capped) for an empty query; substring-filtered by title otherwise. */
  candidates: ConversationMentionCandidate[]
  /** Whether the menu should open — this space having any other conversation is sufficient. */
  shouldOpenMenu: boolean
}

export function decideConversationMentionCandidates(params: {
  query: string
  conversations: readonly ConversationMentionCandidate[]
}): ConversationMentionDecision {
  const normalizedQuery = params.query.trim().toLowerCase()
  const matched = normalizedQuery
    ? params.conversations.filter((c) => c.title.toLowerCase().includes(normalizedQuery))
    : params.conversations

  return {
    candidates: matched.slice(0, MAX_CONVERSATION_CANDIDATES),
    shouldOpenMenu: params.conversations.length > 0,
  }
}
