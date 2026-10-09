/**
 * A long user message folds to about its first twenty lines, judged from the
 * text alone: line breaks, and long lines as the bubble would wrap them, with
 * a wide (CJK) character taking two columns. A message only a little longer
 * than its preview is shown whole.
 */

import { describe, expect, it } from 'vitest'
import { foldUserMessage } from '../../../src/renderer/components/chat/user-message-fold'

const lines = (count: number, make = (n: number) => `line ${n}`) => Array.from({ length: count }, (_, i) => make(i + 1)).join('\n')

describe('folding a user message', () => {
  it('shows a short message whole', () => {
    expect(foldUserMessage('')).toBeNull()
    expect(foldUserMessage('Please fix the login bug')).toBeNull()
  })

  it('shows exactly 24 logical rows whole and folds 25 to the first 20', () => {
    expect(foldUserMessage(lines(24))).toBeNull()
    expect(foldUserMessage(lines(25))).toEqual({ preview: lines(20), lineCount: 25 })
  })

  it('folds a pasted log to its first twenty lines, counting all of them', () => {
    expect(foldUserMessage(lines(400))).toEqual({ preview: lines(20), lineCount: 400 })
  })

  it('counts empty lines toward the fold threshold', () => {
    expect(foldUserMessage(`${lines(20)}\n\n\n\n`)).toBeNull()
    expect(foldUserMessage(`${lines(20)}\n\n\n\n\n`)).toEqual({ preview: lines(20), lineCount: 25 })
  })

  it('counts a long ASCII line in 80-column rows', () => {
    expect(foldUserMessage('x'.repeat(1920))).toBeNull()
    expect(foldUserMessage('x'.repeat(1921))).toEqual({ preview: 'x'.repeat(1600), lineCount: 1 })
    expect(foldUserMessage('x'.repeat(3000))).toEqual({ preview: 'x'.repeat(1600), lineCount: 1 })
  })

  it('cuts a wrapped line using the rows remaining after earlier lines', () => {
    const text = lines(9, (n) => String(n).repeat(200))
    expect(foldUserMessage(text)).toEqual({
      preview: `${lines(6, (n) => String(n).repeat(200))}\n${'7'.repeat(160)}`,
      lineCount: 9,
    })
  })

  it('counts a wide character as two columns', () => {
    expect(foldUserMessage('字'.repeat(960))).toBeNull()
    expect(foldUserMessage('字'.repeat(961))).toEqual({ preview: '字'.repeat(800), lineCount: 1 })
    expect(foldUserMessage('字'.repeat(1500))).toEqual({ preview: '字'.repeat(800), lineCount: 1 })
  })

  it('preserves supplementary Unicode characters at the preview boundary', () => {
    const char = '\u{20000}'
    expect(foldUserMessage(char.repeat(961))).toEqual({ preview: char.repeat(800), lineCount: 1 })
    expect(foldUserMessage(`x${char.repeat(961)}`)).toEqual({ preview: `x${char.repeat(799)}`, lineCount: 1 })
  })

  it('preserves a non-wide surrogate pair at the preview boundary', () => {
    const char = '\u{1d400}'
    expect(foldUserMessage(`${'x'.repeat(1599)}${char}${'x'.repeat(400)}`)).toEqual({
      preview: `${'x'.repeat(1599)}${char}`,
      lineCount: 1,
    })
  })

  it('counts supplementary emoji as two columns without splitting them', () => {
    const char = '\u{1f600}'
    expect(foldUserMessage(char.repeat(960))).toBeNull()
    expect(foldUserMessage(char.repeat(961))).toEqual({ preview: char.repeat(800), lineCount: 1 })
  })

  it('stops reading a huge message once it knows it folds', () => {
    const started = performance.now()
    expect(foldUserMessage(`${'y'.repeat(5_000_000)}\n${lines(1000)}`)?.lineCount).toBe(1001)
    expect(performance.now() - started).toBeLessThan(500)
  })
})
