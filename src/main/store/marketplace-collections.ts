/**
 * Scene collections — curated cross-type app bundles served by the
 * store backend's public `GET /collections` endpoint. Unauthenticated; absent
 * on static/community sources, in which case the discover page simply omits the
 * collections block.
 */

import { getOfficialRegistryUrl } from './registry.service'
import { fetchWithTimeout } from './adapters/halo.adapter'
import type { StoreCollection } from '../../shared/store/store-types'

export async function fetchCollections(): Promise<StoreCollection[]> {
  const base = getOfficialRegistryUrl()
  if (!base) return []
  try {
    const res = await fetchWithTimeout(`${base}/collections`, { headers: { Accept: 'application/json' } })
    if (!res.ok) return []
    const body = (await res.json()) as { collections?: unknown[] }
    return (body.collections ?? []).map(mapCollection).filter(c => c.memberSlugs.length > 0)
  } catch (error) {
    console.warn('[MarketplaceCollections] fetch failed:', (error as Error).message)
    return []
  }
}

function mapCollection(raw: unknown): StoreCollection {
  const c = (raw ?? {}) as Record<string, unknown>
  const members = Array.isArray(c.member_slugs) ? c.member_slugs.filter((s): s is string => typeof s === 'string') : []
  return {
    id: String(c.id ?? ''),
    label: typeof c.label === 'string' ? c.label : '',
    name: String(c.name ?? ''),
    description: typeof c.description === 'string' ? c.description : '',
    memberSlugs: members,
  }
}
