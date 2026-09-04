/**
 * The composer's `#` mention menu: which conversations match a query, and
 * whether that is enough to open the menu.
 *
 * A bare `#` (empty query) deliberately shows EVERY conversation, up to the
 * cap — the opposite of how the separate, file-only `@` trigger behaves
 * (empty query there shows nothing extra; unrelated to this module, `@`'s
 * own logic lives inline in InputArea.tsx). Two reasons, both load-bearing —
 * losing either one reopens a version of the same regression `@` once had:
 * 1. Conversation titles are usually auto-generated ("Fix onboarding bug")
 *    and rarely memorized verbatim — candidates here exist to be BROWSED,
 *    not looked up by a query the user would already have to know.
 * 2. `#` is rare in ordinary text (unlike `@`, which shows up in emails,
 *    "cc @someone") — an eager, wide-open candidate list on bare trigger
 *    carries little risk of hijacking input the user never meant as a
 *    mention, which is exactly the risk that made `@` unsafe to do this for.
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
