/**
 * The textual form a conversation reference takes inside a message.
 *
 * The composer inserts this form directly, so what the user sees, what gets
 * persisted, and what the model reads are all the same string — no rewrite on
 * send, no annotation the transcript does not contain. That matters twice
 * over: a later reader of this conversation (another conversation calling
 * `conversation_read`) sees the same pointer the model saw, rather than a bare
 * title it would have to guess at all over again.
 *
 * Shape: `[#Title](conv:3a5d77ea)` — a markdown link, so a model reads it as a
 * reference without being told, and a renderer can decorate it without parsing
 * anything bespoke.
 *
 * The id is truncated to `SHORT_ID_LENGTH` for the same reason git shows short
 * SHAs: the full UUID is longer than most titles and the composer is a plain
 * textarea, so the untruncated form buries the sentence it sits in. A prefix
 * that matches more than one conversation is reported as ambiguous with the
 * full ids, never resolved by guessing.
 *
 * Lives in `shared/` because the composer writes this form and the main
 * process reads it; a second copy of the format on either side is a fork
 * waiting to drift.
 */

export const CONVERSATION_REFERENCE_SCHEME = 'conv'

/** Hex characters of the conversation UUID kept in a reference. */
export const SHORT_ID_LENGTH = 8

export function shortConversationId(conversationId: string): string {
  return conversationId.replace(/-/g, '').slice(0, SHORT_ID_LENGTH)
}

/** The exact text the composer inserts when a conversation is picked. */
export function formatConversationReference(title: string, conversationId: string): string {
  return `[#${title}](${CONVERSATION_REFERENCE_SCHEME}:${shortConversationId(conversationId)})`
}

/**
 * Strip the `conv:` scheme a model may have copied along with the id. Passing
 * the id bare is the documented shape, but copying the reference verbatim is
 * the obvious mistake to make, and failing on it would be a lookup error that
 * tells the caller nothing about what it did wrong.
 */
export function normalizeConversationTarget(target: string): string {
  const trimmed = target.trim()
  const prefix = `${CONVERSATION_REFERENCE_SCHEME}:`
  return trimmed.toLowerCase().startsWith(prefix) ? trimmed.slice(prefix.length).trim() : trimmed
}

/** True if `target` looks like a short id rather than a full id or a title. */
export function isShortConversationId(target: string): boolean {
  return new RegExp(`^[0-9a-f]{${SHORT_ID_LENGTH}}$`, 'i').test(target)
}
