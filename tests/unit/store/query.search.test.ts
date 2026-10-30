/**
 * Mirror search finds an entry by the title its card shows. A published skill
 * keeps an identifier in `name` and its title in `display_name`, and the FTS
 * index cannot segment CJK, so a word only in the title is reachable through
 * the LIKE fallback alone.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

vi.mock('../../../src/main/store/adapters', () => ({
  getAdapter: () => ({ strategy: 'mirror' as const, fetchIndex: vi.fn(), fetchSpec: vi.fn() }),
}))

import { QueryService } from '../../../src/main/store/query.service'
import { storeCacheMigrations } from '../../../src/main/store/store-cache.schema'
import type { DatabaseManager } from '../../../src/main/platform/store/types'
import type { RegistrySource } from '../../../src/shared/store/store-types'

const MIRROR: RegistrySource = {
  id: 'mirror-1', name: 'mirror', url: 'https://mirror.example.com', enabled: true, sourceType: 'halo',
}

describe('QueryService — search by the shown title', () => {
  let service: QueryService

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const db = new Database(':memory:')
    for (const migration of storeCacheMigrations) migration.up(db)
    const insert = db.prepare(`
      INSERT INTO registry_items (pk, slug, registry_id, name, display_name, description, author, type, category, version, path, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, 'a', 'skill', 'devops', '1.0.0', ?, 0)
    `)
    const skill = (slug: string, displayName: string, description: string) =>
      insert.run(`${MIRROR.id}:${slug}`, slug, MIRROR.id, slug, displayName, description, `pkg/${slug}`)
    skill('weekly-report', '用机器人整理周报', '把一周的记录汇总成文档')
    skill('meeting-notes', '会议纪要整理', '把会议记录整理成纪要')
    service = new QueryService({ getAppDatabase: () => db } as unknown as DatabaseManager)
  })

  it('matches a word that appears only in display_name', async () => {
    const result = await service.query({ type: 'skill', search: '周报', page: 1, pageSize: 30 }, [MIRROR])

    expect(result.items.map(item => item.slug)).toEqual(['weekly-report'])
    expect(result.total).toBe(1)
  })
})
