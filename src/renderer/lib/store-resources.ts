/**
 * Session-shared store resources whose caches must be invalidated from the
 * store layer (after a store refresh) as well as read from the renderer hooks.
 *
 * They live here — below both stores and hooks — so `apps-page.store` can drop
 * the caches without importing the UI-layer hooks (which would invert the
 * hooks-above-stores dependency). The `useX` hooks in `hooks/` are thin readers
 * over these resources.
 */

import { createCachedResource } from './cached-resource'
import { api } from '../api'
import { BUILTIN_DISCOVER_LAYOUT, BUILTIN_CATEGORY_TAXONOMY } from '../../shared/store/store-types'
import type { DiscoverLayout, CategoryTaxonomy, StoreCollection } from '../../shared/store/store-types'

async function fetchLayout(): Promise<DiscoverLayout> {
  try {
    const res = await api.storeGetDiscoverLayout()
    if (res.success && res.data && Array.isArray((res.data as DiscoverLayout).nodes)) {
      const layout = res.data as DiscoverLayout
      if (layout.nodes.length > 0) return layout
    }
    return BUILTIN_DISCOVER_LAYOUT
  } catch (error) {
    console.error('[store-resources] discover layout fetch failed, using built-in:', error)
    return BUILTIN_DISCOVER_LAYOUT
  }
}

async function fetchTaxonomy(): Promise<CategoryTaxonomy> {
  try {
    const res = await api.storeGetCategoryTaxonomy()
    if (res.success && res.data && Array.isArray((res.data as CategoryTaxonomy).default)) {
      return res.data as CategoryTaxonomy
    }
    return BUILTIN_CATEGORY_TAXONOMY
  } catch (error) {
    console.error('[store-resources] category taxonomy fetch failed, using built-in:', error)
    return BUILTIN_CATEGORY_TAXONOMY
  }
}

async function fetchCollections(): Promise<StoreCollection[]> {
  try {
    const res = await api.storeGetCollections()
    return res.success ? ((res.data as StoreCollection[]) ?? []) : []
  } catch {
    return []
  }
}

export const discoverLayoutResource = createCachedResource(fetchLayout)
export const categoryTaxonomyResource = createCachedResource(fetchTaxonomy)
export const storeCollectionsResource = createCachedResource(fetchCollections)
