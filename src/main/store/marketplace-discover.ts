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
import type { DiscoverLayout } from '../../shared/store/store-types'

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
 * Accept a layout only when it carries at least one node. An empty layout (admin
 * present but unconfigured) resolves to null → built-in fallback. Node-level
 * validity is enforced by the renderer, which skips unknown kinds.
 */
function validateLayout(raw: DiscoverLayout | undefined): DiscoverLayout | null {
  if (!raw || typeof raw !== 'object') return null
  if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) return null
  return { version: typeof raw.version === 'number' ? raw.version : 1, nodes: raw.nodes }
}
