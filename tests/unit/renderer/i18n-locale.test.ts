import { describe, expect, it } from 'vitest'
import { resolveLocale } from '../../../src/renderer/i18n/locale'

describe('resolveLocale', () => {
  it('keeps a supported language the user picked over the system language', () => {
    expect(resolveLocale('ja', 'zh-CN')).toBe('ja')
    expect(resolveLocale('zh-TW', 'en-US')).toBe('zh-TW')
  })

  it('falls back to the system language when the pick is missing or unsupported', () => {
    expect(resolveLocale(null, 'fr-FR')).toBe('fr')
    expect(resolveLocale('ko', 'de-DE')).toBe('de')
    // An inherited object key is not a language.
    expect(resolveLocale('constructor', 'es-ES')).toBe('es')
  })

  it('maps Chinese variants by script and region', () => {
    expect(resolveLocale(null, 'zh-CN')).toBe('zh-CN')
    expect(resolveLocale(null, 'zh')).toBe('zh-CN')
    expect(resolveLocale(null, 'zh-SG')).toBe('zh-CN')
    expect(resolveLocale(null, 'zh-TW')).toBe('zh-TW')
    expect(resolveLocale(null, 'zh-HK')).toBe('zh-TW')
    expect(resolveLocale(null, 'zh-Hant-TW')).toBe('zh-TW')
  })

  it('uses English for anything else, including no system language', () => {
    expect(resolveLocale(null, 'en-GB')).toBe('en')
    expect(resolveLocale(null, 'ko-KR')).toBe('en')
    expect(resolveLocale(null, '')).toBe('en')
  })
})
