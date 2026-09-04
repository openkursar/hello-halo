/**
 * Cross-Conversation Interop — resolving a tool's `target` argument.
 *
 * The composer inserts a reference as `[#Title](conv:3a5d77ea)`
 * (`shared/conversation-reference.ts`), so a model reading a message has two
 * usable handles and no id in the form transport actually wants: a short id
 * and a title. Resolving all of them here lets every caller keep taking one
 * `target` string, and keeps the failure modes honest — an ambiguous handle
 * comes back as its candidates rather than a silently-picked first match,
 * which is the meaning-swap this whole feature exists to avoid.
 */

import { getConversation, listConversations } from '../conversation.service'
import { isShortConversationId, normalizeConversationTarget, shortConversationId } from '../../../shared/conversation-reference'

export type ResolveTargetResult =
  | { ok: true; conversationId: string }
  | { ok: false; reason: 'not_found' }
  /** The only conversation with this exact title is the caller's own. */
  | { ok: false; reason: 'self_target_title' }
  /** More than one OTHER conversation in this space has this exact title. */
  | { ok: false; reason: 'ambiguous_title'; candidates: { id: string; updatedAt: string }[] }
  /** More than one conversation's id starts with this short id. */
  | { ok: false; reason: 'ambiguous_short_id'; candidates: { id: string; updatedAt: string }[] }

/**
 * Id first, exact — an id is never ambiguous and never needs normalizing, so
 * a hit here is authoritative and title matching is skipped entirely.
 *
 * Falling back to title only on a miss keeps a real id from ever being
 * reinterpreted as a title by coincidence. Title matching is EXACT (not
 * substring/fuzzy — this is text a model is expected to have copied
 * verbatim from the @ mention it was shown), case-insensitive, and trims
 * leading/trailing whitespace — a model paraphrasing "the Postgres
 * migration " should not miss over incidental whitespace alone.
 */
export function resolveConversationTarget(
  spaceId: string,
  callerConversationId: string,
  target: string
): ResolveTargetResult {
  const cleaned = normalizeConversationTarget(target)
  if (getConversation(spaceId, cleaned)) {
    return { ok: true, conversationId: cleaned }
  }

  // Short id next: it is still an id, so like a full id it does NOT exclude
  // the caller — `self_target` downstream owns that rejection, and having one
  // place decide it keeps the two from disagreeing. A short id that matches
  // nothing falls through to title matching rather than failing here, so a
  // conversation genuinely titled something hex-shaped stays reachable.
  if (isShortConversationId(cleaned)) {
    const prefix = cleaned.toLowerCase()
    const idMatches = listConversations(spaceId).filter((c) => shortConversationId(c.id) === prefix)
    if (idMatches.length === 1) return { ok: true, conversationId: idMatches[0].id }
    if (idMatches.length > 1) {
      return {
        ok: false,
        reason: 'ambiguous_short_id',
        candidates: sortByRecency(idMatches),
      }
    }
  }

  const normalized = cleaned.trim().toLowerCase()
  // Computed BEFORE excluding self: the exclusion below must only ever drop
  // the caller's own row out of an already-known set of matches, never
  // change whether "this title has any match at all" — otherwise the only
  // title match being the caller itself is indistinguishable from there
  // being no match, and `not_found` becomes a lie for a conversation the
  // caller is looking straight at.
  const allTitleMatches = listConversations(spaceId).filter((c) => c.title.trim().toLowerCase() === normalized)
  const candidates = allTitleMatches.filter((c) => c.id !== callerConversationId)

  if (candidates.length === 0) {
    // Excluding self emptied a non-empty set — the one match WAS self.
    return { ok: false, reason: allTitleMatches.length > 0 ? 'self_target_title' : 'not_found' }
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous_title',
      candidates: sortByRecency(candidates),
    }
  }
  return { ok: true, conversationId: candidates[0].id }
}

/**
 * Most recently active first — the same order the list tool presents, stated
 * here rather than inherited from `listConversations`' own ordering so a
 * change there cannot silently reshuffle what an ambiguity error offers.
 */
function sortByRecency(rows: { id: string; updatedAt: string }[]): { id: string; updatedAt: string }[] {
  return [...rows]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .map((c) => ({ id: c.id, updatedAt: c.updatedAt }))
}
