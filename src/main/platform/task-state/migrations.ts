/**
 * task-state -- Database Migrations
 *
 * Schema migrations for the conversation_task_state table.
 * Uses the 'task_state' namespace in the _migrations meta-table.
 *
 * Migration rules:
 * - Versions are sequential positive integers starting from 1
 * - Never modify an existing migration -- add a new version instead
 * - Each migration runs inside a transaction (handled by DatabaseManager)
 */

import type { Migration } from '../store'

/** Migration namespace used with DatabaseManager.runMigrations() */
export const MIGRATION_NAMESPACE = 'task_state'

export const migrations: Migration[] = [
  {
    version: 1,
    description: 'Create conversation_task_state table with space index',
    up(db) {
      db.exec(`
        CREATE TABLE conversation_task_state (
          conversation_id TEXT PRIMARY KEY,
          space_id TEXT NOT NULL,
          title TEXT NOT NULL,
          state TEXT NOT NULL,
          original_status TEXT,
          read_at INTEGER,
          kept INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL
        )
      `)

      db.exec(`
        CREATE INDEX idx_task_state_space
          ON conversation_task_state(space_id)
      `)
    }
  }
]
