/**
 * Which UI language to use. Kept free of i18next so the boot splash script
 * (boot/splash.ts), which runs before the app's code, picks the same
 * language the app will.
 */

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

/** localStorage key of the language the user picked; absent until they pick one. */
export const LOCALE_STORAGE_KEY = 'halo-locale'

function isLocaleCode(value: string): value is LocaleCode {
  return Object.prototype.hasOwnProperty.call(SUPPORTED_LOCALES, value)
}

function localeForSystemLanguage(language: string): LocaleCode {
  const lang = language || 'en'
  if (isLocaleCode(lang)) return lang

  if (lang.startsWith('zh-TW') || lang.startsWith('zh-HK') || lang.startsWith('zh-Hant')) return 'zh-TW'
  if (lang.startsWith('zh')) return 'zh-CN'
  if (lang.startsWith('ja')) return 'ja'
  if (lang.startsWith('es')) return 'es'
  if (lang.startsWith('fr')) return 'fr'
  if (lang.startsWith('de')) return 'de'

  return 'en'
}

/** The user's pick when it is still supported, otherwise the closest match to the system language. */
export function resolveLocale(saved: string | null, systemLanguage: string): LocaleCode {
  if (saved && isLocaleCode(saved)) return saved
  return localeForSystemLanguage(systemLanguage)
}
