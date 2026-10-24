import { useState, useSyncExternalStore } from 'react'
import i18n, { getCurrentLanguage, type LocaleCode } from '../i18n'
import { switchLanguage } from '../services/language-switch'

function subscribe(onChange: () => void): () => void {
  i18n.on('languageChanged', onChange)
  return () => i18n.off('languageChanged', onChange)
}

/**
 * The language a language picker shows, and picking one.
 *
 * A pick shows at once while its translations load; of overlapping picks the
 * last one shows. Otherwise the picker shows the language in use: after a pick
 * that failed, and after a switch the app makes by itself, such as the startup
 * language arriving after the app started in English.
 */
export function useLanguagePicker(): [LocaleCode, (locale: LocaleCode) => Promise<void>] {
  const inUse = useSyncExternalStore(subscribe, getCurrentLanguage)
  const [picked, setPicked] = useState<LocaleCode | null>(null)
  const pick = async (locale: LocaleCode): Promise<void> => {
    setPicked(locale)
    await switchLanguage(locale)
    setPicked((current) => (current === locale ? null : current))
  }
  return [picked ?? inUse, pick]
}
