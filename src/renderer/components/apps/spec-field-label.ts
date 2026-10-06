/**
 * How the fields of a digital human's definition are named to the user, for
 * the places that list what an author's upgrade kept at the user's version:
 * the activity note and the store's update dialog say it the same way.
 */

import type { TFunction } from 'i18next'

export function specFieldLabel(field: string, t: TFunction): string {
  switch (field) {
    case 'system_prompt': return t('System Prompt')
    case 'subscriptions': return t('Run times')
    case 'name':
    case 'display_name': return t('Name')
    case 'description': return t('Description')
    case 'requires': return t('Connections and skills')
    case 'config_schema': return t('Settings form')
    case 'icon': return t('Icon')
    case 'permissions': return t('Permissions')
    case 'filters': return t('Event filters')
    case 'memory_schema': return t('Memory layout')
    case 'output': return t('Output and notifications')
    case 'escalation': return t('Questions to you')
    case 'recommended_model': return t('Recommended model')
    case 'browser_login': return t('Website sign-ins')
    case 'i18n': return t('Translations')
    default: return field
  }
}

/** The fields' labels as one phrase, joined the way the user's language joins a list. */
export function specFieldList(fields: readonly string[], t: TFunction, language: string): string {
  const labels = [...new Set(fields.map(field => specFieldLabel(field, t)))]
  try {
    return new Intl.ListFormat(language, { style: 'long', type: 'conjunction' }).format(labels)
  } catch {
    return labels.join(', ')
  }
}

/** The success message of an update applied in place, naming what kept the user's version. */
export function upgradedMessage(
  version: string,
  outcome: { kept?: readonly string[]; editsKnown?: boolean },
  t: TFunction,
  language: string,
): string {
  const kept = outcome.kept ?? []
  if (kept.length === 0) return t('Upgraded to v{{version}}', { version })
  const message = t('Upgraded to v{{version}}. These differ from the author’s new version and kept your current version: {{items}}', {
    version,
    items: specFieldList(kept, t, language),
  })
  return outcome.editsKnown === false ? `${message} ${t('Halo cannot tell which of them you changed.')}` : message
}
