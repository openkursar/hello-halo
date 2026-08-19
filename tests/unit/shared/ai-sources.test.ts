/**
 * Unit tests for resolveLocalizedText in shared/types/ai-sources.ts.
 *
 * Fallback chain (documented on the function):
 *   plain string -> exact locale -> prefix match -> 'en' -> first value -> ''.
 */

import { describe, it, expect } from 'vitest'
import { resolveLocalizedText } from '../../../src/shared/types/ai-sources'

describe('resolveLocalizedText', () => {
  it('returns a plain string verbatim, ignoring the locale', () => {
    expect(resolveLocalizedText('Hello', 'zh-CN')).toBe('Hello')
  })

  it('returns the exact-locale value when present', () => {
    const text = { 'en': 'Hello', 'zh-CN': '你好' }
    expect(resolveLocalizedText(text, 'zh-CN')).toBe('你好')
  })

  it('falls back to a prefix match (zh-TW -> zh)', () => {
    const text = { 'en': 'Hello', 'zh': '你好' }
    expect(resolveLocalizedText(text, 'zh-TW')).toBe('你好')
  })

  it('falls back to "en" when neither exact nor prefix match', () => {
    const text = { 'en': 'Hello', 'ja': 'こんにちは' }
    expect(resolveLocalizedText(text, 'fr-FR')).toBe('Hello')
  })

  it('falls back to the first value when "en" is absent', () => {
    const text = { 'ja': 'こんにちは', 'ko': '안녕하세요' }
    expect(resolveLocalizedText(text, 'fr-FR')).toBe('こんにちは')
  })

  it('returns empty string for an empty object', () => {
    expect(resolveLocalizedText({}, 'en')).toBe('')
  })

  it('prefers exact match over prefix match', () => {
    const text = { 'zh': 'generic zh', 'zh-CN': 'simplified' }
    expect(resolveLocalizedText(text, 'zh-CN')).toBe('simplified')
  })
})
