import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'

const localeRoot = resolve(__dirname, '../../../src/renderer/i18n/locales')
const locales = ['de', 'en', 'es', 'fr', 'ja', 'zh-CN', 'zh-TW']
const messages = [
  'Cannot reach server, check network or proxy',
  'Endpoint not found, check the URL',
  'Invalid API Key or no permission',
  'Rate limited or out of quota',
  'Request timed out, check the server or proxy'
]

describe('model-fetch error translations', () => {
  it.each(locales)('provides localized guidance for %s', locale => {
    const catalog = JSON.parse(readFileSync(
      resolve(localeRoot, `${locale}.json`),
      'utf8'
    )) as Record<string, string>

    for (const message of messages) {
      expect(catalog[message]).toBeTypeOf('string')
      expect(catalog[message]).not.toBe('')
      if (locale !== 'en') expect(catalog[message]).not.toBe(message)
    }
  })
})
