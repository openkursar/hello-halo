/**
 * Scene collections — curated cross-type app bundles.
 *
 * Federated: every enabled source whose driver serves collections contributes,
 * and the results merge. Sources without the endpoint (static/community) cost
 * zero requests. A genuine failure is NOT flattened into an empty list — that
 * would render a backend outage as "there are no collections".
 */

import { getRegistries } from '../registry.service'
import { getAdapter } from '../adapters'
import { aggregateAcrossSources } from './sources'
import type { StoreCollection } from '../../../shared/store/store-types'

export async function fetchCollections(): Promise<StoreCollection[]> {
  const sources = getRegistries().filter(r => r.enabled)
  const raw = await aggregateAcrossSources(
    'store/collections',
    sources,
    source => getAdapter(source).fetchCollections?.(source),
  )
  // An entry with no id cannot be addressed and one with no members has
  // nothing to show, so neither can render.
  return raw.map(mapCollection).filter(c => c.id !== '' && c.memberSlugs.length > 0)
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
