import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { runInNewContext } from 'vm'
import { bootSplashScript, collectBootMessages, extractMessageKeys } from '../../vite.boot-script'

const rendererRoot = resolve(__dirname, '../../src/renderer')
const indexHtml = readFileSync(resolve(rendererRoot, 'index.html'), 'utf-8')
const zhCN = JSON.parse(readFileSync(resolve(rendererRoot, 'i18n/locales/zh-CN.json'), 'utf-8'))

async function builtIndexHtml(): Promise<string> {
  const plugin = bootSplashScript(rendererRoot)
  const transform = plugin.transformIndexHtml as (html: string) => Promise<string>
  return transform(indexHtml)
}

/** Runs the inlined script against a stand-in for the page it lands in; returns the tagline it wrote. */
function runBootScript(html: string, env: { storage?: Record<string, string>; language?: string }): string {
  const script = /id="boot-splash-tagline"[\s\S]*?<script>([\s\S]*?)<\/script>/.exec(html)?.[1]
  if (!script) throw new Error('inline boot script not found right after the splash')
  const tagline = { textContent: '' }
  runInNewContext(script, {
    document: { getElementById: (id: string) => (id === 'boot-splash-tagline' ? tagline : null) },
    localStorage: { getItem: (key: string) => env.storage?.[key] ?? null },
    navigator: { language: env.language ?? 'en-US' },
  })
  return tagline.textContent
}

describe('boot splash script', () => {
  it('finds the literal strings of t() calls', () => {
    expect(extractMessageKeys(`t('One') + t("Two") + t( 'One' ) + format('x') + t(key)`)).toEqual(['One', 'Two'])
  })

  it('takes each locale\'s translation and leaves untranslated strings to the English key', () => {
    const { messages, untranslated } = collectBootMessages(['Hello', 'Bye'], {
      en: { Hello: 'Hello', Bye: 'Bye' },
      fr: { Hello: 'Bonjour', Bye: '' },
    })
    expect(messages).toEqual({ en: { Hello: 'Hello', Bye: 'Bye' }, fr: { Hello: 'Bonjour' } })
    expect(untranslated).toEqual(['fr: Bye'])
  })

  it('shows the tagline in the language the app will use', async () => {
    const html = await builtIndexHtml()
    expect(html).not.toContain('<!-- boot-splash-script -->')

    expect(runBootScript(html, { language: 'zh-CN' })).toBe(zhCN['AI that gets things done'])
    expect(runBootScript(html, { storage: { 'halo-locale': 'zh-CN' } })).toBe(zhCN['AI that gets things done'])
    expect(runBootScript(html, { language: 'ko-KR' })).toBe('AI that gets things done')
  })

  it('carries only the strings the splash uses, not whole locale files', async () => {
    const html = await builtIndexHtml()
    expect(html.length - indexHtml.length).toBeLessThan(6000)
  })
})
