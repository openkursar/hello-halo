/**
 * Cross-Conversation Interop — admission.
 *
 * Whether another conversation's AI may read or message a conversation is
 * decided here and nowhere else. A source only reports facts: what it owns, what
 * kind of conversations they are (`capabilities`, `whyNotWritable`), and why one
 * of them is unavailable right now (`SourceConversation.unavailable`).
 *
 * Only AI-driven access asks: listing, resolving a target, reading, delivering
 * (on arrival, when it queues, and when the queue hands it over). A user's own
 * features — global search, opening a chat — read the source directly and are
 * not subject to this.
 */

import type { ConversationSource, SourceConversation } from './source'

export type Admission =
  | { ok: true }
  | { ok: false; reason: 'unavailable' | 'read_only'; detail: string }

/** A delivery refused after it was accepted (it waited in a queue and the target changed meanwhile). */
export class AdmissionRefusal extends Error {
  constructor(readonly reason: 'unavailable' | 'read_only', readonly detail: string) {
    super(detail)
    this.name = 'AdmissionRefusal'
  }
}

const NOT_READABLE = 'it cannot be read by other conversations'
const NOT_WRITABLE = 'it takes no messages from other conversations'

/**
 * Why another conversation's AI may not take part in this conversation, or null
 * when it may. Resolving a reference and checking the caller's own standing ask
 * this; reads and sends go through `admitRead` / `admitSend`, which build on it.
 */
export function withheldReason(meta: Pick<SourceConversation, 'unavailable'>): string | null {
  return meta.unavailable ?? null
}

export function admitRead(source: ConversationSource, meta: SourceConversation): Admission {
  const withheld = withheldReason(meta)
  if (withheld) return { ok: false, reason: 'unavailable', detail: withheld }
  if (!source.capabilities.readable) return { ok: false, reason: 'unavailable', detail: NOT_READABLE }
  return { ok: true }
}

/**
 * `answersWait`: the send resolves a wait its recipient is blocked in. A sender
 * that takes no messages can still be answered there; a conversation that is
 * unavailable cannot, whatever the kind.
 */
export function admitSend(source: ConversationSource, meta: SourceConversation, answersWait: boolean): Admission {
  const withheld = withheldReason(meta)
  if (withheld) return { ok: false, reason: 'unavailable', detail: withheld }
  if (!source.capabilities.writable && !answersWait) {
    return { ok: false, reason: 'read_only', detail: source.whyNotWritable ?? NOT_WRITABLE }
  }
  return { ok: true }
}
