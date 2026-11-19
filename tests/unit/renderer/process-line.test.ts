/**
 * Lines in a reply's work end at the same length whatever the window width:
 * a subject is folded onto one line and cut to a fixed number of columns, a
 * wide (CJK) character counting as two.
 */

import { describe, expect, it } from 'vitest'
import { clipSubject } from '../../../src/renderer/components/chat/process-line'

describe('clipSubject', () => {
  it('keeps a short subject whole', () => {
    expect(clipSubject('npm test')).toEqual({ text: 'npm test', clipped: false })
  })

  it('cuts a long one at the column limit with an ellipsis', () => {
    expect(clipSubject('a'.repeat(60), 44)).toEqual({ text: `${'a'.repeat(44)}…`, clipped: true })
  })

  it('counts a wide character as two columns', () => {
    expect(clipSubject('数'.repeat(30), 44).text).toBe(`${'数'.repeat(22)}…`)
    expect(clipSubject('ab数据', 5)).toEqual({ text: 'ab数…', clipped: true })
  })

  it('folds lines and runs of space into one line, and says when lines were folded away', () => {
    expect(clipSubject('Done so far:\n  - one\n  - two')).toEqual({ text: 'Done so far: - one - two', clipped: true })
    expect(clipSubject('  padded  ')).toEqual({ text: 'padded', clipped: false })
  })

  it('reads only the head of a very long subject', () => {
    const huge = `${'x '.repeat(20)}${'y'.repeat(1_000_000)}`
    const result = clipSubject(huge, 44)
    expect(result.clipped).toBe(true)
    expect(result.text.endsWith('…')).toBe(true)
  })
})
