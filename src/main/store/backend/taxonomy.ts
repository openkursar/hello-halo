/**
 * Store category taxonomy — the single resolution point for the scene
 * categories shown as store chips and offered in the publish form.
 *
 * Resolution chain: `server ?? product.json ?? built-in`.
 *   - server      : an ops-managed enum served by the primary source.
 *   - product.json: a no-server deployment's static customization.
 *   - built-in    : the community fallback, unchanged when nothing else applies.
 *
 * Both the server payload and product.json are untrusted, so their shape is
 * validated here before use; anything malformed is dropped and the chain falls
 * through to the next tier.
 */

import { getStoreCategoriesConfig } from '../../foundation/product-config'
import { BUILTIN_CATEGORY_TAXONOMY } from '../../../shared/store/store-types'
import { createPageDocumentResolver } from './sources'
import type { AppType } from '../../../shared/apps/spec-types'
import type { CategoryDef, CategoryTaxonomy } from '../../../shared/store/store-types'

const TYPED_KEYS: AppType[] = ['automation', 'skill', 'mcp']

const serverTaxonomy = createPageDocumentResolver(
  'store/taxonomy',
  'fetchPageTaxonomy',
  raw => validateTaxonomy(raw as CategoryTaxonomy),
)

/**
 * Resolve the effective category taxonomy. Async because the server tier is a
 * network fetch; the result is TTL-cached so repeated reads within a window
 * cost nothing.
 */
export async function getCategoryTaxonomy(): Promise<CategoryTaxonomy> {
  return (
    (await serverTaxonomy.get()) ??
    validateTaxonomy(getStoreCategoriesConfig()) ??
    BUILTIN_CATEGORY_TAXONOMY
  )
}

/**
 * Drop the cached server payload so the next resolve refetches. Called when the
 * user refreshes the store — an operator's taxonomy edit then shows without a
 * client restart.
 */
export function invalidateServerTaxonomyCache(): void {
  serverTaxonomy.invalidate()
}

/**
 * Accept a config taxonomy only when it carries a usable `default` list; per-type
 * lists are optional. Returns null (→ built-in fallback) on any malformed input.
 */
function validateTaxonomy(raw: CategoryTaxonomy | undefined): CategoryTaxonomy | null {
  if (!raw || typeof raw !== 'object') return null
  const def = cleanList(raw.default)
  if (!def) return null

  const result: CategoryTaxonomy = { default: def }
  for (const key of TYPED_KEYS) {
    const list = cleanList(raw[key])
    if (list) result[key] = list
  }
  return result
}

function cleanList(raw: unknown): CategoryDef[] | null {
  if (!Array.isArray(raw)) return null
  const out: CategoryDef[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const { id, label, labelKey, icon } = item as Record<string, unknown>
    if (typeof id !== 'string' || !id.trim()) continue
    const def: CategoryDef = { id: id.trim() }
    if (typeof label === 'string') def.label = label
    if (typeof labelKey === 'string') def.labelKey = labelKey
    if (typeof icon === 'string') def.icon = icon
    out.push(def)
  }
  return out.length > 0 ? out : null
}
