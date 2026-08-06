/**
 * Spec i18n Resolution Utilities
 *
 * Resolves locale-specific display text from AppSpec and RegistryEntry i18n blocks.
 *
 * Resolution priority (first match wins):
 *   1. Exact locale match       — e.g. "zh-CN" for user locale "zh-CN"
 *   2. Language-prefix match    — e.g. "zh-CN" for user locale "zh-TW" (shared zh-* block)
 *   3. Locale-agnostic display  — `display_name`, carried by specs whose canonical
 *                                 `name` is an identifier rather than a display string
 *   4. Canonical fallback       — the top-level name/description/config_schema fields
 *
 * Only display text is resolved here. system_prompt, store metadata, subscriptions,
 * and all runtime behavior are never affected by i18n.
 */

import type { AppSpec, I18nLocaleBlock, InputDef, BrowserLoginEntry } from '../../shared/apps/spec-types'
import type { RegistryEntry } from '../../shared/store/store-types'

// ============================================
// Internal helpers
// ============================================

/**
 * Find the best matching locale block for the given BCP 47 locale code.
 * Returns undefined when no match exists (caller falls back to canonical).
 */
function findLocaleBlock(
  i18n: Record<string, I18nLocaleBlock> | undefined,
  locale: string
): I18nLocaleBlock | undefined {
  if (!i18n) return undefined

  // 1. Exact match — "zh-CN" matches "zh-CN"
  if (i18n[locale]) return i18n[locale]

  // 2. Language-prefix match — "zh" matches "zh-CN", "zh-TW", etc.
  //    Find the first block whose key starts with the same language subtag.
  const prefix = locale.split('-')[0]
  const matchKey = Object.keys(i18n).find(
    (k) => k === prefix || k.startsWith(prefix + '-')
  )
  if (matchKey) return i18n[matchKey]

  return undefined
}

// ============================================
// AppSpec resolution
// ============================================

/**
 * Locale-resolved display fields extracted from an AppSpec.
 * config_schema items have their labels/descriptions/placeholders/option labels replaced
 * in-place (non-mutating — a new array with new objects is returned).
 */
export interface ResolvedSpecDisplay {
  name: string
  description: string
  /** Locale-resolved copy of config_schema, or undefined if the spec has none. */
  config_schema: InputDef[] | undefined
  /** Locale-resolved browser_login entries, or undefined if the spec has none. */
  browser_login: BrowserLoginEntry[] | undefined
}

/**
 * Resolve locale-specific display fields from an AppSpec.
 *
 * @param spec   The full AppSpec (may or may not contain an i18n block).
 * @param locale The user's current BCP 47 locale code (e.g. "zh-CN", "en", "ja").
 * @returns      Resolved name, description, and config_schema for UI rendering.
 *
 * @example
 * const { name, description, config_schema } = resolveSpecI18n(spec, getCurrentLanguage())
 */
export function resolveSpecI18n(spec: AppSpec, locale: string): ResolvedSpecDisplay {
  const block = findLocaleBlock(spec.i18n, locale)

  // Extract browser_login from automation specs
  const specBrowserLogin = spec.type === 'automation' ? spec.browser_login : undefined

  // No block for this locale — return canonical fields as-is (no copy overhead)
  if (!block) {
    return {
      name: spec.display_name ?? spec.name,
      description: spec.description,
      config_schema: spec.config_schema,
      browser_login: specBrowserLogin,
    }
  }

  // Apply config_schema field overrides (sparse — only listed keys are overridden)
  const config_schema = spec.config_schema?.map((field): InputDef => {
    const override = block.config_schema?.[field.key]
    if (!override) return field

    return {
      ...field,
      label: override.label ?? field.label,
      description: override.description ?? field.description,
      placeholder: override.placeholder ?? field.placeholder,
      // Merge translated option labels; unlisted options keep canonical labels
      options: field.options?.map((opt) => ({
        ...opt,
        label: override.options?.[String(opt.value)] ?? opt.label,
      })),
    }
  })

  // Apply browser_login label overrides (keyed by URL)
  const browser_login = specBrowserLogin?.map((entry): BrowserLoginEntry => {
    const override = block.browser_login?.[entry.url]
    if (!override) return entry
    return {
      ...entry,
      label: override.label ?? entry.label,
    }
  })

  return {
    name: block.name ?? spec.display_name ?? spec.name,
    description: block.description ?? spec.description,
    config_schema,
    browser_login,
  }
}

// ============================================
// RegistryEntry resolution (store listing)
// ============================================

/**
 * Locale-resolved name and description from a RegistryEntry.
 * Only name and description are available at the index level; full config_schema
 * overrides require fetching the complete spec (available via resolveSpecI18n).
 */
export interface ResolvedEntryDisplay {
  name: string
  description: string
}

/**
 * Resolve locale-specific name and description from a RegistryEntry.
 * Used in the store grid (StoreCard) and detail header (StoreDetail) where only
 * the index-level i18n summary is available.
 *
 * @param entry  A RegistryEntry from the fetched registry index.
 * @param locale The user's current BCP 47 locale code.
 * @returns      Resolved name and description for UI rendering.
 *
 * @example
 * const { name, description } = resolveEntryI18n(entry, getCurrentLanguage())
 */
export function resolveEntryI18n(entry: RegistryEntry, locale: string): ResolvedEntryDisplay {
  const i18n = entry.i18n
  const canonical = entry.display_name ?? entry.name
  if (!i18n) return { name: canonical, description: entry.description }

  // Find best locale block (same logic as findLocaleBlock, but typed differently
  // because RegistryEntry.i18n only carries name/description)
  let block: { name?: string; description?: string } | undefined = i18n[locale]

  if (!block) {
    const prefix = locale.split('-')[0]
    const matchKey = Object.keys(i18n).find(
      (k) => k === prefix || k.startsWith(prefix + '-')
    )
    if (matchKey) block = i18n[matchKey]
  }

  if (!block) return { name: canonical, description: entry.description }

  return {
    name: block.name ?? canonical,
    description: block.description ?? entry.description,
  }
}
