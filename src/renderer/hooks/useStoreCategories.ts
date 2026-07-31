/**
 * useStoreCategories — resolves the effective scene-category list for a store
 * type tab.
 *
 * The taxonomy is resolved in the main process (`server ?? product.json ?? built-in`,
 * see marketplace-taxonomy.ts) and shared once per session (see lib/store-resources).
 * Until it loads — or if it fails — the built-in set is used, so chips render
 * immediately without a flash of empty state.
 *
 * The returned list always ends with the fixed "other" bucket, so callers render
 * "All" + list without special-casing the catch-all.
 */

import { useMemo } from 'react'
import { useTranslation } from '../i18n'
import { categoryTaxonomyResource } from '../lib/store-resources'
import type { AppType } from '../../shared/apps/spec-types'
import {
  BUILTIN_CATEGORY_TAXONOMY,
  CATEGORY_OTHER_ID,
  type CategoryDef,
  type CategoryTaxonomy,
} from '../../shared/store/store-types'

/** Effective category list for a type tab. `null` type yields the default list. */
export function useStoreCategories(type: AppType | null): CategoryDef[] {
  const taxonomy = useCategoryTaxonomy()
  return useMemo(() => resolveCategories(taxonomy, type), [taxonomy, type])
}

export function categoryDisplay(def: CategoryDef, t: (key: string) => string): string {
  const label = def.labelKey ? translateLabelKey(t, def.labelKey) : (def.label ?? def.id)
  return def.icon ? `${def.icon} ${label}` : label
}

/**
 * Resolve an entry's category id to its localized display label (icon + label),
 * falling back to the raw id for a legacy category absent from the taxonomy.
 * Returns undefined when the entry has no category. Lets card surfaces show the
 * same label as the chip bar instead of the raw id.
 */
export function useCategoryLabel(type: AppType | null, category: string | undefined): string | undefined {
  const categories = useStoreCategories(type)
  const { t } = useTranslation()
  return useMemo(() => {
    if (!category) return undefined
    const def = categories.find(c => c.id === category)
    return def ? categoryDisplay(def, t) : category
  }, [categories, category, t])
}

function useCategoryTaxonomy(): CategoryTaxonomy {
  return categoryTaxonomyResource.useValue(BUILTIN_CATEGORY_TAXONOMY)
}

function resolveCategories(taxonomy: CategoryTaxonomy, type: AppType | null): CategoryDef[] {
  const scoped = type ? taxonomy[type] : undefined
  return ensureOtherLast(scoped ?? taxonomy.default)
}

function ensureOtherLast(list: CategoryDef[]): CategoryDef[] {
  const rest = list.filter(c => c.id !== CATEGORY_OTHER_ID)
  const other = list.find(c => c.id === CATEGORY_OTHER_ID)
  return [...rest, other ?? { id: CATEGORY_OTHER_ID, labelKey: 'Other', icon: '📦' }]
}

/**
 * Translate a category `labelKey`. Built-in keys are listed as literal `t('...')`
 * calls so i18next-parser can extract them; server-supplied keys fall through to
 * the variable form (a missing key resolves to itself via i18next fallback).
 */
function translateLabelKey(t: (key: string) => string, labelKey: string): string {
  switch (labelKey) {
    case 'Shopping': return t('Shopping')
    case 'News': return t('News')
    case 'Content': return t('Content')
    case 'Dev Tools': return t('Dev Tools')
    case 'Productivity': return t('Productivity')
    case 'Data': return t('Data')
    case 'Social': return t('Social')
    case 'Other': return t('Other')
    default: return t(labelKey)
  }
}
