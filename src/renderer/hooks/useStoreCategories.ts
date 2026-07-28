/**
 * useStoreCategories — resolves the effective scene-category list for a store
 * type tab.
 *
 * The taxonomy is resolved in the main process (`server ?? product.json ?? built-in`,
 * see marketplace-taxonomy.ts) and fetched once per session, cached in a shared
 * module-level promise. Until it loads — or if it fails — the built-in set is
 * used, so chips render immediately without a flash of empty state.
 *
 * The returned list always ends with the fixed "other" bucket (FR-2.2), so
 * callers render 「All」 + list without special-casing the catch-all.
 */

import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
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

let cached: Promise<CategoryTaxonomy> | null = null
const reloadListeners = new Set<() => void>()

/**
 * Drop the session cache and re-fetch, pushing the fresh taxonomy into every
 * mounted consumer. Called after a store refresh so an operator's edit to the
 * server taxonomy reaches the chips/publish form without a client restart.
 */
export function invalidateCategoryTaxonomyCache(): void {
  cached = null
  reloadListeners.forEach((reload) => reload())
}

function useCategoryTaxonomy(): CategoryTaxonomy {
  const [taxonomy, setTaxonomy] = useState<CategoryTaxonomy>(BUILTIN_CATEGORY_TAXONOMY)

  useEffect(() => {
    let cancelled = false
    const reload = () => {
      if (!cached) cached = fetchTaxonomy()
      cached.then((value) => {
        if (!cancelled) setTaxonomy(value)
      })
    }
    reload()
    reloadListeners.add(reload)
    return () => {
      cancelled = true
      reloadListeners.delete(reload)
    }
  }, [])

  return taxonomy
}

async function fetchTaxonomy(): Promise<CategoryTaxonomy> {
  try {
    const res = await api.storeGetCategoryTaxonomy()
    if (res.success && res.data && Array.isArray((res.data as CategoryTaxonomy).default)) {
      return res.data as CategoryTaxonomy
    }
    return BUILTIN_CATEGORY_TAXONOMY
  } catch (error) {
    console.error('[useStoreCategories] Fetch failed, using built-in taxonomy:', error)
    return BUILTIN_CATEGORY_TAXONOMY
  }
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
