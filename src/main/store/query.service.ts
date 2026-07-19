/**
 * QueryService — Unified Store Query Entry Point
 *
 * Routes queries by data strategy:
 *   - Mirror sources → SQLite FTS5 search + LIMIT/OFFSET
 *   - Proxy sources  → adapter.query() with LRU result cache
 *   - All tab        → preview mode (grouped by type)
 *
 * Owns the query-cache and spec-cache tables.
 */

import type Database from 'better-sqlite3'
import type { DatabaseManager } from '../platform/store/types'
import type {
  RegistrySource,
  RegistryEntry,
  StoreQueryParams,
  StoreQueryResponse,
} from '../../shared/store/store-types'
import type { AppType } from '../../shared/apps/spec-types'
import type { AppSpec } from '../apps/spec/schema'
import { getAdapter } from './adapters'
import type { AdapterQueryResult } from './adapters/types'

const PROXY_CACHE_TTL_MS = 300_000 // 5 min
const PROXY_CACHE_MAX = 500
const SPEC_CACHE_TTL_MS = 86_400_000 // 24 h
const ALL_TAB_PREVIEW_LIMIT = 20

// ── Row ↔ RegistryEntry mapping ──────────────────────────────────────────────

interface ItemRow {
  pk: string
  slug: string
  registry_id: string
  name: string
  description: string
  author: string
  tags: string
  type: string
  category: string
  rank: number | null
  version: string
  icon: string | null
  locale: string | null
  format: string
  path: string
  download_url: string | null
  size_bytes: number | null
  checksum: string | null
  requires_mcps: string | null
  requires_skills: string | null
  created_at: string | null
  updated_at: string | null
  i18n: string | null
  meta: string | null
}

function rowToEntry(row: ItemRow): RegistryEntry & { _registryId: string } {
  return {
    slug: row.slug,
    name: row.name,
    version: row.version,
    author: row.author,
    description: row.description,
    type: row.type as AppType,
    format: 'bundle' as const,
    path: row.path,
    download_url: row.download_url ?? undefined,
    size_bytes: row.size_bytes ?? undefined,
    checksum: row.checksum ?? undefined,
    category: row.category,
    tags: safeParse<string[]>(row.tags, []),
    icon: row.icon ?? undefined,
    locale: row.locale ?? undefined,
    requires_mcps: row.requires_mcps ? safeParse<string[]>(row.requires_mcps, []) : undefined,
    requires_skills: row.requires_skills ? safeParse<string[]>(row.requires_skills, []) : undefined,
    created_at: row.created_at ?? undefined,
    updated_at: row.updated_at ?? undefined,
    i18n: row.i18n ? safeParse<Record<string, { name?: string; description?: string }>>(row.i18n, undefined) : undefined,
    meta: row.meta ? safeParse<Record<string, unknown>>(row.meta, undefined) : undefined,
    _registryId: row.registry_id,
  }
}

function safeParse<T>(json: string, fallback: T): T {
  try { return JSON.parse(json) as T } catch { return fallback }
}

/**
 * Escape user input for FTS5 MATCH.
 * Wraps each token in double-quotes so special chars are treated as literals,
 * then appends '*' for prefix matching.
 */
function ftsEscape(raw: string): string {
  const tokens = raw.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return ''
  return tokens.map(t => `"${t.replace(/"/g, '""')}"*`).join(' ')
}

// FTS5's default tokenizer doesn't segment CJK, so Chinese queries miss almost
// everything via MATCH. Escape the term for a LIKE substring fallback (also
// reaches the i18n JSON column, which the FTS index doesn't cover).
function escapeLike(raw: string): string {
  return raw.trim().replace(/[\\%_]/g, c => `\\${c}`)
}

function supportsType(source: RegistrySource, type?: AppType): boolean {
  if (!type) return true

  switch (source.sourceType) {
    case 'mcp-registry':
    case 'smithery':
      return type === 'mcp'
    case 'claude-skills':
    case 'skillhub':
      return type === 'skill'
    case 'halo':
    default:
      return type === 'automation'
  }
}

