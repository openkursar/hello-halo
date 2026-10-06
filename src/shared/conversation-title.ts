/**
 * The title a conversation takes from its first user message.
 *
 * Lives in `shared/` because the main process persists this title while the
 * renderer shows it the moment the message is sent, before any round-trip;
 * two copies of the rule would let the sidebar flip to a different title once
 * the backend's version arrives.
 */

import { messageSummaryText, truncateChars } from './content-reference'
import type { ContentReference } from './types/content-reference'

const MAX_TITLE_LENGTH = 50
const PREVIEW_LENGTH = 50

/**
 * The conversation list's preview of a message, by the same rule as the
 * title; undefined when the message names nothing.
 */
export function previewFromMessage(content: string, references?: readonly ContentReference[]): string | undefined {
  const text = messageSummaryText(content, references)
  if (!text) return undefined
  return text.length > PREVIEW_LENGTH ? truncateChars(text, PREVIEW_LENGTH) + '...' : text
}

interface PreviewSource {
  content: string
  metadata?: { references?: readonly ContentReference[] }
}

/**
 * The conversation list's line: the preview of the latest message that names
 * something, so a reply that carries no text does not blank it. Undefined for
 * a conversation without messages, empty when none names anything.
 */
export function previewFromMessages(messages: readonly PreviewSource[]): string | undefined {
  if (messages.length === 0) return undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const preview = previewFromMessage(messages[i].content, messages[i].metadata?.references)
    if (preview) return preview
  }
  return ''
}

/**
 * Returns null when the message names nothing (e.g. image-only), so the caller
 * keeps the existing title instead of blanking it. Attached paths and other
 * references are not the topic; a message of references alone is titled by
 * them (see `messageSummaryText`).
 */
export function titleFromFirstMessage(content: string, references?: readonly ContentReference[]): string | null {
  const text = messageSummaryText(content, references).replace(/\s+/g, ' ').trim()
  if (!text) return null

  // Count code points so an emoji or astral character is never cut in half.
  const chars = Array.from(text)
  return chars.length > MAX_TITLE_LENGTH
    ? chars.slice(0, MAX_TITLE_LENGTH).join('') + '...'
    : text
}
