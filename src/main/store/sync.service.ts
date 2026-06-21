/**
 * SyncService — Background Mirror Source Synchronization
 *
 * Periodically downloads full indexes from Mirror-strategy sources
 * and writes them into SQLite. Proxy sources are not touched here.
 *
 * Design:
 *   - Each Mirror source is synced independently
 *   - Batch INSERT (500 per transaction) to avoid long write-locks
 *   - ETag/Last-Modified for change detection (skip if unchanged)
 *   - On failure, old cached data is preserved
 *   - Emits 'store:sync-status-changed' IPC events for UI updates
 */

import type Database from 'better-sqlite3'
import type { DatabaseManager } from '../platform/store/types'
import type { RegistrySource, RegistryEntry } from '../../shared/store/store-types'
import { getAdapter } from './adapters'

const BATCH_SIZE = 500
const DEFAULT_MIRROR_TTL_MS = 3600000 // 1 hour

type SyncStatusListener = (event: {
  registryId: string
  status: 'idle' | 'syncing' | 'error'
  appCount: number
  error?: string
}) => void

export class SyncService {
  private db: Database.Database
  private dbManager: DatabaseManager
  private listener: SyncStatusListener | null = null
  private syncing = new Map<string, Promise<void>>()

  constructor(dbManager: DatabaseManager) {
    this.dbManager = dbManager
    this.db = dbManager.getAppDatabase()
  }

  onSyncStatusChanged(listener: SyncStatusListener): void {
    this.listener = listener
  }

  private emit(registryId: string, status: 'idle' | 'syncing' | 'error', appCount: number, error?: string): void {
    // Only update last_synced_at on success ('idle') so failed sources are retried on next syncAll
    if (status === 'idle') {
      this.db.prepare(`
        INSERT INTO registry_sync_state (registry_id, strategy, status, last_synced_at, app_count, error_message)
        VALUES (?, 'mirror', ?, ?, ?, ?)
        ON CONFLICT(registry_id) DO UPDATE SET
          status = excluded.status,
          last_synced_at = excluded.last_synced_at,
          app_count = excluded.app_count,
          error_message = excluded.error_message
      `).run(registryId, status, Date.now(), appCount, error ?? null)
    } else {
      // syncing / error: update status but preserve last_synced_at
      this.db.prepare(`
        INSERT INTO registry_sync_state (registry_id, strategy, status, last_synced_at, app_count, error_message)
        VALUES (?, 'mirror', ?, 0, ?, ?)
        ON CONFLICT(registry_id) DO UPDATE SET
          status = excluded.status,
          app_count = excluded.app_count,
          error_message = excluded.error_message
      `).run(registryId, status, appCount, error ?? null)
    }

    this.listener?.({ registryId, status, appCount, error })
  }

  /**
   * Sync all enabled Mirror sources that are past their TTL.
   */
  async syncAll(registries: RegistrySource[], ttlMs = DEFAULT_MIRROR_TTL_MS): Promise<void> {
    const mirrorRegistries = registries.filter(r => {
      if (!r.enabled) return false
      const adapter = getAdapter(r)
      return adapter.strategy === 'mirror'
    })

    console.log('[SyncService] syncAll:start', {
      ttlMs,
      totalRegistries: registries.length,
      mirrorRegistries: mirrorRegistries.length,
    })

    const startedAt = performance.now()
    // Sync in parallel (each source is independent)
    await Promise.allSettled(
      mirrorRegistries.map(r => this.syncOne(r, ttlMs))
    )

    console.log('[SyncService] syncAll:done', {
      ttlMs,
      mirrorRegistries: mirrorRegistries.length,
      durationMs: Math.round(performance.now() - startedAt),
    })
  }

