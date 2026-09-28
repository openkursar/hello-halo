/**
 * The title a conversation takes from its first user message.
 *
 * Lives in `shared/` because the main process persists this title while the
 * renderer shows it the moment the message is sent, before any round-trip;
 * two copies of the rule would let the sidebar flip to a different title once
 * the backend's version arrives.
 */

import { attachedPathName, splitAttachedPaths } from './attached-paths'

const MAX_TITLE_LENGTH = 50

/**
 * Returns null when the message has no text (e.g. image-only), so the caller
 * keeps the existing title instead of blanking it. Attached paths are not the
 * topic; a message of only attachments is titled by their names.
 */
export function titleFromFirstMessage(content: string): string | null {
  const { text: body, paths } = splitAttachedPaths(content)
  const text = (body.trim() ? body : paths.map(p => attachedPathName(p.path)).join(', '))
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return null

  // Count code points so an emoji or astral character is never cut in half.
  const chars = Array.from(text)
  return chars.length > MAX_TITLE_LENGTH
    ? chars.slice(0, MAX_TITLE_LENGTH).join('') + '...'
    : text
}
