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

/** A web address in running text: it ends at whitespace, quotes, angle brackets or CJK punctuation. */
const URL_IN_TEXT = /https?:\/\/[^\s<>"'，。！？；：、（）【】《》「」]+/gi

/** Punctuation that ends the sentence rather than the address. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/

/**
 * A web address as its site and the last part of its path —
 * "github.com › hello-halo" — so a conversation opened with a pasted link can
 * be told apart in the list. Anything that does not parse is left as it was.
 */
function shortenUrl(raw: string): string {
  const trailing = raw.match(TRAILING_PUNCTUATION)?.[0] ?? ''
  let url: URL
  try {
    url = new URL(raw.slice(0, raw.length - trailing.length))
  } catch {
    return raw
  }
  const site = url.hostname.replace(/^www\./i, '')
  if (!site) return raw
  const segment = url.pathname.split('/').filter(Boolean).pop()
  if (!segment) return site + trailing
  let name = segment
  try {
    name = decodeURIComponent(segment)
  } catch {
    // Malformed escapes: show the segment as written.
  }
  return `${site} › ${name}${trailing}`
}

/**
 * The conversation list's preview of a message, by the same rule as the
 * title; undefined when the message names nothing.
 */
export function previewFromMessage(content: string, references?: readonly ContentReference[]): string | undefined {
  const text = messageSummaryText(content, references)
  if (!text) return undefined
  return text.length > PREVIEW_LENGTH ? truncateChars(text, PREVIEW_LENGTH) + '...' : text
}

/**
 * Returns null when the message names nothing (e.g. image-only), so the caller
 * keeps the existing title instead of blanking it. Attached paths and other
 * references are not the topic; a message of references alone is titled by
 * them (see `messageSummaryText`). Web addresses are shortened (`shortenUrl`).
 */
export function titleFromFirstMessage(content: string, references?: readonly ContentReference[]): string | null {
  const text = messageSummaryText(content, references)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(URL_IN_TEXT, shortenUrl)
  if (!text) return null

  // Count code points so an emoji or astral character is never cut in half.
  const chars = Array.from(text)
  return chars.length > MAX_TITLE_LENGTH
    ? chars.slice(0, MAX_TITLE_LENGTH).join('') + '...'
    : text
}