  /**
   * Sync a single Mirror source. Skips if within TTL and not forced.
   */
  async syncOne(registry: RegistrySource, ttlMs = DEFAULT_MIRROR_TTL_MS, force = false): Promise<void> {
    // Wait for any in-flight sync of the same registry instead of skipping:
    // callers like refreshIndex(ttl=0) must not return before data is fresh.
    while (this.syncing.has(registry.id)) {
      await this.syncing.get(registry.id)
    }

    // Check TTL
    if (!force) {
      const state = this.db.prepare(
        `SELECT last_synced_at FROM registry_sync_state WHERE registry_id = ?`
      ).get(registry.id) as { last_synced_at: number } | undefined

      if (state?.last_synced_at && (Date.now() - state.last_synced_at) < ttlMs) {
        console.log('[SyncService] syncOne:skip-fresh', {
          registryId: registry.id,
          ttlMs,
          ageMs: Date.now() - state.last_synced_at,
        })
        return // still fresh
      }
    }

    let release!: () => void
    this.syncing.set(registry.id, new Promise<void>(resolve => { release = resolve }))
    this.emit(registry.id, 'syncing', 0)

    console.log('[SyncService] syncOne:start', {
      registryId: registry.id,
      registryName: registry.name,
      strategy: getAdapter(registry).strategy,
      ttlMs,
      force,
    })

    try {
      const adapter = getAdapter(registry)
      if (!adapter.fetchIndex) {
        throw new Error(`Adapter for ${registry.id} does not support fetchIndex`)
      }

      const t0 = performance.now()
      const index = await adapter.fetchIndex(registry)
      const entries = index.apps.filter(e => e.format === 'bundle')

      // Remove old FTS entries BEFORE replacing registry_items rows.
      // This is critical: removeFtsForRegistry reads current rowids while the old
      // rows still exist. After batchInsert deletes them, those rowids are gone and
      // SQLite may reuse them for the new batch — leaving stale FTS entries orphaned.
      this.removeFtsForRegistry(registry.id)

      // Batch write into SQLite (internally clears old rows, then inserts new ones)
      this.batchInsert(registry.id, entries)

      // Add FTS entries for the freshly inserted rows
      this.addFtsForRegistry(registry.id)

      const dt = performance.now() - t0
      console.log(`[SyncService] Synced "${registry.name}": ${entries.length} entries in ${dt.toFixed(0)}ms`)
      console.log('[SyncService] syncOne:success', {
        registryId: registry.id,
        registryName: registry.name,
        entryCount: entries.length,
        durationMs: Math.round(dt),
      })

      this.emit(registry.id, 'idle', entries.length)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[SyncService] Sync failed for "${registry.name}": ${msg}`)
      console.error('[SyncService] syncOne:failed', {
        registryId: registry.id,
        registryName: registry.name,
        error: msg,
      })

      // Preserve old data, just update status
      const existing = this.db.prepare(
        `SELECT app_count FROM registry_sync_state WHERE registry_id = ?`
      ).get(registry.id) as { app_count: number } | undefined

      this.emit(registry.id, 'error', existing?.app_count ?? 0, msg)
    } finally {
      this.syncing.delete(registry.id)
      release()
      console.log('[SyncService] syncOne:finalize', { registryId: registry.id, inProgressCount: this.syncing.size })
    }
  }

  /**
   * Force refresh: clear cache for a registry and re-sync.
   */
  async forceSync(registry: RegistrySource): Promise<void> {
    // Remove FTS entries first — rowids are still valid at this point.
    // clearRegistryItems deletes the backing rows, after which the FTS rowids
    // would be un-resolvable by removeFtsForRegistry.
    this.removeFtsForRegistry(registry.id)
    this.clearRegistryItems(registry.id)
    await this.syncOne(registry, 0, true)
  }

  /**
   * Clear all cached data and re-sync all Mirror sources.
   */
  async forceSyncAll(registries: RegistrySource[]): Promise<void> {
    this.db.exec(`DELETE FROM registry_items`)
    this.db.exec(`DELETE FROM registry_items_fts`)
    this.db.exec(`DELETE FROM registry_query_cache`)
    this.db.exec(`DELETE FROM registry_spec_cache`)
    this.db.exec(`DELETE FROM registry_sync_state`)
    await this.syncAll(registries, 0)
  }

  /**
   * Clear Proxy source query cache for a specific registry.
   */
  clearProxyCache(registryId: string): void {
    this.db.prepare(`DELETE FROM registry_query_cache WHERE registry_id = ?`).run(registryId)
  }

  /**
   * Clear all cached data for a specific registry.
   *
   * Removes: FTS entries, registry_items, sync state, spec cache, and query cache.
   * Used when a registry source is removed, hidden, or has its URL changed —
   * any scenario where the old cached data is no longer valid.
   */
  clearRegistryData(registryId: string): void {
    this.removeFtsForRegistry(registryId)
    this.clearRegistryItems(registryId)
    this.db.prepare(`DELETE FROM registry_sync_state WHERE registry_id = ?`).run(registryId)
    this.db.prepare(`DELETE FROM registry_spec_cache WHERE registry_id = ?`).run(registryId)
    this.db.prepare(`DELETE FROM registry_query_cache WHERE registry_id = ?`).run(registryId)
    console.log(`[SyncService] Cleared all cached data for registry "${registryId}"`)
  }

  /**
   * Get sync state for all registries.
   */
  getSyncStates(): Array<{ registryId: string; status: string; appCount: number; lastSyncedAt: number | null }> {
    return this.db.prepare(
      `SELECT registry_id AS registryId, status, app_count AS appCount, last_synced_at AS lastSyncedAt FROM registry_sync_state`
    ).all() as Array<{
      registryId: string; status: string; appCount: number; lastSyncedAt: number | null
    }>
  }

  // ── Private ────────────────────────────────────────────────────────────

  private clearRegistryItems(registryId: string): void {
    this.db.prepare(`DELETE FROM registry_items WHERE registry_id = ?`).run(registryId)
  }

  private batchInsert(registryId: string, entries: RegistryEntry[]): void {
    const now = Date.now()

    // Delete existing entries for this registry first (in a batch)
    this.clearRegistryItems(registryId)

    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO registry_items (
        pk, slug, registry_id, name, description, author, tags,
        type, category, rank, version, icon, locale,
        format, path, download_url, size_bytes, checksum,
        requires_mcps, requires_skills,
        created_at, updated_at, i18n, meta, indexed_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?, ?, ?
      )
    `)

    // Process in batches
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const batch = entries.slice(i, i + BATCH_SIZE)
      const runBatch = this.db.transaction(() => {
        for (const e of batch) {
          const rank = resolveRank(e)
          insert.run(
            `${registryId}:${e.slug}`,
            e.slug,
            registryId,
            e.name,
            e.description,
            e.author,
            JSON.stringify(e.tags ?? []),
            e.type,
            e.category ?? 'other',
            rank === Infinity ? null : rank,
            e.version,
            e.icon ?? null,
            e.locale ?? null,
            e.format,
            e.path,
            e.download_url ?? null,
            e.size_bytes ?? null,
            e.checksum ?? null,
            e.requires_mcps ? JSON.stringify(e.requires_mcps) : null,
            e.requires_skills ? JSON.stringify(e.requires_skills) : null,
            e.created_at ?? null,
            e.updated_at ?? null,
            e.i18n ? JSON.stringify(e.i18n) : null,
            e.meta ? JSON.stringify(e.meta) : null,
            now,
          )
        }
      })
      runBatch()
    }
  }

  /**
   * Phase 1 of FTS rebuild: remove FTS entries for a registry.
   *
   * MUST be called BEFORE batchInsert/clearRegistryItems so that the current
   * registry_items rowids are still valid and FTS can find the entries to delete.
   * After batchInsert deletes the backing rows, those rowids vanish and SQLite
   * may reissue them to new rows — leaving old FTS terms orphaned.
   */
  private removeFtsForRegistry(registryId: string): void {
    const rows = this.db.prepare(
      `SELECT rowid FROM registry_items WHERE registry_id = ?`
    ).all(registryId) as Array<{ rowid: number }>

    if (rows.length === 0) return

    const deleteFts = this.db.prepare(
      `DELETE FROM registry_items_fts WHERE rowid = ?`
    )
    const txn = this.db.transaction(() => {
      for (const row of rows) {
        try { deleteFts.run(row.rowid) } catch { /* ignore if entry absent */ }
      }
    })
    txn()
  }

  /**
   * Phase 2 of FTS rebuild: insert FTS entries for the freshly written rows.
   *
   * MUST be called AFTER batchInsert so that the new rowids are in place.
   */
  private addFtsForRegistry(registryId: string): void {
    const rows = this.db.prepare(
      `SELECT rowid, name, description, author, tags FROM registry_items WHERE registry_id = ?`
    ).all(registryId) as Array<{ rowid: number; name: string; description: string; author: string; tags: string }>

    if (rows.length === 0) return

    const insertFts = this.db.prepare(
      `INSERT INTO registry_items_fts (rowid, name, description, author, tags) VALUES (?, ?, ?, ?, ?)`
    )
    const txn = this.db.transaction(() => {
      for (const row of rows) {
        insertFts.run(row.rowid, row.name, row.description, row.author, row.tags)
      }
    })
    txn()
  }
}

function resolveRank(entry: RegistryEntry): number {
  const rank = entry.meta?.rank
  if (typeof rank === 'number' && Number.isFinite(rank) && rank >= 0 && Number.isInteger(rank)) {
    return rank
  }
  return Infinity
}
