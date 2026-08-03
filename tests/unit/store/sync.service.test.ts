/**
 * SyncService unit tests.
 *
 * Uses an in-memory better-sqlite3 database with the real store-cache schema,
 * and a stubbed adapter so we can drive fetchIndex outcomes. Covers TTL skip
 * (fresh → no fetch), failure preserving last_synced_at, and the 500-row batch
 * boundary in batchInsert.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

const { getAdapterMock } = vi.hoisted(() => ({ getAdapterMock: vi.fn() }))

vi.mock('../../../src/main/store/adapters', () => ({
  getAdapter: getAdapterMock,
}))

import { SyncService } from '../../../src/main/store/sync.service'
import { storeCacheMigrations } from '../../../src/main/store/store-cache.schema'
import type { DatabaseManager } from '../../../src/main/platform/store/types'
import type { RegistrySource, RegistryEntry } from '../../../src/shared/store/store-types'

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  storeCacheMigrations[0].up(db)
  return db
}

function makeManager(db: Database.Database): DatabaseManager {
  return { getAppDatabase: () => db } as unknown as DatabaseManager
}

function mirrorRegistry(id = 'mirror-1'): RegistrySource {
  return { id, name: id, url: 'https://mirror.example.com', enabled: true, sourceType: 'halo' } as RegistrySource
}

function entry(slug: string): RegistryEntry {
  return {
    slug,
    name: slug,
    description: 'd',
    author: 'a',
    tags: [],
    type: 'automation',
    version: '1.0.0',
    format: 'bundle',
    path: `pkg/${slug}`,
  } as RegistryEntry
}

describe('SyncService', () => {
  let db: Database.Database

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    db = makeDb()
  })

  it('skips a fetch when last_synced_at is within the TTL', async () => {
    const reg = mirrorRegistry()
    // Seed a fresh sync state so TTL guard trips before fetch.
    db.prepare(
      `INSERT INTO registry_sync_state (registry_id, strategy, status, last_synced_at, app_count)
       VALUES (?, 'mirror', 'idle', ?, 3)`,
    ).run(reg.id, Date.now())

    const fetchIndex = vi.fn()
    getAdapterMock.mockReturnValue({ strategy: 'mirror', fetchIndex })

    const svc = new SyncService(makeManager(db))
    await svc.syncOne(reg, 60_000)

    expect(fetchIndex).not.toHaveBeenCalled()
  })

  it('preserves last_synced_at when a sync fails', async () => {
    const reg = mirrorRegistry()
    const priorTs = Date.now() - 10 * 60_000
    db.prepare(
      `INSERT INTO registry_sync_state (registry_id, strategy, status, last_synced_at, app_count)
       VALUES (?, 'mirror', 'idle', ?, 5)`,
    ).run(reg.id, priorTs)

    getAdapterMock.mockReturnValue({
      strategy: 'mirror',
      fetchIndex: vi.fn().mockRejectedValue(new Error('network down')),
    })

    const svc = new SyncService(makeManager(db))
    await svc.syncOne(reg, 0, true) // force past TTL

    const state = db
      .prepare(`SELECT status, last_synced_at FROM registry_sync_state WHERE registry_id = ?`)
      .get(reg.id) as { status: string; last_synced_at: number }

    expect(state.status).toBe('error')
    expect(state.last_synced_at).toBe(priorTs) // not clobbered on failure
  })

  it('inserts across the 500-row batch boundary', async () => {
    const reg = mirrorRegistry()
    const entries = Array.from({ length: 501 }, (_, i) => entry(`app-${i}`))

    getAdapterMock.mockReturnValue({
      strategy: 'mirror',
      fetchIndex: vi.fn().mockResolvedValue({ index: { apps: entries }, validators: {} }),
    })

    const svc = new SyncService(makeManager(db))
    await svc.syncOne(reg, 0, true)

    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM registry_items WHERE registry_id = ?`)
      .get(reg.id) as { n: number }
    expect(count.n).toBe(501)

    const state = db
      .prepare(`SELECT status, app_count FROM registry_sync_state WHERE registry_id = ?`)
      .get(reg.id) as { status: string; app_count: number }
    expect(state.status).toBe('idle')
    expect(state.app_count).toBe(501)
  })

  it('records success and rebuilds FTS entries', async () => {
    const reg = mirrorRegistry()
    getAdapterMock.mockReturnValue({
      strategy: 'mirror',
      fetchIndex: vi.fn().mockResolvedValue({ index: { apps: [entry('searchable')] }, validators: {} }),
    })

    const svc = new SyncService(makeManager(db))
    await svc.syncOne(reg, 0, true)

    const fts = db
      .prepare(`SELECT COUNT(*) AS n FROM registry_items_fts WHERE registry_items_fts MATCH ?`)
      .get('searchable') as { n: number }
    expect(fts.n).toBe(1)
  })
})
