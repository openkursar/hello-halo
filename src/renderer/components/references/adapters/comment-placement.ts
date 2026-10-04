/**
 * Where a comment card goes in a diff: under the lines it comments on; in the
 * unified layout, a card on deleted lines right after their widget; and, side
 * by side, where its hidden twin goes on the other side so both sides stay
 * aligned (the merge view lines them up only where unchanged text starts).
 *
 * Pure: it works on chunk positions and documents, so it is checked without
 * an editor.
 */

import type { Text } from '@codemirror/state'

/** A diff chunk as @codemirror/merge reports it: `to` is one past its last line, or `from` when it has none. */
export interface ChunkRange {
  fromA: number
  toA: number
  fromB: number
  toB: number
}

/** A block position: after the line ending at `pos`, or (`before`) ahead of the line holding `pos`. */
export interface CardAnchor {
  pos: number
  before: boolean
}

function clampLine(doc: Text, line: number): number {
  return Math.max(1, Math.min(line, doc.lines))
}

/** After line `line` of `doc`. */
export function afterLine(doc: Text, line: number): CardAnchor {
  return { pos: doc.line(clampLine(doc, line)).to, before: false }
}

/** The chunk whose lines on its side hold `pos`, or null when `pos` is unchanged text. */
function chunkHolding(chunks: readonly ChunkRange[], pos: number, inA: boolean): ChunkRange | null {
  for (const chunk of chunks) {
    const from = inA ? chunk.fromA : chunk.fromB
    const to = inA ? chunk.toA : chunk.toB
    if (pos < from) return null
    if (pos < to) return chunk
  }
  return null
}

/** `pos` in unchanged text of side A (`fromA`) or B, carried to the other side. */
export function mapUnchanged(pos: number, chunks: readonly ChunkRange[], fromA: boolean): number {
  let ours = 0
  let theirs = 0
  for (const chunk of chunks) {
    if ((fromA ? chunk.fromA : chunk.fromB) > pos) break
    ours = fromA ? chunk.toA : chunk.toB
    theirs = fromA ? chunk.toB : chunk.toA
  }
  return theirs + (pos - ours)
}

function clampPos(doc: Text, pos: number): number {
  return Math.max(0, Math.min(pos, doc.length))
}

/**
 * Side by side: where the twin of a card goes in `own`, for a card after line
 * `line` of `other` (side A when `otherIsA`). In a chunk, at the end of the
 * same chunk on this side — after the line before it when it has no lines
 * here; in unchanged text, after the matching line.
 *
 * Never ahead of the line after a chunk: the merge view sizes its spacer from
 * the top of that line's block, widgets ahead of it included, so a twin there
 * would be counted twice. A chunk that opens the document with no lines here
 * therefore gets no twin (null): the spacer covers the card.
 */
export function twinAnchor(own: Text, other: Text, chunks: readonly ChunkRange[], line: number, otherIsA: boolean): CardAnchor | null {
  const pos = other.line(clampLine(other, line)).from
  const chunk = chunkHolding(chunks, pos, otherIsA)
  if (chunk) {
    const from = otherIsA ? chunk.fromB : chunk.fromA
    const to = otherIsA ? chunk.toB : chunk.toA
    if (to > from) return { pos: own.lineAt(clampPos(own, to - 1)).to, before: false }
    if (from > 0) return { pos: own.lineAt(clampPos(own, from - 1)).to, before: false }
    return null
  }
  return { pos: own.lineAt(clampPos(own, mapUnchanged(pos, chunks, otherIsA))).to, before: false }
}

/**
 * Unified layout: where a card on line `line` of the original (before) text
 * goes in the shown (after) text. Deleted lines are a widget ahead of their
 * chunk's position, and the card follows it; unchanged lines map across.
 */
export function beforeSideAnchor(after: Text, before: Text, chunks: readonly ChunkRange[], line: number): CardAnchor {
  const pos = before.line(clampLine(before, line)).from
  const chunk = chunkHolding(chunks, pos, true)
  if (chunk) return { pos: clampPos(after, chunk.fromB), before: true }
  return { pos: after.lineAt(clampPos(after, mapUnchanged(pos, chunks, true))).to, before: false }
}

/** The after-text lines a range of the original text shows at, for keeping them unfolded. */
export function beforeSideLines(after: Text, before: Text, chunks: readonly ChunkRange[], startLine: number, endLine: number): { startLine: number; endLine: number } {
  const at = (line: number) => {
    const anchor = beforeSideAnchor(after, before, chunks, line)
    return after.lineAt(anchor.pos).number
  }
  const start = at(startLine)
  return { startLine: start, endLine: Math.max(start, at(endLine)) }
}
