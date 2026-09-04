/**
 * Cross-Conversation Interop — shared types.
 *
 * Native conversations only: a digital human's app-chat session and a
 * team epoch are out of scope and never reach this module.
 */

export interface ConversationSummary {
  id: string
  title: string
  updatedAt: string
  messageCount: number
  running: boolean
}

export interface ConversationListPage {
  items: ConversationSummary[]
  total: number
  /** Present when more items exist beyond this page. */
  nextCursor?: string
}

export type ListConversationsResult =
  | { ok: true; page: ConversationListPage }
  | { ok: false; reason: 'invalid_cursor' }

export interface TranscriptLine {
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
  /** How the line entered the conversation, e.g. 'cross-conversation'. */
  source?: string
}

export interface ConversationReadPage {
  id: string
  title: string
  running: boolean
  updatedAt: string
  /** Oldest-first, matching how a transcript reads top to bottom. */
  lines: TranscriptLine[]
  totalMessages: number
  /** How many earlier messages exist before this page (0 = nothing withheld). */
  hiddenBefore: number
  /** Present when earlier messages exist; pass back to read the segment before this one. */
  nextCursor?: string
}

export type ReadConversationResult =
  | { ok: true; page: ConversationReadPage }
  | { ok: false; reason: 'not_found' | 'invalid_cursor' }

export type DeliveryStatus = 'delivered' | 'queued'

export type DeliverFailureReason =
  | 'not_found'
  | 'self_target'
  | 'unreachable'
  | 'circuit_open'
  | 'too_large'
  | 'queue_full'

export type DeliverResult =
  /** Dispatched now — the real, persisted message id (never a synthesized placeholder). */
  | { ok: true; status: 'delivered'; messageId: string }
  /** Queued behind the target's current turn — no message exists yet, so there is no id to report. */
  | { ok: true; status: 'queued' }
  /**
   * This send matched an existing `pending-wait` someone else has on THIS
   * conversation — it was consumed to resolve that wait, not persisted or
   * queued as a new delivery. Checked and exempted from the circuit breaker
   * BEFORE any of the failure reasons above can apply.
   */
  | { ok: true; status: 'resolved_pending_wait' }
  | { ok: false; reason: DeliverFailureReason }

export type WaitOutcome =
  | { status: 'replied'; message: string }
  | { status: 'no_reply' }
  | { status: 'timeout' }

export type WaitFailureReason = DeliverFailureReason | 'mutual_wait'

export type WaitResult =
  | { ok: true; outcome: WaitOutcome }
  /** Same as `DeliverResult`'s `resolved_pending_wait` — this call's OWN `waitForReply` is denied ("hit means pure reply"); no new wait was registered. */
  | { ok: true; status: 'resolved_pending_wait' }
  | { ok: false; reason: WaitFailureReason }
