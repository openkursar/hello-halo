import { describe, expect, it } from 'vitest'
import { hasPasteWhitespace, trimPastedValue } from '../../../src/shared/pasted-value'

describe('pasted values', () => {
  it.each([' ', '\t', '\r\n', '\u00a0', '\u0085', '\u200b', '\u2060', '\u3000', '\ufeff'])(
    'removes outer padding %j without changing the interior', padding => {
      expect(trimPastedValue(`${padding}a${padding}b${padding}`)).toBe(`a${padding}b`)
      expect(trimPastedValue(padding)).toBe('')
      expect(hasPasteWhitespace(`a${padding}b`)).toBe(true)
    },
  )

  it('leaves percent escapes and genuine joining characters intact', () => {
    const value = 'https://example.test/%20?token=x%20y'
    expect(trimPastedValue(value)).toBe(value)
    expect(hasPasteWhitespace(value)).toBe(false)
    expect(trimPastedValue('\u200da\u200c')).toBe('\u200da\u200c')
  })
})
