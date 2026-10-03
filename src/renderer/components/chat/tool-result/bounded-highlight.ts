/**
 * Syntax highlighting with a size budget for expanded tool output.
 *
 * highlight.js runs synchronously over its whole input, so a 200 KB output
 * becomes one long task on expand. Only the head is highlighted; the rest is
 * shown as escaped plain text.
 */

import { useMemo } from 'react'
import { escapeHtml, useAsyncHighlight } from '../../../hooks/useAsyncHighlight'

export const HIGHLIGHT_MAX_CHARS = 50_000

/** Head ends on a line boundary so no token is split across the seam. */
export function splitForHighlight(code: string, maxChars: number): { head: string; tail: string } {
  if (code.length <= maxChars) return { head: code, tail: '' }
  const lineEnd = code.lastIndexOf('\n', maxChars)
  const cut = lineEnd > 0 ? lineEnd : maxChars
  return { head: code.slice(0, cut), tail: code.slice(cut) }
}

export function useBoundedHighlight(code: string, language?: string): string {
  const { head, tail } = useMemo(() => splitForHighlight(code, HIGHLIGHT_MAX_CHARS), [code])
  const highlightedHead = useAsyncHighlight(head, language)
  const escapedTail = useMemo(() => (tail ? escapeHtml(tail) : ''), [tail])
  return escapedTail ? highlightedHead + escapedTail : highlightedHead
}
