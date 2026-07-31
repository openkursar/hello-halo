/**
 * Discover-page layout — the single resolution point for which sections the
 * discover page shows, how they are arranged, and what each queries.
 *
 * Resolution: `server ?? built-in`.
 *   - server   : an ops-managed layout served by the official registry at
 *                `<registry>/discover-layout.json`. Cached with a TTL.
 *   - built-in : a single paginated catalog (community/no-config fallback).
 *
 * The layout only carries composition + queries; the actual entries are
 * resolved client-side against the already-synced index. The payload is
 * untrusted, so its shape is validated here before use.
 */

import { getOfficialRegistryUrl } from './registry.service'
import { fetchWithTimeout } from './adapters/halo.adapter'
import { BUILTIN_DISCOVER_LAYOUT } from '../../shared/store/store-types'
import type {
  DiscoverLayout,
  DiscoverNode,
  DiscoverNodeType,
  DiscoverLayoutKind,
  DiscoverSortKind,
  DiscoverSource,
  LocaleText,
} from '../../shared/store/store-types'
import type { AppType } from '../../shared/apps/spec-types'

const SERVER_LAYOUT_PATH = '/discover-layout.json'
const SERVER_LAYOUT_TTL_MS = 5 * 60_000
const SERVER_LAYOUT_ERROR_TTL_MS = 30_000

let serverCache: { value: DiscoverLayout | null; expiresAt: number } | null = null

/**
 * Resolve the effective discover layout. Async because the server tier is a
 * network fetch; the result is TTL-cached so repeated reads cost nothing.
 */
export async function getDiscoverLayout(): Promise<DiscoverLayout> {
  return (await fetchServerLayout()) ?? BUILTIN_DISCOVER_LAYOUT
}

/** Drop the cached server payload so the next resolve refetches (on refresh). */
export function invalidateDiscoverLayoutCache(): void {
  serverCache = null
}

async function fetchServerLayout(): Promise<DiscoverLayout | null> {
  const now = Date.now()
  if (serverCache && serverCache.expiresAt > now) return serverCache.value

  const baseUrl = getOfficialRegistryUrl()
  if (!baseUrl) {
    serverCache = { value: null, expiresAt: now + SERVER_LAYOUT_TTL_MS }
    return null
  }

  try {
    const res = await fetchWithTimeout(`${baseUrl}${SERVER_LAYOUT_PATH}`, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Halo-Store/1.0' },
    })
    if (res.status === 404) {
      serverCache = { value: null, expiresAt: now + SERVER_LAYOUT_TTL_MS }
      return null
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const value = validateLayout(await res.json() as DiscoverLayout)
    serverCache = { value, expiresAt: now + SERVER_LAYOUT_TTL_MS }
    return value
  } catch (error) {
    console.warn(`[marketplace-discover] server fetch failed, using cached/fallback: ${(error as Error).message}`)
    serverCache = { value: serverCache?.value ?? null, expiresAt: now + SERVER_LAYOUT_ERROR_TTL_MS }
    return serverCache.value
  }
}

/**
 * Accept a layout only when it carries at least one well-formed node. The
 * payload is untrusted, so every node is validated element-by-element here
 * rather than trusting the renderer to tolerate malformed elements — a single
 * null/garbage node would otherwise crash the whole discover tab.
 */
function validateLayout(raw: DiscoverLayout | undefined): DiscoverLayout | null {
  if (!raw || typeof raw !== 'object') return null
  const nodes = cleanNodes(raw.nodes)
  if (nodes.length === 0) return null
  return { version: typeof raw.version === 'number' ? raw.version : 1, nodes }
}

const NODE_TYPES: readonly DiscoverNodeType[] = ['row', 'section', 'catalog']
const LAYOUT_KINDS: readonly DiscoverLayoutKind[] = ['card_grid', 'featured', 'rank_board', 'collections']
const SORT_KINDS: readonly DiscoverSortKind[] = ['installs', 'recent', 'name', 'manual']

/** Keep only well-formed nodes, recursively; drop anything unrecognized. */
function cleanNodes(raw: unknown): DiscoverNode[] {
  if (!Array.isArray(raw)) return []
  const out: DiscoverNode[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    if (typeof r.type !== 'string' || !NODE_TYPES.includes(r.type as DiscoverNodeType)) continue
    const node: DiscoverNode = { type: r.type as DiscoverNodeType }
    if (typeof r.layout === 'string' && LAYOUT_KINDS.includes(r.layout as DiscoverLayoutKind)) {
      node.layout = r.layout as DiscoverLayoutKind
    }
    const title = normalizeLocaleText(r.title)
    if (title) node.title = title
    const subtitle = normalizeLocaleText(r.subtitle)
    if (subtitle) node.subtitle = subtitle
    const source = cleanSource(r.source)
    if (source) node.source = source
    if (typeof r.columns === 'number') node.columns = r.columns
    if (Array.isArray(r.children)) node.children = cleanNodes(r.children)
    if (r.hidden === true) node.hidden = true
    out.push(node)
  }
  return out
}

/**
 * Normalize a LocaleText field. The wire form may be the canonical per-locale
 * map or a bare string; a bare string becomes `{ default }` so resolveLocaleText
 * does not fall through to `Object.values(text)[0]` and render a single letter.
 */
function normalizeLocaleText(raw: unknown): LocaleText | undefined {
  if (typeof raw === 'string') return raw ? { default: raw } : undefined
  if (raw && typeof raw === 'object') {
    const out: LocaleText = {}
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v
    }
    return Object.keys(out).length > 0 ? out : undefined
  }
  return undefined
}

/** Keep only array/scalar source fields of the right type, so the client-side
 * resolver never calls `.map`/`.includes` on a non-array the server sent. */
function cleanSource(raw: unknown): DiscoverSource | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const src: DiscoverSource = {}
  if (r.featured === true) src.featured = true
  if (Array.isArray(r.types)) src.types = r.types.filter((t): t is AppType => typeof t === 'string') as AppType[]
  if (Array.isArray(r.categories)) src.categories = r.categories.filter((c): c is string => typeof c === 'string')
  if (Array.isArray(r.tags)) src.tags = r.tags.filter((t): t is string => typeof t === 'string')
  if (Array.isArray(r.slugs)) src.slugs = r.slugs.filter((s): s is string => typeof s === 'string')
  if (typeof r.sort === 'string' && SORT_KINDS.includes(r.sort as DiscoverSortKind)) src.sort = r.sort as DiscoverSortKind
  if (typeof r.limit === 'number') src.limit = r.limit
  return src
}
