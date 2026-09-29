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

import { isShortConversationId, normalizeConversationTarget } from '../../../shared/conversation-reference'
import { withheldReason } from './admission'
import { getReadableSources, listSourceConversations, sourceOfConversation } from './source'

export type ResolveTargetResult =
  | { ok: true; conversationId: string }
  | { ok: false; reason: 'not_found' }
  /** The only conversation with this exact title is the caller's own. */
  | { ok: false; reason: 'self_target_title' }
  /** More than one OTHER conversation in this space has this exact title. */
  | { ok: false; reason: 'ambiguous_title'; candidates: { id: string; updatedAt: string }[] }
  /** More than one conversation's short handle equals this short id. */
  | { ok: false; reason: 'ambiguous_short_id'; candidates: { id: string; updatedAt: string }[] }
  /**
   * The handle names a conversation that exists but is withheld from other
   * conversations (e.g. a digital human with collaboration off, a finished run).
   * `detail` is the owning source's model-facing reason.
   */
  | { ok: false; reason: 'unavailable'; conversationId: string; title?: string; detail: string }

/**
 * Resolves across every registered source: a title or short handle that two
 * sources' conversations share is ambiguous, exactly as two of one source's.
 *
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
  const byId = sourceOfConversation(cleaned)?.getMeta(spaceId, cleaned)
  if (byId) {
    const withheld = withheldReason(byId)
    return withheld
      ? { ok: false, reason: 'unavailable', conversationId: cleaned, title: byId.title, detail: withheld }
      : { ok: true, conversationId: cleaned }
  }

  const all = listAll(spaceId)
  const reachable = all.filter((c) => !withheldReason(c))

  // Short id next: it is still an id, so like a full id it does NOT exclude
  // the caller — `self_target` downstream owns that rejection, and having one
  // place decide it keeps the two from disagreeing. A short id that matches
  // nothing falls through to title matching rather than failing here, so a
  // conversation genuinely titled something hex-shaped stays reachable.
  const shortId = isShortConversationId(cleaned)
  const prefix = cleaned.toLowerCase()
  if (shortId) {
    const idMatches = reachable.filter((c) => c.shortRef === prefix)
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
  const titleMatches = (rows: Listed[]): Listed[] => rows.filter((c) => c.title.trim().toLowerCase() === normalized)
  // Computed BEFORE excluding self: the exclusion below must only ever drop
  // the caller's own row out of an already-known set of matches, never
  // change whether "this title has any match at all" — otherwise the only
  // title match being the caller itself is indistinguishable from there
  // being no match, and `not_found` becomes a lie for a conversation the
  // caller is looking straight at.
  const allTitleMatches = titleMatches(reachable)
  const candidates = allTitleMatches.filter((c) => c.id !== callerConversationId)

  if (candidates.length === 0) {
    // Excluding self emptied a non-empty set — the one match WAS self.
    if (allTitleMatches.length > 0) return { ok: false, reason: 'self_target_title' }
    return explainWithheldMatch(all, shortId ? prefix : null, titleMatches) ?? { ok: false, reason: 'not_found' }
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
 * Nothing reachable matched: say why if the handle names a withheld
 * conversation, by short id first, then exact title. Only consulted after a
 * miss, so a reachable conversation always wins a shared handle.
 */
function explainWithheldMatch(
  all: Listed[],
  shortPrefix: string | null,
  titleMatches: (rows: Listed[]) => Listed[]
): ResolveTargetResult | null {
  const withheld = all.filter((c) => withheldReason(c))
  const match = (shortPrefix ? withheld.find((c) => c.shortRef === shortPrefix) : undefined) ?? titleMatches(withheld)[0]
  const detail = match ? withheldReason(match) : null
  return match && detail ? { ok: false, reason: 'unavailable', conversationId: match.id, title: match.title, detail } : null
}

interface Listed {
  id: string
  title: string
  updatedAt: string
  shortRef: string
  unavailable?: string
}

/** Every conversation the sources own in the space, withheld ones included, with its short handle. */
function listAll(spaceId: string): Listed[] {
  return getReadableSources().flatMap((source) =>
    listSourceConversations(source, spaceId).map((c) => ({
      id: c.id,
      title: c.title,
      updatedAt: c.updatedAt,
      shortRef: source.shortRef(c.id),
      ...(c.unavailable ? { unavailable: c.unavailable } : {}),
    }))
  )
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
