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
import i18n, { getCurrentLanguage } from '../i18n'
import { BUILTIN_CATEGORY_TAXONOMY } from '../../shared/store/store-types'
import type { CategoryTaxonomy, ResolvedDiscover } from '../../shared/store/store-types'

/**
 * The whole discover page in one call: the main process resolves every
 * section against the full index mirror, so rankings are not scored over the
 * browse list's current page. Null when it cannot be resolved, which leaves the
 * page to render nothing rather than a half-built layout.
 */
async function fetchDiscoverPage(): Promise<ResolvedDiscover | null> {
  try {
    const res = await api.storeGetDiscoverPage({ locale: getCurrentLanguage() })
    return res.success && res.data ? (res.data as ResolvedDiscover) : null
  } catch (error) {
    console.error('[store-resources] discover page fetch failed:', error)
    return null
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

export const discoverPageResource = createCachedResource<ResolvedDiscover | null | undefined>(fetchDiscoverPage)

// Entries are localized by the request, so a language switch invalidates them.
i18n.on('languageChanged', () => discoverPageResource.invalidate())
export const categoryTaxonomyResource = createCachedResource(fetchTaxonomy)
