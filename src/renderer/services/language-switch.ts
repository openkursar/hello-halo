import i18n, { setLanguage, SUPPORTED_LOCALES, type LocaleCode } from '../i18n'
import { useNotificationStore } from '../stores/notification.store'

/**
 * A language the user picked: switches to it, or tells them why the language
 * in use stays. Resolves false in that case, so the picker can show the
 * language in use again.
 */
export async function switchLanguage(locale: LocaleCode): Promise<boolean> {
  if (await setLanguage(locale)) return true
  useNotificationStore.getState().show({
    id: 'language-switch-failed',
    title: i18n.t("Couldn't switch to {{language}}", { language: SUPPORTED_LOCALES[locale] }),
    body: i18n.t('Its language pack could not be loaded, so the current language stays.'),
    variant: 'warning',
    duration: 6000,
  })
  return false
}
