/// <reference types="vite/client" />
/**
 * i18n Configuration for Halo
 *
 * Supports 7 languages with automatic system language detection.
 * English is the source language, translations maintained by AI.
 *
 * Usage:
 * 1. main.tsx renders the app once `i18nReady` resolves
 * 2. Use useTranslation() hook in components: const { t } = useTranslation()
 * 3. Wrap text with t(): {t('Save')}
 * 4. Run `npm run i18n:extract` to update locale files
 */

import i18n from 'i18next'
import { initReactI18next, useTranslation as useI18nTranslation } from 'react-i18next'
import { LOCALE_STORAGE_KEY, SUPPORTED_LOCALES, resolveLocale, type LocaleCode } from './locale'

export { SUPPORTED_LOCALES, type LocaleCode } from './locale'

// English is the fallback for every language, so it ships with the app's code.
// Each other language is a chunk of its own: only the one in use loads at
// startup, the rest when the user switches to them.
import en from './locales/en.json'

type Translations = Record<string, string>

// i18next takes these copy options, but its type declarations leave them out.
declare module 'i18next' {
  interface i18n {
    addResourceBundle(lng: string, ns: string, resources: Translations, deep: boolean, overwrite: boolean, options: { skipCopy: boolean }): i18n
  }
}

const LOCALE_LOADERS: Record<Exclude<LocaleCode, 'en'>, () => Promise<{ default: Translations }>> = {
  'zh-CN': () => import('./locales/zh-CN.json'),
  'zh-TW': () => import('./locales/zh-TW.json'),
  'ja': () => import('./locales/ja.json'),
  'es': () => import('./locales/es.json'),
  'fr': () => import('./locales/fr.json'),
  'de': () => import('./locales/de.json'),
}

/**
 * How long a language's translations may take before Halo goes on without
 * them. From the app's own files they take milliseconds; the bound is for
 * remote access, where the request can stall.
 */
const LOCALE_LOAD_TIMEOUT_MS = 3000

const loadingLocales = new Map<LocaleCode, Promise<boolean>>()

/** Resolves true once the language's translations are in, false when they could not be loaded. */
function loadLocale(locale: LocaleCode): Promise<boolean> {
  if (locale === 'en') return Promise.resolve(true)
  let loading = loadingLocales.get(locale)
  if (!loading) {
    loading = LOCALE_LOADERS[locale]()
      .then(({ default: translations }) => {
        // Used as loaded: a copy of the whole language would delay the first render.
        i18n.addResourceBundle(locale, 'translation', translations, false, false, { skipCopy: true })
        return true
      })
      .catch((error: unknown) => {
        loadingLocales.delete(locale)
        console.error(`[i18n] Could not load the ${locale} translations:`, error)
        return false
      })
    loadingLocales.set(locale, loading)
  }
  return loading
}

/**
 * `loading`'s outcome, or false once it has taken LOCALE_LOAD_TIMEOUT_MS. The
 * time counts from the next task: at startup that is after the app's own
 * modules have run, so a slow start of the app is not taken for a stalled
 * language.
 */
function loadedInTime(locale: LocaleCode, loading: Promise<boolean>): Promise<boolean> {
  return new Promise((resolve) => {
    let deadline: ReturnType<typeof setTimeout> | undefined
    const start = setTimeout(() => {
      deadline = setTimeout(() => {
        console.warn(`[i18n] The ${locale} translations did not load within ${LOCALE_LOAD_TIMEOUT_MS} ms`)
        resolve(false)
      }, LOCALE_LOAD_TIMEOUT_MS)
    }, 0)
    void loading.then((loaded) => {
      clearTimeout(start)
      clearTimeout(deadline)
      resolve(loaded)
    })
  })
}

/**
 * `navigator` and `localStorage` are absent outside a DOM, and this module is
 * reached at import time from stores that also load under plain Node — a bare
 * read would throw before any test or headless caller gets a chance to run.
 */
function getInitialLanguage(): LocaleCode {
  let saved: string | null = null
  try {
    saved = localStorage.getItem(LOCALE_STORAGE_KEY)
  } catch {
    // Storage unavailable: fall back to the system language.
  }
  return resolveLocale(saved, typeof navigator === 'undefined' ? '' : navigator.language)
}

const initialLanguage = getInitialLanguage()

/** The language the user asked for last; a load that finishes later for another one does not override it. */
let requestedLocale: LocaleCode = initialLanguage

// Initialize i18next
i18n
  .use(initReactI18next)
  .init({
    resources: {
      'en': { translation: en }
    },
    lng: initialLanguage,
    fallbackLng: 'en',

    interpolation: {
      escapeValue: false // React already escapes values
    },

    // Return key if translation not found (key IS the English text)
    returnEmptyString: false,

    // Enable debug in development
    debug: import.meta.env.DEV
  })

const initialLoad = loadLocale(initialLanguage)

/**
 * Resolves once the app can render: in the language in use once its
 * translations are in, in English when they fail or take too long. The first
 * render waits for it. Translations that arrive late still switch the app to
 * their language, unless the user has picked one meanwhile.
 */
export const i18nReady: Promise<void> = loadedInTime(initialLanguage, initialLoad).then(async (loaded) => {
  if (loaded) return
  await i18n.changeLanguage('en')
  void initialLoad.then((arrived) => {
    if (arrived && requestedLocale === initialLanguage) void i18n.changeLanguage(initialLanguage)
  })
})

// Re-export useTranslation for convenience
export const useTranslation = useI18nTranslation

/**
 * Switches to `locale` once its translations are in, and remembers the
 * choice; of overlapping switches the last wins. Resolves false only when this
 * switch failed because the translations could not be loaded in time: the
 * language in use then stays and the choice is not remembered.
 */
export async function setLanguage(locale: LocaleCode): Promise<boolean> {
  requestedLocale = locale
  const loaded = await loadedInTime(locale, loadLocale(locale))
  // A later switch has taken over: nothing of this one to undo.
  if (requestedLocale !== locale) return true
  if (!loaded) {
    requestedLocale = getCurrentLanguage()
    return false
  }
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  } catch {
    // Storage unavailable: the switch holds for this session only.
  }
  await i18n.changeLanguage(locale)
  return true
}

/**
 * Get current language code
 */
export function getCurrentLanguage(): LocaleCode {
  return i18n.language as LocaleCode
}

/**
 * Get current language display name
 */
export function getCurrentLanguageName(): string {
  const lang = getCurrentLanguage()
  return SUPPORTED_LOCALES[lang] || SUPPORTED_LOCALES['en']
}

export default i18n
