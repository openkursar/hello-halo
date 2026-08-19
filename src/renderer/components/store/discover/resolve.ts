/**
 * Display helpers for the discover page. Section entries arrive already
 * resolved from the main process; only per-language text is picked here.
 */

import type { LocaleText } from '../../../../shared/store/store-types'

/** Resolve a per-language text to a display string for the current locale. */
export function resolveLocaleText(text: LocaleText | undefined, locale: string): string | undefined {
  if (!text) return undefined
  return text[locale] ?? text.default ?? Object.values(text)[0]
}
