/**
 * Store Cache SQLite Schema
 *
 * Defines the migration for the store-cache namespace.
 * All tables are pure cache — can be dropped and rebuilt at any time.
 *
 * Tables:
 *   registry_items       — Mirror source entries (FTS5 searchable)
 *   registry_query_cache — Proxy source query result cache (LRU)
 *   registry_sync_state  — Per-registry sync status
 *   registry_spec_cache  — Spec detail cache
 */

import type { Migration } from '../platform/store/types'

export const STORE_CACHE_NAMESPACE = 'store-cache'

export const storeCacheMigrations: Migration[] = [
  {
    version: 1,
    description: 'Create store cache tables',
    up(db) {
      // ── registry_items (Mirror sources) ──────────────────────────────
      db.exec(`
        CREATE TABLE IF NOT EXISTS registry_items (
          pk            TEXT PRIMARY KEY,
          slug          TEXT NOT NULL,
          registry_id   TEXT NOT NULL,
          name          TEXT NOT NULL,
          description   TEXT NOT NULL,
          author        TEXT NOT NULL,
          tags          TEXT NOT NULL DEFAULT '[]',
          type          TEXT NOT NULL,
          category      TEXT NOT NULL DEFAULT 'other',
          rank          INTEGER,
          version       TEXT NOT NULL,
          icon          TEXT,
          locale        TEXT,
          format        TEXT NOT NULL DEFAULT 'bundle',
          path          TEXT NOT NULL,
          download_url  TEXT,
          size_bytes    INTEGER,
          checksum      TEXT,
          requires_mcps   TEXT,
          requires_skills TEXT,
          created_at    TEXT,
          updated_at    TEXT,
          i18n          TEXT,
          meta          TEXT,
          indexed_at    INTEGER NOT NULL
        )
      `)

      db.exec(`CREATE INDEX IF NOT EXISTS idx_items_type ON registry_items(type)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_items_category ON registry_items(category)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_items_type_cat ON registry_items(type, category)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_items_registry ON registry_items(registry_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_items_rank ON registry_items(type, rank)`)

      // FTS5 full-text search
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS registry_items_fts USING fts5(
          name, description, author, tags,
          content='registry_items',
          content_rowid='rowid'
        )
      `)

      // ── registry_query_cache (Proxy sources) ─────────────────────────
      db.exec(`
        CREATE TABLE IF NOT EXISTS registry_query_cache (
          cache_key     TEXT PRIMARY KEY,
          registry_id   TEXT NOT NULL,
          query_params  TEXT NOT NULL,
          results       TEXT NOT NULL,
          total_count   INTEGER,
          has_more      INTEGER NOT NULL DEFAULT 0,
          cached_at     INTEGER NOT NULL,
          ttl_ms        INTEGER NOT NULL
        )
      `)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_qcache_registry ON registry_query_cache(registry_id)`)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_qcache_expire ON registry_query_cache(cached_at)`)

      // ── registry_sync_state ──────────────────────────────────────────
      db.exec(`
        CREATE TABLE IF NOT EXISTS registry_sync_state (
          registry_id    TEXT PRIMARY KEY,
          strategy       TEXT NOT NULL,
          status         TEXT NOT NULL DEFAULT 'idle',
          last_synced_at INTEGER,
          app_count      INTEGER DEFAULT 0,
          error_message  TEXT,
          etag           TEXT,
          last_modified  TEXT
        )
      `)

      // ── registry_spec_cache ──────────────────────────────────────────
      db.exec(`
        CREATE TABLE IF NOT EXISTS registry_spec_cache (
          pk            TEXT PRIMARY KEY,
          registry_id   TEXT NOT NULL,
          spec_json     TEXT NOT NULL,
          version       TEXT NOT NULL,
          cached_at     INTEGER NOT NULL,
          ttl_ms        INTEGER NOT NULL DEFAULT 86400000
        )
      `)
      db.exec(`CREATE INDEX IF NOT EXISTS idx_spec_registry ON registry_spec_cache(registry_id)`)
    },
  },
  {
    version: 2,
    description: 'Add display_name to registry_items',
    up(db) {
      // The cache is a column projection of RegistryEntry, so a field missing
      // here is silently dropped between sync and render — a skill whose
      // canonical name is its ASCII command would keep showing that command
      // instead of its authored name.
      db.exec(`ALTER TABLE registry_items ADD COLUMN display_name TEXT`)
      // Rows written before the column existed carry no value, and a mirror
      // only re-syncs once its TTL lapses. Dropping the sync state marks every
      // source stale so the next pass backfills instead of showing canonical
      // names for up to an hour.
      db.exec(`DELETE FROM registry_sync_state`)
    },
  },
]
