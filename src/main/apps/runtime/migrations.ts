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
  {
    version: 6,
    description: 'Index task activity and exclude closed decisions from pending lookup',
    up(db) {
      db.exec(`
        DROP INDEX idx_entries_pending_escalation;
        CREATE INDEX idx_entries_pending_escalation ON activity_entries(app_id, ts)
          WHERE type = 'escalation' AND user_response_json IS NULL
            AND json_extract(content_json, '$.resolution') IS NULL;
        CREATE INDEX idx_entries_task ON activity_entries(
          app_id, json_extract(content_json, '$.teamContext.teamId'),
          json_extract(content_json, '$.teamContext.epochId'), ts DESC
        );
      `)
    },
  },
  {
    version: 7,
    description: 'Durable decision continuations, independent deadlines and retained migration audit',
    up(db) {
      db.exec(`
        ALTER TABLE automation_runs ADD COLUMN environment_json TEXT;
        ALTER TABLE automation_runs ADD COLUMN stopped_at INTEGER;
        CREATE TABLE app_session_environments (
          session_key TEXT PRIMARY KEY,
          app_id TEXT NOT NULL REFERENCES installed_apps(id) ON DELETE CASCADE,
          environment_json TEXT NOT NULL
        );
        CREATE TABLE runtime_closed_runs (run_id TEXT PRIMARY KEY, closed_at INTEGER NOT NULL);
        CREATE TABLE decision_continuations (
          entry_id TEXT PRIMARY KEY REFERENCES activity_entries(id) ON DELETE CASCADE,
          app_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued',
          attempts INTEGER NOT NULL DEFAULT 0,
          receipt_published INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          error TEXT
        );
        CREATE INDEX idx_continuations_pending ON decision_continuations(status, updated_at);
        CREATE INDEX idx_continuations_app ON decision_continuations(app_id, status);
        CREATE TABLE runtime_legacy_deadlines (
          app_id TEXT PRIMARY KEY,
          timeout_hours REAL NOT NULL
        );
        INSERT INTO runtime_legacy_deadlines SELECT id,
          COALESCE(json_extract(spec_json, '$.escalation.timeout_hours'), 24)
          FROM installed_apps WHERE json_extract(spec_json, '$.type') = 'automation';
        CREATE TABLE runtime_decision_migration_backup AS
          SELECT id, content_json, user_response_json FROM activity_entries;
      `)
      const now = Date.now()
      type LegacyEntry = {
        id: string; app_id: string; run_id: string; session_key: string | null;
        run_session_key: string | null; type: string; ts: number; entry_rowid: number;
        content_json: string; user_response_json: string | null; timeout_hours: number | null
      }
      const entries = db.prepare(`SELECT e.*, e.rowid AS entry_rowid, r.session_key AS run_session_key,
        l.timeout_hours FROM activity_entries e
        LEFT JOIN automation_runs r ON r.run_id = e.run_id
        LEFT JOIN runtime_legacy_deadlines l ON l.app_id = e.app_id
        WHERE e.rowid > ? ORDER BY e.rowid LIMIT 200`)
      const update = db.prepare('UPDATE activity_entries SET content_json = ?, user_response_json = ? WHERE id = ?')
      let migrated = 0
      let cursor = 0
      for (;;) {
        const rows = entries.all(cursor) as LegacyEntry[]
        if (rows.length === 0) break
        for (const row of rows) {
          migrated++
          const content = JSON.parse(row.content_json)
          const team = content.teamContext
          content.source ??= team?.teamId && team?.epochId
            ? { kind: 'team', appId: row.app_id, teamId: team.teamId, epochId: team.epochId, taskId: team.taskId, memberId: row.app_id, sessionKey: row.session_key ?? undefined }
            : row.run_session_key
              ? { kind: 'automation', appId: row.app_id, runId: row.run_id, sessionKey: row.run_session_key }
              : { kind: 'unknown', appId: row.app_id, sessionKey: row.session_key ?? undefined }
          let response = row.user_response_json
          if (row.type === 'escalation' && response) {
            const answer = JSON.parse(response)
            const exactSystemResponse = answer.text === '[Auto-closed] Escalation orphaned by app state change.' ||
              /^\[Auto-closed\] User did not respond within \d+(?:\.\d+)? (?:day\(s\)|hour\(s\))\.$/.test(answer.text ?? '')
            if (exactSystemResponse && typeof answer.ts === 'number' && !answer.choice && !answer.answers && Object.keys(answer).every(key => key === 'text' || key === 'ts')) {
              content.resolution = { reason: 'legacy_system_closed', ts: answer.ts, legacyText: answer.text, attribution: 'unverified' }
              response = null
            }
          }
          if (row.type === 'escalation' && !response && !content.resolution && !team && row.timeout_hours != null) {
            content.deadlineAt = row.ts + row.timeout_hours * 3600000
            if (content.deadlineAt <= now) {
              content.deadlineReviewRequired = true
              content.deadlineReview = { originalDeadlineAt: content.deadlineAt }
            }
          }
          update.run(JSON.stringify(content), response, row.id)
          cursor = row.entry_rowid
        }
      }
      console.log('[Runtime] Decision migration completed', { entries: migrated, auditTable: 'runtime_decision_migration_backup' })
    },
  },

]