// ── QueryService ─────────────────────────────────────────────────────────────

export class QueryService {
  private db: Database.Database

  constructor(dbManager: DatabaseManager) {
    this.db = dbManager.getAppDatabase()
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Unified query entry point.
   *
   * - type set   → Type Tab mode (mirror + proxy merged)
   * - type unset → All Tab preview (grouped by type)
   */
  async query(params: StoreQueryParams, registries: RegistrySource[]): Promise<StoreQueryResponse> {
    const startedAt = performance.now()
    const mode = params.type ? 'typed' : 'all-preview'

    const result = !params.type
      ? await this.queryAllPreview(params, registries)
      : await this.queryTyped(params, registries)

    console.log(
      `[StoreQuery] done mode=${mode} type=${params.type ?? 'all'} category=${params.category ?? '-'} page=${params.page} size=${params.pageSize} items=${result.items.length} total=${result.total ?? 0} sources=${result.sources.length} durationMs=${Math.round(performance.now() - startedAt)}`
    )
    return result
  }

  /**
   * Fetch full AppSpec for a single entry, with SQLite spec cache.
   */
  async fetchSpec(
    entry: RegistryEntry,
    registryId: string,
    registries: RegistrySource[],
  ): Promise<AppSpec> {
    // Check spec cache
    const cached = this.readSpecCache(registryId, entry.slug)
    if (cached && cached.version === entry.version) {
      return cached.spec
    }

    const registry = registries.find(r => r.id === registryId)
    if (!registry) throw new Error(`Registry not found: ${registryId}`)

    const adapter = getAdapter(registry)
    const spec = await adapter.fetchSpec(registry, entry)

    this.writeSpecCache(registryId, entry.slug, entry.version, spec)
    return spec
  }

  /**
   * Look up a single entry by slug across all mirror data + proxy caches.
   * Returns the entry and its registryId, or null.
   *
   * When `registryId` is given, that registry's entry is preferred — slugs can
   * collide across registries and callers with provenance (e.g. update checks)
   * must resolve against the registry the app was installed from.
   */
  findEntry(slug: string, registryId?: string): { entry: RegistryEntry; registryId: string } | null {
    if (registryId) {
      const scoped = this.db.prepare(
        `SELECT * FROM registry_items WHERE slug = ? AND registry_id = ? LIMIT 1`
      ).get(slug, registryId) as ItemRow | undefined
      if (scoped) {
        const mapped = rowToEntry(scoped)
        const { _registryId, ...entry } = mapped
        return { entry: entry as RegistryEntry, registryId: _registryId }
      }
    }

    // 1. Search mirror data (registry_items)
    const row = this.db.prepare(
      `SELECT * FROM registry_items WHERE slug = ? LIMIT 1`
    ).get(slug) as ItemRow | undefined

    if (row) {
      const mapped = rowToEntry(row)
      const { _registryId, ...entry } = mapped
      return { entry: entry as RegistryEntry, registryId: _registryId }
    }

    // 2. Fallback: search proxy query cache results
    return this.findEntryInQueryCache(slug)
  }

  /**
   * Search through proxy query cache results for a matching slug.
   * Used when the entry isn't in registry_items (proxy sources).
   */
  private findEntryInQueryCache(slug: string): { entry: RegistryEntry; registryId: string } | null {
    const rows = this.db.prepare(
      `SELECT registry_id, results, cached_at, ttl_ms FROM registry_query_cache`
    ).all() as Array<{ registry_id: string; results: string; cached_at: number; ttl_ms: number }>

    for (const row of rows) {
      if (Date.now() - row.cached_at > row.ttl_ms) continue
      const items = safeParse<RegistryEntry[]>(row.results, [])
      const match = items.find(item => item.slug === slug)
      if (match) {
        return { entry: match, registryId: row.registry_id }
      }
    }
    return null
  }

  // ── Type Tab query ─────────────────────────────────────────────────────────

  private async queryTyped(params: StoreQueryParams, registries: RegistrySource[]): Promise<StoreQueryResponse> {
    const enabled = registries.filter(r => r.enabled)

    // Mirror: always query SQLite (type filter in SQL)
    const mirror = this.queryMirror(params)

    // Proxy: query only sources that support the requested type
    const proxyRegistries = enabled.filter(r => {
      const adapter = getAdapter(r)
      return adapter.strategy === 'proxy' && supportsType(r, params.type)
    })
    const proxy = await this.queryProxySources(params, proxyRegistries)

    // Merge: proxy items first (SkillHub), then mirror
    const items = [...proxy.items, ...mirror.items]
    const total = (mirror.total ?? 0) + (proxy.total ?? 0)
    const hasMore = mirror.hasMore || proxy.hasMore

    return {
      items,
      total,
      hasMore,
      sources: [
        ...mirror.sources,
        ...proxy.sources,
      ],
    }
  }

  // ── Mirror query (SQLite + FTS5) ───────────────────────────────────────────

  private queryMirror(params: StoreQueryParams): {
    items: RegistryEntry[]
    total: number
    hasMore: boolean
    sources: StoreQueryResponse['sources']
  } {
    const startedAt = performance.now()
    const { search, type, category, page, pageSize } = params
    const offset = (page - 1) * pageSize
    const ftsQuery = search ? ftsEscape(search) : ''

    const conditions: string[] = []
    const bindings: unknown[] = []

    if (type) {
      conditions.push('ri.type = ?')
      bindings.push(type)
    }
    if (category) {
      conditions.push('ri.category = ?')
      bindings.push(category)
    }
    if (ftsQuery) {
      const like = `%${escapeLike(search!)}%`
      conditions.push(
        "(ri.rowid IN (SELECT rowid FROM registry_items_fts WHERE registry_items_fts MATCH ?)" +
        " OR ri.name LIKE ? ESCAPE '\\'" +
        " OR ri.description LIKE ? ESCAPE '\\'" +
        " OR ri.author LIKE ? ESCAPE '\\'" +
        " OR ri.tags LIKE ? ESCAPE '\\'" +
        " OR ri.i18n LIKE ? ESCAPE '\\')"
      )
      bindings.push(ftsQuery, like, like, like, like, like)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    // Count
    const countRow = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM registry_items ri ${where}`
    ).get(...bindings) as { cnt: number }
    const total = countRow.cnt

    // Fetch page
    const rows = this.db.prepare(
      `SELECT ri.* FROM registry_items ri ${where} ORDER BY ri.rank ASC NULLS LAST, ri.updated_at DESC, ri.rowid ASC LIMIT ? OFFSET ?`
    ).all(...bindings, pageSize, offset) as ItemRow[]

    const items = rows.map(r => {
      const { _registryId, ...entry } = rowToEntry(r)
      return entry as RegistryEntry
    })

    // Per-source breakdown log
    const durationMs = Math.round(performance.now() - startedAt)
    const perSource = new Map<string, number>()
    for (const r of rows) {
      perSource.set(r.registry_id, (perSource.get(r.registry_id) ?? 0) + 1)
    }
    const sources: StoreQueryResponse['sources'] = []
    for (const [rid, count] of perSource) {
      console.log(`[StoreQuery] source=${rid} type=${type ?? 'all'} status=local-query items=${count} total=${total} durationMs=${durationMs}`)
      sources.push({ registryId: rid, status: 'ok' })
    }
    if (perSource.size === 0) {
      console.log(`[StoreQuery] mirror type=${type ?? 'all'} status=local-query items=0 total=0 durationMs=${durationMs}`)
    }

    return { items, total, hasMore: offset + rows.length < total, sources }
  }

  // ── Proxy query (adapter.query + LRU cache) ────────────────────────────────

  private async queryProxySources(
    params: StoreQueryParams,
    proxyRegistries: RegistrySource[],
  ): Promise<{
    items: RegistryEntry[]
    total: number | undefined
    hasMore: boolean
    sources: StoreQueryResponse['sources']
  }> {
    if (proxyRegistries.length === 0) {
      return { items: [], total: 0, hasMore: false, sources: [] }
    }

    const allItems: RegistryEntry[] = []
    let totalAcc = 0
    let anyHasMore = false
    const sources: StoreQueryResponse['sources'] = []

    const results = await Promise.allSettled(
      proxyRegistries.map(r => this.queryOneProxy(r, params))
    )

    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      const registry = proxyRegistries[i]

      if (result.status === 'fulfilled') {
        allItems.push(...result.value.items)
        if (result.value.total != null) totalAcc += result.value.total
        if (result.value.hasMore) anyHasMore = true
        sources.push({ registryId: registry.id, status: 'ok' })
      } else {
        const msg = result.reason instanceof Error ? result.reason.message : String(result.reason)
        console.error(`[QueryService] Proxy query failed for "${registry.name}": ${msg}`)
        sources.push({ registryId: registry.id, status: 'error', error: msg })
      }
    }

    return { items: allItems, total: totalAcc || undefined, hasMore: anyHasMore, sources }
  }

  private async queryOneProxy(registry: RegistrySource, params: StoreQueryParams): Promise<AdapterQueryResult> {
    const cacheKey = this.buildCacheKey(registry.id, params)
    const queryType = params.type ?? 'all'

    // Check cache
    const cached = this.readQueryCache(cacheKey)
    if (cached) {
      console.log(
        `[StoreQuery] source=${registry.id} type=${queryType} status=cache-hit items=${cached.items.length} total=${cached.total ?? 0} hasMore=${cached.hasMore}`
      )
      return cached
    }

    // Forward to adapter
    const adapter = getAdapter(registry)
    if (!adapter.query) {
      console.log(`[StoreQuery] source=${registry.id} type=${queryType} status=unsupported`)
      return { items: [], hasMore: false }
    }

    const startedAt = performance.now()
    console.log(`[StoreQuery] source=${registry.id} type=${queryType} status=request-start`)
    const result = await adapter.query(registry, params)

    console.log(
      `[StoreQuery] source=${registry.id} type=${queryType} status=request-done items=${result.items.length} total=${result.total ?? 0} hasMore=${result.hasMore} durationMs=${Math.round(performance.now() - startedAt)}`
    )

    // Write to cache + LRU eviction
    this.writeQueryCache(cacheKey, registry.id, params, result)

    return result
  }

  // ── All Tab preview ────────────────────────────────────────────────────────

  private async queryAllPreview(params: StoreQueryParams, registries: RegistrySource[]): Promise<StoreQueryResponse> {
    const enabled = registries.filter(r => r.enabled)
    const proxyRegistries = enabled.filter(r => getAdapter(r).strategy === 'proxy')

    const types: AppType[] = ['automation', 'skill', 'mcp']
    const groups: NonNullable<StoreQueryResponse['groups']> = []
    const allItems: RegistryEntry[] = []
    const allSources: StoreQueryResponse['sources'] = []

    for (const t of types) {
      const previewParams: StoreQueryParams = {
        search: params.search,
        locale: params.locale,
        category: params.category,
        type: t,
        page: 1,
        pageSize: ALL_TAB_PREVIEW_LIMIT,
      }

      if (t === 'mcp') {
        // Proxy sources for MCP
        const proxy = await this.queryProxySources(previewParams, proxyRegistries)
        allItems.push(...proxy.items)
        allSources.push(...proxy.sources)
        groups.push({
          type: t,
          count: proxy.total ?? proxy.items.length,
          hasMore: proxy.hasMore,
        })
      } else if (t === 'skill') {
        // Mirror sources + proxy sources that support skill (e.g. SkillHub)
        const mirror = this.queryMirror(previewParams)
        const skillProxies = proxyRegistries.filter(r => supportsType(r, 'skill'))
        const proxy = await this.queryProxySources(previewParams, skillProxies)
        allItems.push(...proxy.items, ...mirror.items)
        allSources.push(...mirror.sources, ...proxy.sources)
        groups.push({
          type: t,
          count: mirror.total + (proxy.total ?? proxy.items.length),
          hasMore: mirror.hasMore || proxy.hasMore,
        })
      } else {
        // Mirror sources for automation
        const mirror = this.queryMirror(previewParams)
        allItems.push(...mirror.items)
        allSources.push(...mirror.sources)
        groups.push({
          type: t,
          count: mirror.total,
          hasMore: mirror.hasMore,
        })
      }
    }

    // Deduplicate sources
    const seenSources = new Set<string>()
    const uniqueSources = allSources.filter(s => {
      if (seenSources.has(s.registryId)) return false
      seenSources.add(s.registryId)
      return true
    })

    return {
      items: allItems,
      hasMore: groups.some(g => g.hasMore),
      groups,
      sources: uniqueSources,
    }
  }

  // ── Query cache helpers ────────────────────────────────────────────────────

  private buildCacheKey(registryId: string, params: StoreQueryParams): string {
    const parts = [
      registryId,
      params.search ?? '',
      params.type ?? '',
      params.category ?? '',
      String(params.page),
      String(params.pageSize),
    ]
    return parts.join('|')
  }

  private readQueryCache(cacheKey: string): AdapterQueryResult | null {
    const row = this.db.prepare(
      `SELECT results, total_count, has_more, cached_at, ttl_ms FROM registry_query_cache WHERE cache_key = ?`
    ).get(cacheKey) as { results: string; total_count: number | null; has_more: number; cached_at: number; ttl_ms: number } | undefined

    if (!row) return null
    if (Date.now() - row.cached_at > row.ttl_ms) {
      // Expired — delete and return miss
      this.db.prepare(`DELETE FROM registry_query_cache WHERE cache_key = ?`).run(cacheKey)
      return null
    }

    return {
      items: safeParse<RegistryEntry[]>(row.results, []),
      total: row.total_count ?? undefined,
      hasMore: row.has_more === 1,
    }
  }

  private writeQueryCache(
    cacheKey: string,
    registryId: string,
    params: StoreQueryParams,
    result: AdapterQueryResult,
  ): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO registry_query_cache
        (cache_key, registry_id, query_params, results, total_count, has_more, cached_at, ttl_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      cacheKey,
      registryId,
      JSON.stringify(params),
      JSON.stringify(result.items),
      result.total ?? null,
      result.hasMore ? 1 : 0,
      Date.now(),
      PROXY_CACHE_TTL_MS,
    )

    // LRU eviction: keep at most PROXY_CACHE_MAX entries
    this.evictQueryCache()
  }

  private evictQueryCache(): void {
    const countRow = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM registry_query_cache`
    ).get() as { cnt: number }

    if (countRow.cnt > PROXY_CACHE_MAX) {
      const excess = countRow.cnt - PROXY_CACHE_MAX
      this.db.prepare(`
        DELETE FROM registry_query_cache WHERE cache_key IN (
          SELECT cache_key FROM registry_query_cache ORDER BY cached_at ASC LIMIT ?
        )
      `).run(excess)
    }
  }

  // ── Spec cache helpers ─────────────────────────────────────────────────────

  private readSpecCache(registryId: string, slug: string): { spec: AppSpec; version: string } | null {
    const pk = `${registryId}:${slug}`
    const row = this.db.prepare(
      `SELECT spec_json, version, cached_at, ttl_ms FROM registry_spec_cache WHERE pk = ?`
    ).get(pk) as { spec_json: string; version: string; cached_at: number; ttl_ms: number } | undefined

    if (!row) return null
    if (Date.now() - row.cached_at > row.ttl_ms) {
      this.db.prepare(`DELETE FROM registry_spec_cache WHERE pk = ?`).run(pk)
      return null
    }

    return {
      spec: JSON.parse(row.spec_json) as AppSpec,
      version: row.version,
    }
  }

  private writeSpecCache(registryId: string, slug: string, version: string, spec: AppSpec): void {
    const pk = `${registryId}:${slug}`
    this.db.prepare(`
      INSERT OR REPLACE INTO registry_spec_cache (pk, registry_id, spec_json, version, cached_at, ttl_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(pk, registryId, JSON.stringify(spec), version, Date.now(), SPEC_CACHE_TTL_MS)
  }
}