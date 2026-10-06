/**
 * A long user message folds to about its first eight lines, judged from the
 * text alone: line breaks, and long lines as the bubble would wrap them, with
 * a wide (CJK) character taking two columns. A message only a little longer
 * than its preview is shown whole.
 */

import { describe, expect, it } from 'vitest'
import { foldUserMessage } from '../../../src/renderer/components/chat/user-message-fold'

const lines = (count: number, make = (n: number) => `line ${n}`) => Array.from({ length: count }, (_, i) => make(i + 1)).join('\n')

describe('folding a user message', () => {
  it('shows a short message whole, up to twelve lines', () => {
    expect(foldUserMessage('')).toBeNull()
    expect(foldUserMessage('Please fix the login bug')).toBeNull()
    expect(foldUserMessage(lines(12))).toBeNull()
  })

  it('folds a pasted log to its first eight lines, counting all of them', () => {
    expect(foldUserMessage(lines(13))).toEqual({ preview: lines(8), lineCount: 13 })
    expect(foldUserMessage(lines(400))).toEqual({ preview: lines(8), lineCount: 400 })
  })

  it('counts a long line as the lines it wraps to', () => {
    expect(foldUserMessage('x'.repeat(960))).toBeNull()
    expect(foldUserMessage('x'.repeat(3000))).toEqual({ preview: 'x'.repeat(640), lineCount: 1 })

    // Two lines of three rows each leave two rows for the third line.
    const text = lines(5, (n) => String(n).repeat(200))
    expect(foldUserMessage(text)).toEqual({ preview: `${'1'.repeat(200)}\n${'2'.repeat(200)}\n${'3'.repeat(160)}`, lineCount: 5 })
  })

  it('counts a wide character as two columns', () => {
    expect(foldUserMessage('字'.repeat(480))).toBeNull()
    expect(foldUserMessage('字'.repeat(600))).toEqual({ preview: '字'.repeat(320), lineCount: 1 })
  })

  it('never cuts a character in half', () => {
    const fold = foldUserMessage('😀'.repeat(700))
    expect(Array.from(fold!.preview)).toEqual(Array(320).fill('😀'))
  })

  it('stops reading a huge message once it knows it folds', () => {
    const started = performance.now()
    expect(foldUserMessage(`${'y'.repeat(5_000_000)}\n${lines(1000)}`)?.lineCount).toBe(1001)
    expect(performance.now() - started).toBeLessThan(500)
  })
})
