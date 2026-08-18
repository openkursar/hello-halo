/**
 * apps/runtime -- Database Migrations
 *
 * Schema for the activity layer: automation_runs + activity_entries.
 * Uses the same migration pattern as platform/store and apps/manager.
 */

import type { Migration } from '../../platform/store'

export const MIGRATION_NAMESPACE = 'app_runtime'

export const migrations: Migration[] = [
  {
    version: 1,
    description: 'Create automation_runs and activity_entries tables',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS automation_runs (
          run_id TEXT PRIMARY KEY,
          app_id TEXT NOT NULL,
          session_key TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'running',
          trigger_type TEXT NOT NULL,
          trigger_data_json TEXT,
          started_at INTEGER NOT NULL,
          finished_at INTEGER,
          duration_ms INTEGER,
          tokens_used INTEGER,
          error_message TEXT,
          FOREIGN KEY (app_id) REFERENCES installed_apps(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_runs_app ON automation_runs(app_id, started_at DESC);

        CREATE TABLE IF NOT EXISTS activity_entries (
          id TEXT PRIMARY KEY,
          app_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          type TEXT NOT NULL,
          ts INTEGER NOT NULL,
          session_key TEXT,
          content_json TEXT NOT NULL,
          user_response_json TEXT,
          FOREIGN KEY (app_id) REFERENCES installed_apps(id) ON DELETE CASCADE,
          FOREIGN KEY (run_id) REFERENCES automation_runs(run_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_entries_app ON activity_entries(app_id, ts DESC);
      `)
    },
  },
  {
    version: 2,
    description: 'Add indexes for run_id lookup and status filtering',
    up(db) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_entries_run ON activity_entries(run_id);
        CREATE INDEX IF NOT EXISTS idx_runs_status ON automation_runs(status);
      `)
    },
  },
  {
    version: 3,
    description: 'Add session_id column for escalation context recovery',
    up(db) {
      db.exec(`ALTER TABLE automation_runs ADD COLUMN session_id TEXT`)
    },
  },
  {
    version: 4,
    description: 'Drop activity_entries.run_id FK so chat/team report entries persist',
    // Chat/team reports use a sentinel run_id ('chat') with no automation_runs
    // parent, so the FK rejected every such insert. Entries are owned by app_id
    // (CASCADE kept); run cleanup is handled explicitly in pruneOldData.
    // activity_entries is a leaf table, so dropping the run_id FK is safe.
    // The rebuild runs with foreign_keys=ON inside a transaction (PRAGMA can't be
    // toggled there), so the copy filters rows whose app_id no longer exists —
    // orphans left by a pre-FK insert would otherwise fail the retained app_id FK
    // and abort the whole migration.
    up(db) {
      db.exec(`
        CREATE TABLE activity_entries_v4 (
          id TEXT PRIMARY KEY,
          app_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          type TEXT NOT NULL,
          ts INTEGER NOT NULL,
          session_key TEXT,
          content_json TEXT NOT NULL,
          user_response_json TEXT,
          FOREIGN KEY (app_id) REFERENCES installed_apps(id) ON DELETE CASCADE
        );
        INSERT INTO activity_entries_v4
          (id, app_id, run_id, type, ts, session_key, content_json, user_response_json)
          SELECT id, app_id, run_id, type, ts, session_key, content_json, user_response_json
          FROM activity_entries
          WHERE app_id IN (SELECT id FROM installed_apps);
        DROP TABLE activity_entries;
        ALTER TABLE activity_entries_v4 RENAME TO activity_entries;
        CREATE INDEX IF NOT EXISTS idx_entries_app ON activity_entries(app_id, ts DESC);
        CREATE INDEX IF NOT EXISTS idx_entries_run ON activity_entries(run_id);
      `)
    },
  },
  {
    version: 5,
    description: 'Index unanswered escalations so the open-question lookup stays cheap',
    // "Which questions are still waiting on a person" is read at every team turn
    // end and once per owned member at startup, and it scanned every activity row
    // ever written. A partial index keeps the cost proportional to the handful of
    // open questions rather than to the whole history.
    up(db) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_entries_pending_escalation
          ON activity_entries(ts)
          WHERE type = 'escalation' AND user_response_json IS NULL
      `)
    },
  },
]
