/**
 * The notification channel forms (Settings → Message Channels) are translated:
 * every field label and wording hint is a literal t() call, the only form the
 * translation extractor (i18next-parser, the same lexer `npm run i18n` runs)
 * picks up — a key read from a table never reaches the locale files and shows
 * English in every language.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import * as i18nextParser from 'i18next-parser'

// Exported by the package, though its type declarations leave it out.
const { JsxLexer } = i18nextParser as unknown as {
  JsxLexer: new (options: { functions: string[] }) => { extract(content: string, filename: string): Array<{ key: string }> }
}

const file = fileURLToPath(new URL('../../../src/renderer/components/settings/MessageChannelsSection.tsx', import.meta.url))

function extractedKeys(): Set<string> {
  const lexer = new JsxLexer({ functions: ['t', 'i18next.t', 'i18n.t'] })
  return new Set(lexer.extract(readFileSync(file, 'utf8'), file).map(entry => entry.key))
}

describe('notification channel form labels', () => {
  const keys = extractedKeys()

  it.each([
    'SMTP Host', 'SMTP Port', 'Use SSL/TLS', 'Username', 'Password', 'Default Recipient', 'CalDAV URL', 'TLS Ciphers',
    'Corp ID', 'Agent ID', 'Secret', 'Default User ID', 'Default Party ID',
    'App Key', 'App Secret', 'Robot Code', 'Default Chat ID', 'App ID',
    'URL', 'Method', 'Headers (JSON)', 'HMAC Secret',
  ])('reach the locale files: %s', (label) => {
    expect(keys.has(label)).toBe(true)
  })

  it.each([
    'App password', 'Auto (system default)', 'userid (optional)', 'party id (optional)',
    'Robot code (optional)', 'Chat ID (optional)', 'User open_id (optional)', 'Signing secret (optional)',
  ])('reach the locale files for worded hints too: %s', (hint) => {
    expect(keys.has(hint)).toBe(true)
  })

  it('leave sample values out of translation', () => {
    for (const sample of ['smtp.gmail.com', 'user@example.com', 'recipient@example.com', 'https://example.com/webhook', 'ww...']) {
      expect(keys.has(sample), sample).toBe(false)
    }
  })
})
