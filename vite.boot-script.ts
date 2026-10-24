/**
 * Inlines the boot splash's script into the renderer's index.html, for the
 * desktop and the mobile build alike.
 *
 * The splash must be on screen in the window's first frame, before the app's
 * bundle has even started to run, so its script cannot be part of that bundle
 * and cannot wait for the app's translations. This plugin bundles
 * src/renderer/boot/splash.ts into a classic inline script and gives it
 * only the strings it uses, copied from the locale files at build time.
 */

import { readdirSync, readFileSync } from 'fs'
import { basename, resolve } from 'path'
import { build } from 'esbuild'
import type { Logger, Plugin } from 'vite'

const PLACEHOLDER = '<!-- boot-splash-script -->'
const SOURCE_LOCALE = 'en'

type Catalog = Record<string, string>

/** The literal keys of every `t('...')` call in `source`. */
export function extractMessageKeys(source: string): string[] {
  const keys = new Set<string>()
  for (const match of source.matchAll(/\bt\(\s*(['"])([^'"\\\n]+)\1\s*\)/g)) keys.add(match[2])
  return [...keys]
}

/**
 * Per locale, the translation of each key. A key a locale has not translated
 * yet is left out, so the script shows the English key, as the app does.
 */
export function collectBootMessages(
  keys: string[],
  catalogs: Record<string, Catalog>,
): { messages: Record<string, Catalog>; untranslated: string[] } {
  const messages: Record<string, Catalog> = {}
  const untranslated: string[] = []
  for (const [locale, catalog] of Object.entries(catalogs)) {
    messages[locale] = {}
    for (const key of keys) {
      const value = catalog[key]
      if (value) messages[locale][key] = value
      else if (locale !== SOURCE_LOCALE) untranslated.push(`${locale}: ${key}`)
    }
  }
  return { messages, untranslated }
}

function readCatalogs(localesDir: string): Record<string, Catalog> {
  const catalogs: Record<string, Catalog> = {}
  for (const file of readdirSync(localesDir)) {
    if (!file.endsWith('.json')) continue
    catalogs[basename(file, '.json')] = JSON.parse(readFileSync(resolve(localesDir, file), 'utf-8'))
  }
  return catalogs
}

export function bootSplashScript(rendererRoot: string): Plugin {
  const entry = resolve(rendererRoot, 'boot/splash.ts')
  const localesDir = resolve(rendererRoot, 'i18n/locales')
  let logger: Logger | undefined

  return {
    name: 'halo-boot-splash-script',
    configResolved(config) {
      logger = config.logger
    },
    async transformIndexHtml(html) {
      if (!html.includes(PLACEHOLDER)) return html

      const keys = extractMessageKeys(readFileSync(entry, 'utf-8'))
      if (keys.length === 0) throw new Error(`${entry} has no t('...') strings to translate`)
      const { messages, untranslated } = collectBootMessages(keys, readCatalogs(localesDir))
      if (untranslated.length) {
        logger?.warn(`[boot-splash] shown in English until translated: ${untranslated.join(', ')}`)
      }

      const result = await build({
        entryPoints: [entry],
        bundle: true,
        write: false,
        format: 'iife',
        minify: true,
        target: 'es2020',
        define: { __HALO_BOOT_MESSAGES__: JSON.stringify(messages) },
      })
      // A translation containing "</script" would otherwise end the inline script early.
      const code = result.outputFiles[0].text.trim().replace(/<\/(script)/gi, '<\\/$1')
      return html.replace(PLACEHOLDER, () => `<script>${code}</script>`)
    },
  }
}
