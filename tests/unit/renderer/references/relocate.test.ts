/**
 * Going back to a referenced place after the content changed: the text is
 * found where it is now, or the user is told it is gone — never pointed at
 * something else silently.
 */

import { describe, expect, it } from 'vitest'
import { approximateLines, lineSourceOf, looseIndexOf, relocateLines } from '../../../../src/renderer/components/references/relocate'

const doc = (...lines: string[]) => lineSourceOf(lines.join('\n'))

describe('relocateLines', () => {
  const original = doc(
    'import { a } from "./a"',
    '',
    'export function forced(profile) {',
    '  const level = forcedThinkingLevel(profile)',
    '  if (level) return { effort: level }',
    '  return null',
    '}',
  )

  it('keeps the range when the text is still there', () => {
    const quote = '  const level = forcedThinkingLevel(profile)\n  if (level) return { effort: level }'
    expect(relocateLines(original, { startLine: 4, endLine: 5 }, quote)).toEqual({ range: { startLine: 4, endLine: 5 }, outcome: 'exact' })
  })

  it('matches a selection that started mid-line', () => {
    expect(relocateLines(original, { startLine: 4, endLine: 4 }, 'forcedThinkingLevel(profile)').outcome).toBe('exact')
  })

  it('follows the text when lines were inserted above it, keeping the range length', () => {
    const moved = doc(
      'import { a } from "./a"',
      'import { b } from "./b"',
      'import { c } from "./c"',
      '',
      'export function forced(profile) {',
      '  const level = forcedThinkingLevel(profile)',
      '  if (level) return { effort: level }',
      '  return null',
      '}',
    )
    const quote = '  const level = forcedThinkingLevel(profile)\n  if (level) return { effort: level }'
    expect(relocateLines(moved, { startLine: 4, endLine: 5 }, quote)).toEqual({ range: { startLine: 6, endLine: 7 }, outcome: 'moved' })
  })

  it('prefers the nearest copy of repeated text', () => {
    const repeated = doc('x()', 'target()', 'y()', 'z()', 'w()', 'v()', 'target()')
    expect(relocateLines(repeated, { startLine: 6, endLine: 6 }, 'target()').range.startLine).toBe(7)
    expect(relocateLines(repeated, { startLine: 3, endLine: 3 }, 'target()').range.startLine).toBe(2)
  })

  it('checks the following quote lines too, so a common first line does not mislead', () => {
    const lookalike = doc('  return null', 'done()', '', '  return null', '}')
    expect(relocateLines(lookalike, { startLine: 1, endLine: 2 }, '  return null\n}')).toEqual({ range: { startLine: 4, endLine: 5 }, outcome: 'moved' })
  })

  it('says the content is gone, and keeps the original lines, when the text is nowhere', () => {
    expect(relocateLines(original, { startLine: 4, endLine: 5 }, 'deletedFunction()')).toEqual({ range: { startLine: 4, endLine: 5 }, outcome: 'lost' })
  })

  it('clamps lines past the end of a shortened file', () => {
    const short = doc('one', 'two')
    expect(relocateLines(short, { startLine: 9, endLine: 10 }, 'gone')).toEqual({ range: { startLine: 2, endLine: 2 }, outcome: 'lost' })
    expect(relocateLines(short, { startLine: 9, endLine: 9 }).outcome).toBe('lost')
  })

  it('without a quote, trusts the range while it fits', () => {
    expect(relocateLines(original, { startLine: 2, endLine: 3 })).toEqual({ range: { startLine: 2, endLine: 3 }, outcome: 'exact' })
  })

  it('ignores blank quote lines when probing', () => {
    expect(relocateLines(original, { startLine: 2, endLine: 3 }, '\nexport function forced(profile) {').outcome).toBe('exact')
  })
})

describe('approximateLines (rendered Markdown back to its source)', () => {
  const source = [
    '# Agent design',                                  // 1
    '',                                                // 2
    'The **engine adapter** owns one session per',     // 3
    'conversation, and [the frame](docs/frame.md) is', // 4
    'rebuilt every turn.',                             // 5
    '',                                                // 6
    '- first item',                                    // 7
    '- second `code` item',                            // 8
  ].join('\n')

  it('finds a passage whose markup rendering removed', () => {
    expect(approximateLines(source, 'The engine adapter owns one session per conversation')).toEqual({ startLine: 3, endLine: 4 })
  })

  it('spans a link in the middle of the passage', () => {
    expect(approximateLines(source, 'engine adapter owns one session per conversation, and the frame is rebuilt every turn.')).toEqual({ startLine: 3, endLine: 5 })
  })

  it('crosses list items whose markers are not in the rendered text', () => {
    expect(approximateLines(source, 'first item\nsecond code item')).toEqual({ startLine: 7, endLine: 8 })
  })

  it('returns nothing for text that is not there', () => {
    expect(approximateLines(source, 'not in the document at all')).toBeUndefined()
    expect(approximateLines(source, '  \n ')).toBeUndefined()
  })
})

describe('looseIndexOf', () => {
  it('matches across differing line breaks and spacing', () => {
    const text = 'Alpha beta.Gamma   delta'
    expect(looseIndexOf(text, 'beta.\nGamma delta')).toEqual([6, 24])
  })

  it('returns null when absent or empty', () => {
    expect(looseIndexOf('abc', 'abd')).toBeNull()
    expect(looseIndexOf('abc', ' \n')).toBeNull()
  })
})
