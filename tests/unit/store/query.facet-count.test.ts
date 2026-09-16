/**
 * `total` as a facet count.
 *
 * The category chips read their number from a `pageSize: 1` probe, so `total`
 * has to describe the whole filtered catalog rather than the page that came
 * back with it. Guards both halves of the merge: the mirror's SQL COUNT and
 * the proxy source's reported total.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

const { getAdapterMock } = vi.hoisted(() => ({ getAdapterMock: vi.fn() }))

vi.mock('../../../src/main/store/adapters', () => ({
  getAdapter: getAdapterMock,
}))

import { QueryService } from '../../../src/main/store/query.service'
import { storeCacheMigrations } from '../../../src/main/store/store-cache.schema'
import type { DatabaseManager } from '../../../src/main/platform/store/types'
import type { RegistrySource } from '../../../src/shared/store/store-types'
import type { AppType } from '../../../src/shared/apps/spec-types'

const MIRROR: RegistrySource = {
  id: 'mirror-1', name: 'mirror', url: 'https://mirror.example.com', enabled: true, sourceType: 'halo',
}
const PROXY: RegistrySource = {
  id: 'proxy-1', name: 'proxy', url: 'https://proxy.example.com', enabled: true, sourceType: 'skillhub',
}

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  for (const migration of storeCacheMigrations) migration.up(db)
  return db
}

function insert(db: Database.Database, slug: string, type: AppType, category: string): void {
  db.prepare(`
    INSERT INTO registry_items (pk, slug, registry_id, name, description, author, type, category, version, path, indexed_at)
    VALUES (?, ?, ?, ?, 'd', 'a', ?, ?, '1.0.0', ?, 0)
  `).run(`${MIRROR.id}:${slug}`, slug, MIRROR.id, slug, type, category, `pkg/${slug}`)
}

/** A proxy source that reports a per-category total, as SkillHub now does. */
function proxyReporting(totals: Record<string, number>) {
  return {
    strategy: 'proxy' as const,
    query: vi.fn(async (_source: RegistrySource, params: { category?: string }) => {
      const total = params.category ? (totals[params.category] ?? 0) : Object.values(totals).reduce((a, b) => a + b, 0)
      return { items: [], total, hasMore: false }
    }),
    fetchSpec: vi.fn(),
  }
}

describe('QueryService — total as a facet count', () => {
  let db: Database.Database
  let service: QueryService

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    db = makeDb()
    service = new QueryService({ getAppDatabase: () => db } as unknown as DatabaseManager)

    insert(db, 'skill-content-1', 'skill', 'content')
    insert(db, 'skill-content-2', 'skill', 'content')
    insert(db, 'skill-data-1', 'skill', 'data')
    insert(db, 'automation-content-1', 'automation', 'content')

    getAdapterMock.mockImplementation((source: RegistrySource) =>
      source.id === PROXY.id
        ? proxyReporting({ content: 500, data: 20 })
        : { strategy: 'mirror' as const, fetchIndex: vi.fn(), fetchSpec: vi.fn() }
    )
  })

  it('counts the whole filtered catalog, not the returned page', async () => {
    const probe = await service.query({ type: 'skill', category: 'content', page: 1, pageSize: 1 }, [MIRROR])
    const page = await service.query({ type: 'skill', category: 'content', page: 1, pageSize: 50 }, [MIRROR])

    expect(probe.items).toHaveLength(1)
    expect(page.items).toHaveLength(2)
    expect(probe.total).toBe(2)
    expect(probe.total).toBe(page.total)
  })

  it('scopes the count by type as well as category', async () => {
    const skills = await service.query({ type: 'skill', category: 'content', page: 1, pageSize: 1 }, [MIRROR])
    const automations = await service.query({ type: 'automation', category: 'content', page: 1, pageSize: 1 }, [MIRROR])

    expect(skills.total).toBe(2)
    expect(automations.total).toBe(1)
  })

  it('sums mirror and proxy totals for the same chip', async () => {
    const result = await service.query({ type: 'skill', category: 'content', page: 1, pageSize: 1 }, [MIRROR, PROXY])

    expect(result.total).toBe(502)
  })

  it('reports zero for a category no source carries', async () => {
    const result = await service.query({ type: 'skill', category: 'social', page: 1, pageSize: 1 }, [MIRROR, PROXY])

    expect(result.total).toBe(0)
    expect(result.items).toHaveLength(0)
  })

  it('passes the requested category through to the proxy source', async () => {
    const adapter = proxyReporting({ content: 500 })
    getAdapterMock.mockImplementation((source: RegistrySource) =>
      source.id === PROXY.id ? adapter : { strategy: 'mirror' as const, fetchIndex: vi.fn(), fetchSpec: vi.fn() }
    )

    await service.query({ type: 'skill', category: 'content', page: 1, pageSize: 1 }, [PROXY])

    expect(adapter.query).toHaveBeenCalledWith(PROXY, expect.objectContaining({ category: 'content' }))
  })

  // A count is only usable when every source answered. Failure — whole or
  // partial — has to reach the caller as source status, because the response
  // itself still succeeds and `total` still looks like a number.
  describe('a total that is not the whole catalog says so', () => {
    beforeEach(() => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    function proxyPartial() {
      return {
        strategy: 'proxy' as const,
        query: vi.fn(async () => ({ items: [], total: 20, hasMore: false, partial: '1/2 streams failed' })),
        fetchSpec: vi.fn(),
      }
    }

    function useProxy(adapter: unknown) {
      getAdapterMock.mockImplementation((source: RegistrySource) =>
        source.id === PROXY.id ? adapter : { strategy: 'mirror' as const, fetchIndex: vi.fn(), fetchSpec: vi.fn() }
      )
    }

    it('marks a partly-answered source failed while keeping its items', async () => {
      useProxy({
        strategy: 'proxy' as const,
        query: vi.fn(async () => ({
          items: [{ slug: 'survivor' }] as never,
          total: 20,
          hasMore: false,
          partial: '1/2 streams failed',
        })),
        fetchSpec: vi.fn(),
      })

      const result = await service.query({ type: 'skill', category: 'content', page: 1, pageSize: 1 }, [PROXY])

      expect(result.items.map(i => i.slug)).toContain('survivor')
      expect(result.sources).toContainEqual({
        registryId: PROXY.id,
        status: 'error',
        error: '1/2 streams failed',
      })
    })

    it('marks a rejected source failed', async () => {
      useProxy({
        strategy: 'proxy' as const,
        query: vi.fn(async () => { throw new Error('ETIMEDOUT') }),
        fetchSpec: vi.fn(),
      })

      const result = await service.query({ type: 'skill', category: 'content', page: 1, pageSize: 1 }, [PROXY])

      expect(result.sources).toContainEqual(
        expect.objectContaining({ registryId: PROXY.id, status: 'error' })
      )
    })

    // The cache row carries no reason, so a cached partial would read back as
    // a complete answer for the rest of the TTL.
    it('does not cache a partial result', async () => {
      const adapter = proxyPartial()
      useProxy(adapter)

      const params = { type: 'skill' as const, category: 'content', page: 1, pageSize: 1 }
      await service.query(params, [PROXY])
      const second = await service.query(params, [PROXY])

      expect(adapter.query).toHaveBeenCalledTimes(2)
      expect(second.sources).toContainEqual(
        expect.objectContaining({ registryId: PROXY.id, status: 'error' })
      )
    })
  })
})
