/**
 * apps/runtime -- Surrogate-safe text truncation
 *
 * Shared helper for length-capping user- and AI-generated text (IM messages,
 * replies, previews) before it is injected into a model request, sent to an IM
 * platform, or stored for display.
 */

/**
 * Truncate `text` to at most `maxUnits` UTF-16 code units without splitting a
 * surrogate pair.
 *
 * Plain `text.slice(0, n)` cuts on UTF-16 code units, so a boundary that lands
 * inside an astral character (any emoji, e.g. 🥉 = U+1F949 → surrogate pair
 * D83E DD49) keeps only the high surrogate. A lone surrogate is invalid UTF-16:
 * once the string is JSON-serialized into a model API request body the provider
 * rejects the whole request with `400 invalid_request_error: no low surrogate in
 * string`, which fails the run with no partial output. Dropping the dangling
 * high surrogate keeps the result well-formed while preserving the length cap.
 */
export function truncateUtf16Safe(text: string, maxUnits: number): string {
  if (maxUnits <= 0) return ''
  if (text.length <= maxUnits) return text

  // The last retained code unit sits at index maxUnits - 1. If it is a high
  // surrogate (U+D800–U+DBFF), its matching low surrogate was at index maxUnits
  // and got cut off, so drop the now-orphaned high surrogate.
  let end = maxUnits
  const lastUnit = text.charCodeAt(end - 1)
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) end -= 1

  return text.slice(0, end)
}
