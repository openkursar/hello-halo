/**
 * Assembles the discover page: the operator's layout with every section's data
 * already resolved, returned in one payload.
 *
 * Resolution happens here rather than in the renderer because this process owns
 * the full index mirror. The browse list the renderer holds is paginated — and
 * its "All" tab is only a per-type preview — so a section ranked or filtered
 * against it would silently score over a fraction of the catalog.
 *
 * The catalog node deliberately goes through the same browse query the renderer
 * uses for later pages, so page 1 and page 2 cannot disagree on ordering.
 */

import { getDiscoverLayout } from './backend/discover'
import { fetchCollections } from './backend/collections'
import { listApps, queryStore } from './registry.service'
import { resolveSection } from '../../shared/store/discover-resolve'
import { BUILTIN_DISCOVER_LAYOUT } from '../../shared/store/store-types'
import type {
  DiscoverNode,
  RegistryEntry,
  ResolvedDiscover,
  ResolvedDiscoverNode,
  StoreCollection,
  StoreQueryResponse,
} from '../../shared/store/store-types'
import type { AppType } from '../apps/spec/schema'

const INDEX_TYPES: AppType[] = ['automation', 'skill', 'mcp']

export async function getDiscoverPage(locale: string, pageSize: number): Promise<ResolvedDiscover> {
  const layout = await settled('layout', () => getDiscoverLayout(), BUILTIN_DISCOVER_LAYOUT)
  const needsCollections = layout.nodes.some(hasCollectionsSection)

  const [entries, collections, catalog] = await Promise.all([
    loadAllEntries(locale),
    needsCollections ? settled('collections', () => fetchCollections(), [] as StoreCollection[]) : Promise.resolve<StoreCollection[]>([]),
    settled('catalog', () => queryStore({ page: 1, pageSize, locale }), EMPTY_CATALOG),
  ])

  const nodes = resolveNodes(layout.nodes, { entries, collections, catalog })
  // A layout that resolves to nothing — an unreachable index, or one whose
  // sections all came back empty — would otherwise render as a blank store.
  return {
    version: layout.version,
    nodes: nodes.length > 0 ? nodes : [{ type: 'catalog', entries: catalog.items, hasMore: catalog.hasMore }],
  }
}

const EMPTY_CATALOG: StoreQueryResponse = { items: [], hasMore: false, sources: [] }

/**
 * Degrade one part rather than the page. A section whose data is missing simply
 * drops out; losing the whole payload to a single failing query would take the
 * store down with it.
 */
async function settled<T>(what: string, run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run()
  } catch (error) {
    console.warn(`[discover-page] ${what} unavailable: ${(error as Error).message}`)
    return fallback
  }
}

/**
 * Every mirrored entry. Queried per type because a typeless browse query is a
 * capped per-type preview, which would defeat the point of resolving here.
 */
async function loadAllEntries(locale: string): Promise<RegistryEntry[]> {
  const perType = await Promise.all(
    INDEX_TYPES.map(type => settled(`index:${type}`, () => listApps({ type, locale }), [] as RegistryEntry[])),
  )
  return perType.flat()
}

interface ResolveContext {
  entries: RegistryEntry[]
  collections: StoreCollection[]
  catalog: StoreQueryResponse
}

function resolveNodes(nodes: DiscoverNode[], ctx: ResolveContext): ResolvedDiscoverNode[] {
  const out: ResolvedDiscoverNode[] = []
  for (const node of nodes) {
    if (node.hidden) continue
    const resolved = resolveNode(node, ctx)
    if (resolved) out.push(resolved)
  }
  return out
}

/** Null when the node has nothing to render, so the renderer never has to
 * decide whether a heading should be suppressed. */
function resolveNode(node: DiscoverNode, ctx: ResolveContext): ResolvedDiscoverNode | null {
  const base: ResolvedDiscoverNode = {
    type: node.type,
    ...(node.layout ? { layout: node.layout } : {}),
    ...(node.title ? { title: node.title } : {}),
    ...(node.subtitle ? { subtitle: node.subtitle } : {}),
  }

  if (node.type === 'catalog') {
    return { ...base, entries: ctx.catalog.items, hasMore: ctx.catalog.hasMore }
  }

  if (node.type === 'row') {
    const children = resolveNodes(node.children ?? [], ctx)
    if (children.length === 0) return null
    return { ...base, columns: node.columns, children }
  }

  if (node.layout === 'collections') {
    return ctx.collections.length > 0 ? { ...base, collections: ctx.collections } : null
  }

  const entries = resolveSection(node.source, ctx.entries)
  return entries.length > 0 ? { ...base, entries } : null
}

function hasCollectionsSection(node: DiscoverNode): boolean {
  if (node.layout === 'collections') return true
  return (node.children ?? []).some(hasCollectionsSection)
}
