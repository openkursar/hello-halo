/**
 * MCP Official Registry Adapter (Proxy Mode)
 *
 * Fetches from https://registry.modelcontextprotocol.io
 * API: GET /v0/servers?q=...&cursor=...  (cursor-based pagination, 30 per page)
 *
 * Proxy strategy: queries are forwarded on demand, one page at a time.
 * No full-index download.
 */

import { fetchWithTimeout } from './halo.adapter'
import type { RegistrySource, RegistryEntry, StoreCategory, StoreQueryParams } from '../../../shared/store/store-types'
import type { AppSpec, McpSpec } from '../../apps/spec/schema'
import type { RegistryAdapter, AdapterQueryResult } from './types'

/**
 * The registry carries no category of its own, so every server lands in one
 * Halo bucket. Labelling and filtering both read this constant, so they cannot
 * drift apart (see the `query` contract in `adapters/types.ts`).
 */
const SERVED_CATEGORY: StoreCategory = 'dev-tools'

// ── External API types ─────────────────────────────────────────────────────

interface McpServerRecord {
  name: string
  description?: string
  version?: string
  repository?: { url?: string; source?: string }
  packages?: Array<{ registryType?: string; identifier?: string; transport?: string }>
}

interface McpServerMeta {
  'io.modelcontextprotocol.registry/official'?: {
    status?: string
    publishedAt?: string
    updatedAt?: string
    isLatest?: boolean
  }
}

interface McpServerItem {
  server: McpServerRecord
  _meta?: McpServerMeta
}

interface McpServersResponse {
  servers: McpServerItem[]
  metadata?: { nextCursor?: string; count?: number }
}

// ── Adapter ────────────────────────────────────────────────────────────────

export class McpRegistryAdapter implements RegistryAdapter {
  readonly strategy = 'proxy' as const

  /**
   * Cursor-based pagination mapping:
   * MCP API uses cursor pagination, but our StoreQueryParams uses page numbers.
   * We maintain a per-query cursor cache to support page > 1.
   *
   * Bounded to MAX_CURSOR_CACHE entries (oldest-first eviction via Map insertion order).
   */
  private static readonly MAX_CURSOR_CACHE = 200
  private cursorCache = new Map<string, string>()

  async query(source: RegistrySource, params: StoreQueryParams): Promise<AdapterQueryResult> {
    if (params.category && params.category !== SERVED_CATEGORY) {
      return { items: [], total: 0, hasMore: false }
    }

    const baseUrl = source.url.replace(/\/+$/, '')
    const t0 = performance.now()

    // Build URL with search query
    let url = `${baseUrl}/v0/servers`
    const qsParts: string[] = []
    if (params.search) {
      qsParts.push(`q=${encodeURIComponent(params.search)}`)
    }

    // For page > 1, we need the cursor from the previous page
    if (params.page > 1) {
      const cacheKey = `${source.id}:${params.search ?? ''}:${params.page}`
      const cursor = this.cursorCache.get(cacheKey)
      if (cursor) {
        qsParts.push(`cursor=${encodeURIComponent(cursor)}`)
      }
    }

    if (qsParts.length > 0) {
      url += '?' + qsParts.join('&')
    }

    const response = await fetchWithTimeout(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Halo-Store/1.0' },
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    const data = await response.json() as McpServersResponse
    const nextCursor = data.metadata?.nextCursor || undefined

    // Cache cursor for next page (evict oldest entry when limit is reached)
    if (nextCursor) {
      const nextCacheKey = `${source.id}:${params.search ?? ''}:${params.page + 1}`
      if (this.cursorCache.size >= McpRegistryAdapter.MAX_CURSOR_CACHE) {
        const firstKey = this.cursorCache.keys().next().value
        if (firstKey !== undefined) this.cursorCache.delete(firstKey)
      }
      this.cursorCache.set(nextCacheKey, nextCursor)
    }

    const items = mapServerItems(data.servers ?? [])

    const dt = performance.now() - t0
    console.log(`[McpRegistryAdapter] query: ${items.length} results (${dt.toFixed(0)}ms)`)

    return {
      items,
      total: data.metadata?.count,
      hasMore: !!nextCursor,
    }
  }

  async fetchSpec(source: RegistrySource, entry: RegistryEntry): Promise<AppSpec> {
    return buildMinimalMcpSpec(entry, source.id)
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function mapServerItems(items: McpServerItem[]): RegistryEntry[] {
  const apps: RegistryEntry[] = []
  const seenSlugs = new Set<string>()

  for (const item of items) {
    const server = item.server
    if (!server?.name) continue

    const slug = sanitizeSlug(server.name)
    if (!slug || seenSlugs.has(slug)) continue
    seenSlugs.add(slug)

    const author = extractGithubOwner(server.repository?.url) ?? 'unknown'
    const meta = item._meta?.['io.modelcontextprotocol.registry/official']

    apps.push({
      slug,
      name: server.name,
      version: server.version ?? '1.0.0',
      author,
      description: server.description ?? server.name,
      type: 'mcp',
      format: 'bundle',
      path: server.name,
      category: SERVED_CATEGORY,
      tags: [],
      created_at: meta?.publishedAt,
      updated_at: meta?.updatedAt,
      meta: {
        packages: server.packages ?? [],
        repository: server.repository?.url,
      },
    })
  }

  return apps
}

function buildMinimalMcpSpec(entry: RegistryEntry, registryId: string): McpSpec {
  const packages = (entry.meta?.packages as Array<Record<string, unknown>> | undefined) ?? []
  const pkg = packages[0]

  return {
    spec_version: '1',
    name: entry.name,
    type: 'mcp',
    version: entry.version,
    description: entry.description,
    author: entry.author,
    mcp_server: {
      transport: 'stdio',
      command: resolveCommand(pkg),
      args: resolveArgs(pkg),
    },
    store: {
      slug: entry.slug,
      registry_id: registryId,
    },
  }
}

function resolveCommand(pkg?: Record<string, unknown>): string {
  if (!pkg) return 'npx'
  const registryType = pkg.registryType as string | undefined
  if (registryType === 'npm') return 'npx'
  if (registryType === 'pip' || registryType === 'pypi') return 'uvx'
  if (registryType === 'docker') return 'docker'
  return 'npx'
}

function resolveArgs(pkg?: Record<string, unknown>): string[] {
  if (!pkg) return []
  const identifier = pkg.identifier as string | undefined
  if (!identifier) return []
  const registryType = pkg.registryType as string | undefined
  if (registryType === 'docker') return ['run', '--rm', '-i', identifier]
  return [identifier]
}

/**
 * Sanitize a server name into a valid slug.
 */
export function sanitizeSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

function extractGithubOwner(url?: string): string | undefined {
  if (!url) return undefined
  try {
    const parsed = new URL(url)
    if (parsed.hostname === 'github.com') {
      const parts = parsed.pathname.split('/').filter(Boolean)
      return parts[0]
    }
  } catch {
    // ignore
  }
  return undefined
}