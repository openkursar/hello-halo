/**
 * i18next-parser configuration
 * Extracts translation keys from source code and updates locale JSON files
 *
 * Usage: npm run i18n:extract
 */

export default {
  // Source files to scan
  input: [
    'src/renderer/**/*.{ts,tsx}',
    '!src/renderer/**/*.test.{ts,tsx}',
    '!src/renderer/**/*.spec.{ts,tsx}',
    '!src/renderer/i18n/**'
  ],

  // Output locale files
  output: 'src/renderer/i18n/locales/$LOCALE.json',

  // Supported locales
  locales: ['en', 'zh-CN', 'zh-TW', 'ja', 'es', 'fr', 'de'],

  // Default locale (source language)
  defaultNamespace: 'translation',
  defaultValue: (locale, namespace, key) => {
    // For English, use the key itself as the value (key IS the English text)
    if (locale === 'en') {
      return key
    }
    // For other languages, return empty string (to be translated)
    return ''
  },

  // Keep existing translations
  keepRemoved: false,

  // Sort keys alphabetically
  sort: true,

  // Use i18next format
  useKeysAsDefaultValue: true,

  // Function names to look for
  func: {
    list: ['t', 'i18next.t', 'i18n.t'],
    extensions: ['.ts', '.tsx']
  },

  // Trans component (if used)
  trans: {
    component: 'Trans',
    i18nKey: 'i18nKey',
    defaultsKey: 'defaults',
    extensions: ['.tsx'],
    fallbackKey: false
  },

  // Line ending
  lineEnding: 'lf',

  // Indentation
  indentation: 2,

  // Create old catalog backup
  createOldCatalogs: false,

  // Fail on warnings
  failOnWarnings: false,

  // Fail on update
  failOnUpdate: false,

  // Verbose output
  verbose: true,

  // Custom key separator (use default '.')
  keySeparator: false,

  // Custom namespace separator (use default ':')
  namespaceSeparator: false,

  // Context separator
  contextSeparator: '_',

  // Plural separator
  pluralSeparator: '_'
}
