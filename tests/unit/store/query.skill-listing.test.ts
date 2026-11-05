/**
 * The Store skill listing a dependency resolves to. A slug can sit in several
 * sources, and as a digital human as well as a skill: only a skill from a
 * source asked for answers, in the order the sources were given.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

vi.mock('../../../src/main/store/adapters', () => ({
  getAdapter: () => ({ strategy: 'mirror' as const, fetchIndex: vi.fn(), fetchSpec: vi.fn() }),
}))

import { QueryService } from '../../../src/main/store/query.service'
import { storeCacheMigrations } from '../../../src/main/store/store-cache.schema'
import type { DatabaseManager } from '../../../src/main/platform/store/types'

describe('QueryService.findSkillEntry', () => {
  let service: QueryService

  beforeEach(() => {
    const db = new Database(':memory:')
    for (const migration of storeCacheMigrations) migration.up(db)
    const insert = db.prepare(`
      INSERT INTO registry_items (pk, slug, registry_id, name, description, author, type, category, version, path, indexed_at)
      VALUES (?, ?, ?, ?, 'd', 'a', ?, 'devops', ?, 'pkg', 0)
    `)
    insert.run('off:acme/x', 'acme/x', 'off', 'x', 'skill', '1.0.0')
    insert.run('a:acme/x', 'acme/x', 'a', 'x', 'skill', '2.0.0')
    insert.run('b:acme/x', 'acme/x', 'b', 'x', 'skill', '3.0.0')
    insert.run('a:helper', 'helper', 'a', 'helper', 'automation', '1.0.0')
    const cache = db.prepare(`
      INSERT INTO registry_query_cache (cache_key, registry_id, query_params, results, cached_at, ttl_ms)
      VALUES (?, ?, '{}', ?, ?, 60000)
    `)
    cache.run('p1', 'proxy', JSON.stringify([{ slug: 'hub/tool', type: 'automation' }, { slug: 'hub/skill', type: 'skill', version: '4.0.0' }]), Date.now())
    cache.run('p2', 'proxy-off', JSON.stringify([{ slug: 'hub/other', type: 'skill' }]), Date.now())
    service = new QueryService({ getAppDatabase: () => db } as unknown as DatabaseManager)
  })

  it('answers from the first listed source that has the skill', () => {
    expect(service.findSkillEntry('acme/x', ['b', 'a'])).toMatchObject({ registryId: 'b', entry: { version: '3.0.0' } })
    expect(service.findSkillEntry('acme/x', ['a', 'b'])).toMatchObject({ registryId: 'a', entry: { version: '2.0.0' } })
  })

  it('falls back to a listed proxy source\'s cached results, skills only', () => {
    expect(service.findSkillEntry('hub/skill', ['proxy'])).toMatchObject({ registryId: 'proxy', entry: { version: '4.0.0' } })
    expect(service.findSkillEntry('hub/tool', ['proxy'])).toBeNull()
    expect(service.findSkillEntry('hub/other', ['proxy'])).toBeNull()
  })

  it('ignores sources not listed and listings that are not skills', () => {
    expect(service.findSkillEntry('acme/x', ['c'])).toBeNull()
    expect(service.findSkillEntry('acme/x', [])).toBeNull()
    expect(service.findSkillEntry('helper', ['a'])).toBeNull()
  })
})
