/**
 * Classification of messages that entered a conversation from another
 * conversation in the same space.
 *
 * A delivered message is persisted as `role: 'system'` — never `'user'` — so the
 * model cannot read a peer conversation as its owner speaking. The renderer must
 * make the same distinction visible; these predicates are the single place that
 * decides which rendering family a message belongs to.
 */

import type { Message } from '../../../types'

/** Provenance carried by a delivered message. */
export interface CrossConversationProvenance {
  /** Source conversation id — also the reply target. */
  fromConversationId: string
  /** Title snapshot taken at delivery time; used when the source no longer resolves. */
  fromConversationTitle: string
  /** One-line summary written by the sending AI. */
  summary: string
}

export function isCrossConversationMessage(message: Message): boolean {
  return message.role === 'system' && message.source === 'cross-conversation'
}

export function isCrossConversationNotice(message: Message): boolean {
  return message.role === 'system' && message.source === 'cross-conversation-notice'
}

/**
 * Read provenance off a delivered message. Returns null when the metadata is
 * unusable, which lets callers fall back to a plain system line rather than
 * rendering a source bar that links nowhere.
 */
export function readProvenance(message: Message): CrossConversationProvenance | null {
  const meta = message.metadata
  if (!meta?.fromConversationId) return null
  return {
    fromConversationId: meta.fromConversationId,
    fromConversationTitle: meta.fromConversationTitle || '',
    summary: meta.summary || '',
  }
}
