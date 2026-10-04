/**
 * Finding a referenced place again after the content may have changed.
 *
 * A reference stores its lines and the text as it was. Going back checks the
 * text is still at those lines; if not, it looks for the text nearest to them
 * ("moved"); if it is gone, it says so ("lost") and keeps the original lines
 * rather than silently pointing somewhere else.
 */

import type { ReferenceLineRange } from '../../../shared/types/content-reference'

export type RevealOutcome = 'exact' | 'moved' | 'lost'

/** 1-based line access over any document (a CodeMirror Text, a split string). */
export interface LineSource {
  readonly lines: number
  line(n: number): string
}

export function lineSourceOf(text: string): LineSource {
  const lines = text.split('\n')
  return { lines: lines.length, line: n => lines[n - 1] ?? '' }
}

/** Quote lines compared when checking a location: enough to be specific, few enough to stay cheap. */
const PROBE_LINES = 3

interface ProbeLine {
  /** Line offset from the quote's first line. */
  offset: number
  text: string
}

function quoteProbe(quote: string | undefined): ProbeLine[] {
  if (!quote) return []
  const probe: ProbeLine[] = []
  const lines = quote.split('\n')
  for (let offset = 0; offset < lines.length && probe.length < PROBE_LINES; offset++) {
    const text = lines[offset].trim()
    if (text) probe.push({ offset, text })
  }
  return probe
}

function matchesAt(doc: LineSource, startLine: number, probe: ProbeLine[]): boolean {
  for (const { offset, text } of probe) {
    const n = startLine + offset
    if (n > doc.lines || !doc.line(n).includes(text)) return false
  }
  return true
}

/**
 * Where `range` is now in `doc`, judged by `quote` (the text as it was).
 * Keeps the range's length; the nearest match wins, earlier lines first on a tie.
 */
export function relocateLines(
  doc: LineSource,
  range: ReferenceLineRange,
  quote?: string,
): { range: ReferenceLineRange; outcome: RevealOutcome } {
  const span = Math.max(0, range.endLine - range.startLine)
  const at = (start: number): ReferenceLineRange => {
    const startLine = Math.min(Math.max(1, start), Math.max(1, doc.lines))
    return { startLine, endLine: Math.min(Math.max(1, doc.lines), startLine + span) }
  }

  const probe = quoteProbe(quote)
  if (probe.length === 0) {
    return { range: at(range.startLine), outcome: range.startLine <= doc.lines ? 'exact' : 'lost' }
  }
  if (matchesAt(doc, range.startLine, probe)) return { range: at(range.startLine), outcome: 'exact' }
  for (let distance = 1; distance < doc.lines + range.startLine; distance++) {
    const before = range.startLine - distance
    const after = range.startLine + distance
    if (before < 1 && after > doc.lines) break
    if (before >= 1 && matchesAt(doc, before, probe)) return { range: at(before), outcome: 'moved' }
    if (after <= doc.lines && matchesAt(doc, after, probe)) return { range: at(after), outcome: 'moved' }
  }
  return { range: at(range.startLine), outcome: 'lost' }
}

// ============================================
// Rendered text against its source
// ============================================

/**
 * Characters ignored when matching rendered text to Markdown source:
 * whitespace (layout differs) and the syntax that rendering removes (list
 * markers included). Both sides drop them, so text containing them still
 * matches.
 */
const MARKUP = /[\s*_`#>~|[\]\-+!\\<]/
const MARKUP_ALL = new RegExp(MARKUP.source, 'g')
const WHITESPACE = /\s/
const WHITESPACE_ALL = /\s+/g

/**
 * Lengths of the anchor compared at each end, longest first: a long anchor is
 * specific, a shorter one survives a link target or other markup that sits
 * inside the passage near its end.
 */
const ANCHOR_LENGTHS = [24, 16, 10]

/**
 * For kept-character indices (ascending) of `text` with `dropped` characters
 * removed: each one's offset in `text` and its 1-based line. One pass, no
 * per-character arrays — the source can be a multi-megabyte document.
 */
function locateKept(text: string, dropped: RegExp, indices: number[]): Array<{ offset: number; line: number }> {
  const found: Array<{ offset: number; line: number }> = []
  let kept = 0
  let line = 1
  let next = 0
  for (let i = 0; i < text.length && next < indices.length; i++) {
    const ch = text[i]
    if (!dropped.test(ch)) {
      while (next < indices.length && indices[next] === kept) {
        found.push({ offset: i, line })
        next++
      }
      kept++
    }
    if (ch === '\n') line++
  }
  return found
}

/**
 * Approximate source lines of a passage selected in rendered Markdown. Each
 * end is matched on a short anchor, so a link or a list marker in the middle
 * of the passage does not defeat it. Undefined when the passage is not found.
 */
export function approximateLines(sourceText: string, quote: string): ReferenceLineRange | undefined {
  const needle = quote.replace(MARKUP_ALL, '')
  if (!needle) return undefined
  const source = sourceText.replace(MARKUP_ALL, '')

  let start = -1
  let headLength = 0
  for (const length of ANCHOR_LENGTHS) {
    headLength = Math.min(length, needle.length)
    start = source.indexOf(needle.slice(0, headLength))
    if (start >= 0 || length >= needle.length) break
  }
  if (start < 0) return undefined

  let end = start + headLength - 1
  for (const length of ANCHOR_LENGTHS) {
    const tail = needle.slice(-Math.min(length, needle.length))
    const tailAt = source.indexOf(tail, start)
    if (tailAt >= 0) {
      end = tailAt + tail.length - 1
      break
    }
  }
  const [first, last] = locateKept(sourceText, MARKUP, start === end ? [start] : [start, end])
  return { startLine: first.line, endLine: (last ?? first).line }
}

/**
 * Offsets of `needle` in `text` ignoring whitespace on both sides — a
 * selection's text breaks lines where the page's text nodes do not. Returns
 * [start, end) in `text`, or null.
 */
export function looseIndexOf(text: string, needle: string): [number, number] | null {
  const want = needle.replace(WHITESPACE_ALL, '')
  if (!want) return null
  const at = text.replace(WHITESPACE_ALL, '').indexOf(want)
  if (at < 0) return null
  const lastIndex = at + want.length - 1
  const [first, last] = locateKept(text, WHITESPACE, lastIndex === at ? [at] : [at, lastIndex])
  return [first.offset, (last ?? first).offset + 1]
}
