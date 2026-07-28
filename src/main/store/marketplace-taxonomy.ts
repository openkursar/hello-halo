/**
 * Marketplace category taxonomy — the single resolution point for the scene
 * categories shown as store chips and offered in the publish form.
 *
 * Resolution chain: `server ?? product.json ?? built-in`.
 *   - server      : an ops-managed enum served by the official registry at
 *                   `<registry>/category-taxonomy.json`. Cached with a TTL so
 *                   chips/publish stay fresh without hammering the network.
 *   - product.json: a no-server deployment's static customization.
 *   - built-in    : the community fallback, unchanged when nothing else applies.
 *
 * Both the server payload and product.json are untrusted, so their shape is
 * validated here before use; anything malformed is dropped and the chain falls
 * through to the next tier.
 */

import { getMarketplaceCategoriesConfig } from '../foundation/product-config'
import { BUILTIN_CATEGORY_TAXONOMY } from '../../shared/store/store-types'
import { getOfficialRegistryUrl } from './registry.service'
import { fetchWithTimeout } from './adapters/halo.adapter'
import type { AppType } from '../../shared/apps/spec-types'
import type { CategoryDef, CategoryTaxonomy } from '../../shared/store/store-types'

const TYPED_KEYS: AppType[] = ['automation', 'skill', 'mcp']

/** Path served by the official registry for the ops-managed taxonomy. */
const SERVER_TAXONOMY_PATH = '/category-taxonomy.json'

/** How long a resolved server payload (or its absence) is trusted before refetch. */
const SERVER_TAXONOMY_TTL_MS = 5 * 60_000

/** Shorter window after a network error so a transient failure self-heals soon. */
const SERVER_TAXONOMY_ERROR_TTL_MS = 30_000

let serverCache: { value: CategoryTaxonomy | null; expiresAt: number } | null = null

/**
 * Resolve the effective category taxonomy. Async because the server tier is a
 * network fetch; the result is TTL-cached so repeated reads within a window
 * cost nothing.
 */
export async function getCategoryTaxonomy(): Promise<CategoryTaxonomy> {
  return (
    (await fetchServerTaxonomy()) ??
    validateTaxonomy(getMarketplaceCategoriesConfig()) ??
    BUILTIN_CATEGORY_TAXONOMY
  )
}

/**
 * Drop the cached server payload so the next resolve refetches. Called when the
 * user refreshes the store — an operator's taxonomy edit then shows without a
 * client restart.
 */
export function invalidateServerTaxonomyCache(): void {
  serverCache = null
}

/**
 * Fetch and validate the ops-managed taxonomy from the official registry.
 * Returns null (→ fall through to product.json/built-in) when no official
 * registry is configured, the file is absent, or the payload is malformed. On a
 * network error the last good value is retained rather than dropping to fallback.
 */
async function fetchServerTaxonomy(): Promise<CategoryTaxonomy | null> {
  const now = Date.now()
  if (serverCache && serverCache.expiresAt > now) return serverCache.value

  const baseUrl = getOfficialRegistryUrl()
  if (!baseUrl) {
    serverCache = { value: null, expiresAt: now + SERVER_TAXONOMY_TTL_MS }
    return null
  }

  try {
    const res = await fetchWithTimeout(`${baseUrl}${SERVER_TAXONOMY_PATH}`, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Halo-Store/1.0' },
    })
    if (res.status === 404) {
      serverCache = { value: null, expiresAt: now + SERVER_TAXONOMY_TTL_MS }
      return null
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const value = validateTaxonomy(await res.json() as CategoryTaxonomy)
    serverCache = { value, expiresAt: now + SERVER_TAXONOMY_TTL_MS }
    return value
  } catch (error) {
    console.warn(`[marketplace-taxonomy] server fetch failed, using cached/fallback: ${(error as Error).message}`)
    serverCache = { value: serverCache?.value ?? null, expiresAt: now + SERVER_TAXONOMY_ERROR_TTL_MS }
    return serverCache.value
  }
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
