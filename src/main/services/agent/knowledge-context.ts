/**
 * Knowledge context — resolves a conversation's knowledge-base set into the
 * KBReference list injected into the system prompt.
 *
 * Shared by the two session-creation entry points (ensureSessionWarm and
 * sendMessage) so a warmed session and the first real turn build the SAME
 * Knowledge section. They must match: the session's system prompt is frozen at
 * creation, and getOrCreateV2Session reuses a warm session whose credentials
 * fingerprint is unchanged — so a warm session built without knowledge would be
 * reused as-is and the KB would never reach the model.
 *
 * Resolution gates at use time (getKBReferenceById): a KB id whose KB is paused
 * or lacks an index resolves to nothing, so a stale/empty id is simply skipped.
 */

import { getKBReferenceById, isKBIndexReady } from '../tlon'
import type { KBReference } from '../../../shared/types/tlon'

/**
 * Cheap per-message variant for the session knowledge fingerprint: the ids
 * that WOULD resolve (registry status + index presence, no content read).
 * The full resolution below reads each KB's index.md and is deferred to
 * actual session creation, where its output is not thrown away.
 */
export function resolveConversationKnowledgeBaseIds(
  conversation: { id?: string; knowledgeBaseIds?: string[] } | null | undefined
): string[] {
  return (conversation?.knowledgeBaseIds ?? []).filter(isKBIndexReady)
}

/** Resolve a conversation's persisted knowledgeBaseIds into injectable references. */
export function resolveConversationKnowledgeBases(
  conversation: { id?: string; knowledgeBaseIds?: string[] } | null | undefined
): KBReference[] {
  const requested = conversation?.knowledgeBaseIds ?? []
  const refs: KBReference[] = []
  for (const kbId of requested) {
    const ref = getKBReferenceById(kbId)
    if (ref) refs.push(ref)
  }
  if (requested.length > 0) {
    console.log(
      `[Agent][KB] conv=${conversation?.id ?? '?'} resolved ${refs.length}/${requested.length} ` +
      `knowledge base(s) into system prompt: [${refs.map(r => r.name).join(', ')}]`
    )
  }
  return refs
}
