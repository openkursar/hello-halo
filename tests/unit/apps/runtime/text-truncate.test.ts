/**
 * Unit tests for apps/runtime/text-truncate
 *
 * Core invariant: truncation never emits a lone surrogate, so the result stays
 * valid UTF-16 and survives JSON serialization into a model API request body
 * (the failure that broke IM-active automation runs: 400 "no low surrogate in
 * string").
 */

import { describe, it, expect } from 'vitest'
import { truncateUtf16Safe } from '../../../../src/main/apps/runtime/text-truncate'

/** True if the string contains an unpaired high or low surrogate. */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      i++ // valid pair, skip the low surrogate
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true // low surrogate without a preceding high surrogate
    }
  }
  return false
}

describe('truncateUtf16Safe', () => {
  it('returns the input unchanged when within the limit', () => {
    expect(truncateUtf16Safe('hello', 10)).toBe('hello')
    expect(truncateUtf16Safe('hello', 5)).toBe('hello')
  })

  it('truncates plain ASCII on the exact boundary', () => {
    expect(truncateUtf16Safe('hello world', 5)).toBe('hello')
  })

  it('drops a dangling high surrogate when the cut splits an emoji', () => {
    // '🥉' is U+1F949 → surrogate pair D83E DD49 (2 UTF-16 units).
    const text = 'ab🥉cd'
    // Cutting at 3 units keeps 'ab' + the high surrogate of 🥉 → must drop it.
    const out = truncateUtf16Safe(text, 3)
    expect(out).toBe('ab')
    expect(hasLoneSurrogate(out)).toBe(false)
  })

  it('keeps a full emoji when both halves fit', () => {
    const text = 'ab🥉cd'
    // 4 units = 'ab' + full 🥉 pair.
    expect(truncateUtf16Safe(text, 4)).toBe('ab🥉')
  })

  it('reproduces the real IM-history boundary case without a lone surrogate', () => {
    // A message where UTF-16 unit 500 falls inside a medal emoji, mirroring the
    // production payload that triggered the API 400.
    const text = 'x'.repeat(499) + '🥉' + 'tail'
    const out = truncateUtf16Safe(text, 500)
    expect(hasLoneSurrogate(out)).toBe(false)
    expect(out).toBe('x'.repeat(499))
  })

  it('never emits a lone surrogate across every cut position of an emoji-dense string', () => {
    const text = '🥇🥈🥉🏅🎖️'.repeat(10)
    for (let n = 0; n <= text.length + 2; n++) {
      expect(hasLoneSurrogate(truncateUtf16Safe(text, n))).toBe(false)
    }
  })

  it('returns empty string for non-positive limits', () => {
    expect(truncateUtf16Safe('🥉data', 0)).toBe('')
    expect(truncateUtf16Safe('🥉data', -5)).toBe('')
  })
})
