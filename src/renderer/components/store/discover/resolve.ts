/**
 * Pure resolution of a discover section against the already-synced index — no
 * network. A section's declarative `source` (filter + sort + limit, or an
 * explicit curated slug list) maps to the entries it displays; `LocaleText`
 * fields resolve to the current language with a `default` fallback.
 */

import { getEntryInstalls, isEntryFeatured } from '../../../../shared/store/store-meta'
import type { RegistryEntry, DiscoverSource, DiscoverSortKind, LocaleText } from '../../../../shared/store/store-types'

/** Resolve a per-language text to a display string for the current locale. */
export function resolveLocaleText(text: LocaleText | undefined, locale: string): string | undefined {
  if (!text) return undefined
  return text[locale] ?? text.default ?? Object.values(text)[0]
}

/** Filter → sort → limit the index for a section. Empty source ⇒ all apps. */
export function resolveSection(source: DiscoverSource | undefined, apps: RegistryEntry[]): RegistryEntry[] {
  const src = source ?? {}

  // A curated slug list is authoritative for both membership and order.
  if (src.slugs && src.slugs.length > 0) {
    const bySlug = new Map(apps.map(a => [a.slug, a]))
    const picked = src.slugs.map(s => bySlug.get(s)).filter((e): e is RegistryEntry => !!e)
    return applyLimit(sortEntries(picked, src.sort ?? 'manual', src.slugs), src.limit)
  }

  const filtered = apps.filter(a => matchesFilter(a, src))
  return applyLimit(sortEntries(filtered, src.sort), src.limit)
}

function matchesFilter(entry: RegistryEntry, src: DiscoverSource): boolean {
  if (src.featured && !isEntryFeatured(entry)) return false
  if (src.types && src.types.length > 0 && !src.types.includes(entry.type)) return false
  if (src.categories && src.categories.length > 0 && !src.categories.includes(entry.category)) return false
  if (src.tags && src.tags.length > 0) {
    const tags = entry.tags ?? []
    if (!src.tags.some(t => tags.includes(t))) return false
  }
  return true
}

function sortEntries(list: RegistryEntry[], sort: DiscoverSortKind | undefined, manualOrder?: string[]): RegistryEntry[] {
  const out = [...list]
  switch (sort) {
    case 'installs':
      return out.sort((a, b) => (getEntryInstalls(b) ?? 0) - (getEntryInstalls(a) ?? 0))
    case 'name':
      return out.sort((a, b) => a.name.localeCompare(b.name))
    case 'recent':
      return out.sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))
    case 'manual':
      if (manualOrder) {
        const rank = new Map(manualOrder.map((s, i) => [s, i]))
        return out.sort((a, b) => (rank.get(a.slug) ?? 0) - (rank.get(b.slug) ?? 0))
      }
      return out
    default:
      return out
  }
}

function applyLimit(list: RegistryEntry[], limit: number | undefined): RegistryEntry[] {
  return limit && limit > 0 ? list.slice(0, limit) : list
}
