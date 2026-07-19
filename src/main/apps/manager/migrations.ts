/**
 * apps/manager -- Database Migrations
 *
 * Schema migrations for the installed_apps table.
 * Uses the 'app_manager' namespace in the _migrations meta-table.
 *
 * Migration rules:
 * - Versions are sequential positive integers starting from 1
 * - Never modify an existing migration -- add a new version instead
 * - Each migration runs inside a transaction (handled by DatabaseManager)
 */

import type { Migration } from '../../platform/store'

/** Migration namespace used with DatabaseManager.runMigrations() */
export const MIGRATION_NAMESPACE = 'app_manager'

/**
 * All migrations for the app_manager module.
 * Sorted by version (required by DatabaseManager but it also sorts internally).
 */
export const migrations: Migration[] = [
  {
    version: 1,
    description: 'Create installed_apps table with indexes',
    up(db) {
      db.exec(`
        CREATE TABLE installed_apps (
          id TEXT PRIMARY KEY,
          spec_id TEXT NOT NULL,
          space_id TEXT NOT NULL,
          spec_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          pending_escalation_id TEXT,
          user_config_json TEXT NOT NULL DEFAULT '{}',
          user_overrides_json TEXT NOT NULL DEFAULT '{}',
          permissions_json TEXT NOT NULL DEFAULT '{"granted":[],"denied":[]}',
          installed_at INTEGER NOT NULL,
          last_run_at INTEGER,
          last_run_outcome TEXT,
          error_message TEXT,
          UNIQUE(spec_id, space_id)
        )
      `)

      db.exec(`
        CREATE INDEX idx_installed_apps_space
          ON installed_apps(space_id)
      `)

      db.exec(`
        CREATE INDEX idx_installed_apps_status
          ON installed_apps(status)
      `)
    }
  },
  {
    version: 2,
    description: 'Add uninstalled_at column for soft-delete lifecycle',
    up(db) {
      db.exec(`
        ALTER TABLE installed_apps ADD COLUMN uninstalled_at INTEGER
      `)
    }
  },
  {
    version: 3,
    description: 'Make space_id nullable for global apps (MCP/Skill) and add partial unique indexes',
    up(db) {
      // SQLite does not support ALTER COLUMN to change NOT NULL → nullable.
      // Recreate the table with space_id TEXT (nullable), migrate data,
      // drop old table, rename new, rebuild indexes.

      db.exec(`
        CREATE TABLE installed_apps_v3 (
          id TEXT PRIMARY KEY,
          spec_id TEXT NOT NULL,
          space_id TEXT,
          spec_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          pending_escalation_id TEXT,
          user_config_json TEXT NOT NULL DEFAULT '{}',
          user_overrides_json TEXT NOT NULL DEFAULT '{}',
          permissions_json TEXT NOT NULL DEFAULT '{"granted":[],"denied":[]}',
          installed_at INTEGER NOT NULL,
          last_run_at INTEGER,
          last_run_outcome TEXT,
          error_message TEXT,
          uninstalled_at INTEGER
        )
      `)

      db.exec(`
        INSERT INTO installed_apps_v3
        SELECT id, spec_id, space_id, spec_json, status,
               pending_escalation_id, user_config_json, user_overrides_json,
               permissions_json, installed_at, last_run_at, last_run_outcome,
               error_message, uninstalled_at
        FROM installed_apps
      `)

      db.exec(`DROP TABLE installed_apps`)
      db.exec(`ALTER TABLE installed_apps_v3 RENAME TO installed_apps`)

      // Partial unique index: one global app per spec_id (space_id IS NULL)
      db.exec(`
        CREATE UNIQUE INDEX idx_installed_apps_spec_global
          ON installed_apps(spec_id)
          WHERE space_id IS NULL
      `)

      // Partial unique index: one app per spec_id per space (space_id IS NOT NULL)
      db.exec(`
        CREATE UNIQUE INDEX idx_installed_apps_spec_space
          ON installed_apps(spec_id, space_id)
          WHERE space_id IS NOT NULL
      `)

      // Rebuild general indexes
      db.exec(`
        CREATE INDEX idx_installed_apps_space
          ON installed_apps(space_id)
      `)
      db.exec(`
        CREATE INDEX idx_installed_apps_status
          ON installed_apps(status)
      `)
    }
  },
  {
    version: 4,
    description: 'Add upgrade_strategy column for per-app upgrade policy',
    up(db) {
      // Default 'auto': patch/minor silent install, major notify.
      // Backfills existing rows. SQLite ALTER ADD COLUMN with DEFAULT is safe here
      // because the column is NOT NULL but every existing row receives the default.
      db.exec(`
        ALTER TABLE installed_apps
        ADD COLUMN upgrade_strategy TEXT NOT NULL DEFAULT 'auto'
      `)
    }
  }
]
