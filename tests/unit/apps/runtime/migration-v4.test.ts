/**
 * Unit tests for apps/runtime migration v4: rebuilds activity_entries without
 * the run_id FK. The rebuild runs with foreign_keys=ON inside the migration
 * transaction, so it must tolerate orphan rows (app_id no longer in
 * installed_apps) left by a pre-FK-enforcement era — a real-world DB with one
 * such row previously aborted the whole migration batch and blocked startup.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../src/main/platform/store/types'
import {
  MIGRATION_NAMESPACE as MANAGER_NAMESPACE,
  migrations as managerMigrations,
} from '../../../../src/main/apps/manager/migrations'
import {
  MIGRATION_NAMESPACE as RUNTIME_NAMESPACE,
  migrations as runtimeMigrations,
} from '../../../../src/main/apps/runtime/migrations'

const APP_ID = 'app-live'
const GHOST_APP_ID = 'app-uninstalled-ghost'
const RUN_ID = 'run-1'

function insertApp(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO installed_apps (id, spec_id, space_id, spec_json, installed_at)
     VALUES (?, ?, 'space-a', '{}', ?)`
  ).run(id, `spec-${id}`, Date.now())
}

function insertRun(db: Database.Database, runId: string, appId: string): void {
  db.prepare(
    `INSERT INTO automation_runs (run_id, app_id, session_key, trigger_type, started_at)
     VALUES (?, ?, 'sk', 'schedule', ?)`
  ).run(runId, appId, Date.now())
}

function insertEntry(db: Database.Database, id: string, appId: string, runId: string): void {
  db.prepare(
    `INSERT INTO activity_entries (id, app_id, run_id, type, ts, content_json)
     VALUES (?, ?, ?, 'report', ?, '{}')`
  ).run(id, appId, runId, Date.now())
}

function countEntries(db: Database.Database, appId: string): number {
  return (
    db.prepare('SELECT COUNT(*) AS n FROM activity_entries WHERE app_id = ?').get(appId) as {
      n: number
    }
  ).n
}

describe('apps/runtime migration v4 (activity_entries rebuild)', () => {
  let dbManager: DatabaseManager
  let db: Database.Database

  beforeEach(() => {
    dbManager = createDatabaseManager(':memory:')
    db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, MANAGER_NAMESPACE, managerMigrations)
    // Stop at v3: the exact released schema (run_id FK still present).
    dbManager.runMigrations(
      db,
      RUNTIME_NAMESPACE,
      runtimeMigrations.filter((m) => m.version <= 3)
    )
    insertApp(db, APP_ID)
    insertRun(db, RUN_ID, APP_ID)
    insertEntry(db, 'entry-valid', APP_ID, RUN_ID)
    // Orphan seeded the way real ones came to exist: written while FK
    // enforcement was off, with its owning app uninstalled since.
    db.pragma('foreign_keys = OFF')
    insertEntry(db, 'entry-orphan', GHOST_APP_ID, 'run-ghost')
    db.pragma('foreign_keys = ON')
  })

  afterEach(() => {
    dbManager.closeAll()
  })

  it('completes v4 with an orphan row present (regression: startup abort)', () => {
    expect(countEntries(db, GHOST_APP_ID)).toBe(1)
    expect(() => dbManager.runMigrations(db, RUNTIME_NAMESPACE, runtimeMigrations)).not.toThrow()
    const row = db
      .prepare('SELECT version FROM _migrations WHERE namespace = ?')
      .get(RUNTIME_NAMESPACE) as { version: number }
    // The orphan must not stop the chain: every migration lands, not just v4.
    expect(row.version).toBe(Math.max(...runtimeMigrations.map((m) => m.version)))
  })

  it('keeps valid entries and drops orphans', () => {
    dbManager.runMigrations(db, RUNTIME_NAMESPACE, runtimeMigrations)
    expect(countEntries(db, APP_ID)).toBe(1)
    expect(countEntries(db, GHOST_APP_ID)).toBe(0)
  })

  it('allows sentinel run_id inserts after v4 (chat/team reports)', () => {
    dbManager.runMigrations(db, RUNTIME_NAMESPACE, runtimeMigrations)
    expect(() => insertEntry(db, 'entry-chat', APP_ID, 'chat')).not.toThrow()
  })

  it('retains the app_id FK: unknown app rejected, app delete cascades', () => {
    dbManager.runMigrations(db, RUNTIME_NAMESPACE, runtimeMigrations)
    expect(() => insertEntry(db, 'entry-bad', 'app-unknown', 'chat')).toThrow(/FOREIGN KEY/)
    db.prepare('DELETE FROM installed_apps WHERE id = ?').run(APP_ID)
    expect(countEntries(db, APP_ID)).toBe(0)
  })
})
