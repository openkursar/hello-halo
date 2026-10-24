/**
 * Sets up the boot splash (index.html) before the window's first frame.
 *
 * Inlined into index.html at build time by vite.boot-script.ts and run while
 * the page parses, before the app's own code. It fills in the tagline in the
 * user's language: the plugin copies the translations of the strings passed
 * to `t` in this file from the locale files, so nothing here waits for the
 * app's translations.
 */

import { LOCALE_STORAGE_KEY, resolveLocale, type LocaleCode } from '../i18n/locale'

declare const __HALO_BOOT_MESSAGES__: Partial<Record<LocaleCode, Record<string, string>>>

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const messages = __HALO_BOOT_MESSAGES__[resolveLocale(stored(LOCALE_STORAGE_KEY), navigator.language)] ?? {}
const t = (key: string): string => messages[key] || key
const tagline = document.getElementById('boot-splash-tagline')
if (tagline) tagline.textContent = t('AI that gets things done')
