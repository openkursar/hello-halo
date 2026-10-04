/**
 * Where comment cards go in a diff: under the lines they comment on; side by
 * side, a hidden twin on the other side at the matching place (the end of the
 * same chunk there, after the line before it when the chunk has no lines
 * there, or after the matching unchanged line); in the unified layout, a card
 * on deleted lines right after their widget.
 */

import { describe, expect, it } from 'vitest'
import { Text } from '@codemirror/state'
import {
  afterLine,
  beforeSideAnchor,
  beforeSideLines,
  mapUnchanged,
  twinAnchor,
  type ChunkRange,
} from '../../../../src/renderer/components/references/adapters/comment-placement'

const doc = (...lines: string[]) => Text.of(lines)
/** The line `pos` falls on, and whether the card sits ahead of it. */
const at = (text: Text, anchor: { pos: number; before: boolean }) => ({ line: text.lineAt(anchor.pos).number, before: anchor.before })

describe('side by side', () => {
  // "NEW" inserted after line 2.
  const a = doc('one', 'two', 'three', 'four', 'five', 'six')
  const b = doc('one', 'two', 'NEW', 'three', 'four', 'five', 'six')
  const inserted: ChunkRange[] = [{ fromA: a.line(3).from, toA: a.line(3).from, fromB: b.line(3).from, toB: b.line(4).from }]

  it('maps unchanged lines across by the lines chunks added or removed', () => {
    expect(mapUnchanged(a.line(5).from, inserted, true)).toBe(b.line(6).from)
    expect(mapUnchanged(b.line(6).from, inserted, false)).toBe(a.line(5).from)
    expect(mapUnchanged(a.line(1).from, inserted, true)).toBe(b.line(1).from)
  })

  it('puts the twin of a card on unchanged lines after the matching line', () => {
    expect(at(b, twinAnchor(b, a, inserted, 5, true)!)).toEqual({ line: 6, before: false })
    expect(at(a, twinAnchor(a, b, inserted, 6, false)!)).toEqual({ line: 5, before: false })
  })

  // The merge view sizes a chunk's spacer from the top of the line after it, so a twin always
  // belongs to a line block above that one.
  it('puts the twin of a card in a chunk with no lines on this side after the line before the chunk', () => {
    expect(at(a, twinAnchor(a, b, inserted, 3, false)!)).toEqual({ line: 2, before: false })
  })

  it('puts the twin of a card in a changed chunk at the end of that chunk on this side', () => {
    const before = doc('one', 'two', 'old three', 'four')
    const after = doc('one', 'two', 'new three', 'extra', 'four')
    const changed: ChunkRange[] = [{ fromA: before.line(3).from, toA: before.line(4).from, fromB: after.line(3).from, toB: after.line(5).from }]
    expect(at(before, twinAnchor(before, after, changed, 4, false)!)).toEqual({ line: 3, before: false })
    expect(at(after, twinAnchor(after, before, changed, 3, true)!)).toEqual({ line: 4, before: false })
  })

  it('puts the twin after the last line here when the chunk runs to the end of the text', () => {
    const before = doc('one', 'old two')
    const after = doc('one', 'new two', 'new three')
    // `to` is one past the end of the text when the chunk ends with it.
    const closing: ChunkRange[] = [{ fromA: before.line(2).from, toA: before.length + 1, fromB: after.line(2).from, toB: after.length + 1 }]
    expect(at(before, twinAnchor(before, after, closing, 3, false)!)).toEqual({ line: 2, before: false })
  })

  it('leaves no twin when the chunk opens the document with no lines here: the spacer covers the card', () => {
    const before = doc('x', 'y')
    const after = doc('new', 'x', 'y')
    const opening: ChunkRange[] = [{ fromA: 0, toA: 0, fromB: 0, toB: after.line(2).from }]
    expect(twinAnchor(before, after, opening, 1, false)).toBeNull()
  })
})

describe('unified', () => {
  // Lines "gone1" and "gone2" deleted.
  const original = doc('one', 'two', 'gone1', 'gone2', 'three')
  const shown = doc('one', 'two', 'three')
  const deleted: ChunkRange[] = [{ fromA: original.line(3).from, toA: original.line(5).from, fromB: shown.line(3).from, toB: shown.line(3).from }]

  it('puts a card on deleted lines right after their widget, ahead of the line the chunk sits at', () => {
    expect(at(shown, beforeSideAnchor(shown, original, deleted, 4))).toEqual({ line: 3, before: true })
    expect(beforeSideAnchor(shown, original, deleted, 3)).toEqual({ pos: shown.line(3).from, before: true })
  })

  it('puts a card on unchanged before-side lines after the matching shown line', () => {
    expect(at(shown, beforeSideAnchor(shown, original, deleted, 5))).toEqual({ line: 3, before: false })
    expect(at(shown, beforeSideAnchor(shown, original, deleted, 1))).toEqual({ line: 1, before: false })
  })

  it('reports the shown lines a before-side range sits at, for keeping them unfolded', () => {
    expect(beforeSideLines(shown, original, deleted, 3, 4)).toEqual({ startLine: 3, endLine: 3 })
    expect(beforeSideLines(shown, original, deleted, 1, 5)).toEqual({ startLine: 1, endLine: 3 })
  })
})

describe('a plain editor', () => {
  it('puts a card after the last line it comments on, within the document', () => {
    const text = doc('a', 'b', 'c')
    expect(afterLine(text, 2)).toEqual({ pos: text.line(2).to, before: false })
    expect(afterLine(text, 9)).toEqual({ pos: text.line(3).to, before: false })
  })
})
