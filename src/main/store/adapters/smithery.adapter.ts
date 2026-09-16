/**
 * Smithery Adapter (Proxy Mode)
 *
 * Fetches from https://registry.smithery.ai
 * API: GET /servers?q=...&page=N&pageSize=50  (page-based pagination)
 * Auth: optional Bearer token in adapterConfig.apiKey
 *
 * Proxy strategy: queries are forwarded on demand, one page at a time.
 */

import { fetchWithTimeout } from './halo.adapter'
import { sanitizeSlug } from './mcp-registry.adapter'
import type { RegistrySource, RegistryEntry, StoreCategory, StoreQueryParams } from '../../../shared/store/store-types'
import type { AppSpec, McpSpec } from '../../apps/spec/schema'
import type { RegistryAdapter, AdapterQueryResult } from './types'

/**
 * Smithery exposes no category of its own, so every server lands in one Halo
 * bucket. Labelling and filtering both read this constant, so they cannot drift
 * apart (see the `query` contract in `adapters/types.ts`).
 */
const SERVED_CATEGORY: StoreCategory = 'dev-tools'

// ── External API types ─────────────────────────────────────────────────────

interface SmitheryServer {
  qualifiedName: string
  displayName?: string
  description?: string
  verified?: boolean
  useCount?: number
  remote?: boolean
  homepage?: string
}

interface SmitheryResponse {
  servers: SmitheryServer[]
  pagination?: {
    currentPage: number
    pageSize: number
    totalPages: number
    totalCount: number
  }
}

// ── Adapter ────────────────────────────────────────────────────────────────

export class SmitheryAdapter implements RegistryAdapter {
  readonly strategy = 'proxy' as const

  async query(source: RegistrySource, params: StoreQueryParams): Promise<AdapterQueryResult> {
    if (params.category && params.category !== SERVED_CATEGORY) {
      return { items: [], total: 0, hasMore: false }
    }

    const apiKey = source.adapterConfig?.apiKey as string | undefined
    const baseUrl = source.url.replace(/\/+$/, '')
    const pageSize = params.pageSize || 50
    const t0 = performance.now()

    const url = `${baseUrl}/servers?q=${encodeURIComponent(params.search ?? '')}&page=${params.page}&pageSize=${pageSize}`
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'User-Agent': 'Halo-Store/1.0',
    }
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`
    }

    const response = await fetchWithTimeout(url, { headers })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const data = await response.json() as SmitheryResponse
    const items = mapSmitheryServers(data.servers ?? [])
    const totalPages = data.pagination?.totalPages ?? 1
    const totalCount = data.pagination?.totalCount

    const dt = performance.now() - t0
    console.log(`[SmitheryAdapter] query page ${params.page}/${totalPages}: ${items.length} results (${dt.toFixed(0)}ms)`)

    return {
      items,
      total: totalCount,
      hasMore: params.page < totalPages,
    }
  }

  async fetchSpec(source: RegistrySource, entry: RegistryEntry): Promise<AppSpec> {
    const spec: McpSpec = {
      spec_version: '1',
      name: entry.name,
      type: 'mcp',
      version: entry.version,
      description: entry.description,
      author: entry.author,
      mcp_server: {
        transport: 'stdio',
        command: 'npx',
        args: [entry.path],
      },
      store: {
        slug: entry.slug,
        registry_id: source.id,
      },
    }
    return spec
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function mapSmitheryServers(servers: SmitheryServer[]): RegistryEntry[] {
  const apps: RegistryEntry[] = []
  const seenSlugs = new Set<string>()

  for (const server of servers) {
    if (!server.qualifiedName) continue

    const parts = server.qualifiedName.split('/')
    const owner = parts[0] ?? 'unknown'
    const rawSlug = server.qualifiedName.replace('/', '-')
    const slug = sanitizeSlug(rawSlug)

    if (!slug || seenSlugs.has(slug)) continue
    seenSlugs.add(slug)

    apps.push({
      slug,
      name: server.displayName ?? server.qualifiedName,
      version: '1.0.0',
      author: owner,
      description: server.description ?? server.qualifiedName,
      type: 'mcp',
      format: 'bundle',
      path: server.qualifiedName,
      category: SERVED_CATEGORY,
      tags: [],
      meta: {
        rank: typeof server.useCount === 'number' ? server.useCount : undefined,
        verified: server.verified ?? false,
        remote: server.remote ?? false,
        homepage: server.homepage,
      },
    })
  }

  return apps
}
