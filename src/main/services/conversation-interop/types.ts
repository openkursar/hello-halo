/**
 * Cross-Conversation Interop — shared types.
 *
 * A conversation belongs to a registered `ConversationSource` (see
 * `source.ts`): the space's own conversations, plus whatever an upper tier
 * registers. Team epochs are out of scope and never reach this module.
 */

export interface ConversationSummary {
  id: string
  title: string
  updatedAt: string
  messageCount: number
  running: boolean
  /** Qualifier from the owning source (e.g. "digital human"); absent for the space's own conversations. */
  label?: string
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
  /** The message's stable id in its own transcript, when the source has one. */
  id?: string
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
  label?: string
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
  /** The conversation exists but other conversations may not read it; `detail` is the model-facing reason. */
  | { ok: false; reason: 'unavailable'; detail: string }

export type DeliveryStatus = 'delivered' | 'queued'

export type DeliverFailureReason =
  | 'not_found'
  | 'self_target'
  | 'unreachable'
  /** The target's source does not accept deliveries from other conversations. */
  | 'read_only'
  /** The target exists but may not be messaged right now (e.g. a digital human with collaboration off). */
  | 'unavailable'
  | 'circuit_open'
  /** The message would extend a chain of conversation-to-conversation replies past the depth limit. */
  | 'chain_too_deep'
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
  /** `detail` is the model-facing reason for `read_only` and `unavailable`. */
  | { ok: false; reason: DeliverFailureReason; detail?: string }

export type WaitOutcome =
  | { status: 'replied'; message: string }
  | { status: 'no_reply' }
  | { status: 'timeout' }
  /** The message never reached the target (e.g. it was refused when its queued turn came up). */
  | { status: 'undelivered'; reason: string }

export type WaitFailureReason = DeliverFailureReason | 'mutual_wait'

export type WaitResult =
  | { ok: true; outcome: WaitOutcome }
  /** Same as `DeliverResult`'s `resolved_pending_wait` — this call's OWN `waitForReply` is denied ("hit means pure reply"); no new wait was registered. */
  | { ok: true; status: 'resolved_pending_wait' }
  | { ok: false; reason: WaitFailureReason; detail?: string }
