/**
 * i18n Configuration for Halo
 *
 * Supports 7 languages with automatic system language detection.
 * English is the source language, translations maintained by AI.
 *
 * Usage:
 * 1. Import this file in main.tsx before App render
 * 2. Use useTranslation() hook in components: const { t } = useTranslation()
 * 3. Wrap text with t(): {t('Save')}
 * 4. Run `npm run i18n:extract` to update locale files
 */

import i18n from 'i18next'
import { initReactI18next, useTranslation as useI18nTranslation } from 'react-i18next'

// Import all locale files
import en from './locales/en.json'
import zhCN from './locales/zh-CN.json'
import zhTW from './locales/zh-TW.json'
import ja from './locales/ja.json'
import es from './locales/es.json'
import fr from './locales/fr.json'
import de from './locales/de.json'

// Supported locales with native language names
export const SUPPORTED_LOCALES = {
  'de': 'Deutsch',
  'en': 'English',
  'es': 'Español',
  'fr': 'Français',
  'ja': '日本語',
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',

} as const

export type LocaleCode = keyof typeof SUPPORTED_LOCALES

// Storage key for persisting language preference
const LOCALE_STORAGE_KEY = 'halo-locale'

/**
 * Detect system language and map to supported locale
 */
function detectLanguage(): LocaleCode {
  const lang = navigator.language || 'en'

  // Exact match
  if (lang in SUPPORTED_LOCALES) {
    return lang as LocaleCode
  }

  // Chinese variants
  if (lang.startsWith('zh-TW') || lang.startsWith('zh-HK') || lang.startsWith('zh-Hant')) {
    return 'zh-TW'
  }
  if (lang.startsWith('zh')) {
    return 'zh-CN'
  }

  // Other languages - match by prefix
  if (lang.startsWith('ja')) return 'ja'
  if (lang.startsWith('es')) return 'es'
  if (lang.startsWith('fr')) return 'fr'
  if (lang.startsWith('de')) return 'de'

  return 'en'
}

/**
 * Get initial language from localStorage or detect from system
 */
function getInitialLanguage(): LocaleCode {
  try {
    const saved = localStorage.getItem(LOCALE_STORAGE_KEY)
    if (saved && saved in SUPPORTED_LOCALES) {
      return saved as LocaleCode
    }
  } catch (e) {
    // Ignore localStorage errors (may be disabled)
  }
  return detectLanguage()
}

// Initialize i18next
i18n
  .use(initReactI18next)
  .init({
    resources: {
      'en': { translation: en },
      'zh-CN': { translation: zhCN },
      'zh-TW': { translation: zhTW },
      'ja': { translation: ja },
      'es': { translation: es },
      'fr': { translation: fr },
      'de': { translation: de }
    },
    lng: getInitialLanguage(),
    fallbackLng: 'en',

    interpolation: {
      escapeValue: false // React already escapes values
    },

    // Return key if translation not found (key IS the English text)
    returnEmptyString: false,

    // Enable debug in development
    debug: import.meta.env.DEV
  })

// Re-export useTranslation for convenience
export const useTranslation = useI18nTranslation

/**
 * Change language and persist to localStorage
 */
export function setLanguage(locale: LocaleCode): void {
  i18n.changeLanguage(locale)
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  } catch (e) {
    // Ignore localStorage errors
  }
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
