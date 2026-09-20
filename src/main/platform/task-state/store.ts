/**
 * task-state -- SQLite Store
 *
 * Low-level CRUD operations for the conversation_task_state table.
 * All methods are synchronous (better-sqlite3 is a synchronous API).
 * The store does not enforce business rules -- that is the service layer's job.
 */

import type Database from 'better-sqlite3'
import type { ConversationTaskState } from './types'

interface TaskStateRow {
  conversation_id: string
  space_id: string
  title: string
  state: string
  original_status: string | null
  read_at: number | null
  kept: number
  updated_at: number
}

function rowToTaskState(row: TaskStateRow): ConversationTaskState {
  return {
    conversationId: row.conversation_id,
    spaceId: row.space_id,
    title: row.title,
    state: row.state as ConversationTaskState['state'],
    originalStatus: row.original_status as ConversationTaskState['originalStatus'],
    readAt: row.read_at,
    kept: row.kept === 1,
    updatedAt: row.updated_at,
  }
}

export class TaskStateStore {
  private readonly stmtUpsertUnseen: Database.Statement
  private readonly stmtUpsertRead: Database.Statement
  private readonly stmtSetKept: Database.Statement
  private readonly stmtDelete: Database.Statement
  private readonly stmtDeleteAllInSpace: Database.Statement
  private readonly stmtDeleteExpiredRead: Database.Statement
  private readonly stmtListAll: Database.Statement

  constructor(private readonly db: Database.Database) {
    this.stmtUpsertUnseen = db.prepare(`
      INSERT INTO conversation_task_state (
        conversation_id, space_id, title, state, original_status, read_at, kept, updated_at
      ) VALUES (
        @conversation_id, @space_id, @title, 'unseen', 'completed-unseen', NULL, 0, @updated_at
      )
      ON CONFLICT(conversation_id) DO UPDATE SET
        space_id = excluded.space_id,
        title = excluded.title,
        state = 'unseen',
        original_status = 'completed-unseen',
        read_at = NULL,
        kept = 0,
        updated_at = excluded.updated_at
    `)

    this.stmtUpsertRead = db.prepare(`
      INSERT INTO conversation_task_state (
        conversation_id, space_id, title, state, original_status, read_at, kept, updated_at
      ) VALUES (
        @conversation_id, @space_id, @title, 'read', @original_status, @read_at, 0, @updated_at
      )
      ON CONFLICT(conversation_id) DO UPDATE SET
        space_id = excluded.space_id,
        title = excluded.title,
        state = 'read',
        original_status = excluded.original_status,
        read_at = excluded.read_at,
        kept = 0,
        updated_at = excluded.updated_at
    `)

    this.stmtSetKept = db.prepare(`
      UPDATE conversation_task_state
      SET kept = @kept, updated_at = @updated_at
      WHERE conversation_id = @conversation_id AND state = 'read'
    `)

    this.stmtDelete = db.prepare(`
      DELETE FROM conversation_task_state WHERE conversation_id = ?
    `)

    this.stmtDeleteAllInSpace = db.prepare(`
      DELETE FROM conversation_task_state WHERE space_id = ?
    `)

    this.stmtDeleteExpiredRead = db.prepare(`
      DELETE FROM conversation_task_state
      WHERE state = 'read' AND kept = 0 AND read_at IS NOT NULL AND read_at < ?
    `)

    this.stmtListAll = db.prepare(`
      SELECT * FROM conversation_task_state
    `)
  }

  /** Mark a conversation as completed-but-unseen. Replaces any prior row for it. */
  upsertUnseen(conversationId: string, spaceId: string, title: string, updatedAt: number): void {
    this.stmtUpsertUnseen.run({
      conversation_id: conversationId,
      space_id: spaceId,
      title,
      updated_at: updatedAt,
    })
  }

  /**
   * Mark a conversation as read, starting (or restarting) its post-view
   * grace period. Used both when transitioning an 'unseen' row and when a
   * live session error is acknowledged (which never had an 'unseen' row).
   */
  upsertRead(
    conversationId: string,
    spaceId: string,
    title: string,
    originalStatus: 'completed-unseen' | 'error',
    readAt: number
  ): void {
    this.stmtUpsertRead.run({
      conversation_id: conversationId,
      space_id: spaceId,
      title,
      original_status: originalStatus,
      read_at: readAt,
      updated_at: readAt,
    })
  }

  /** No-op if the row does not exist or is not in the 'read' state. */
  setKept(conversationId: string, kept: boolean): void {
    this.stmtSetKept.run({
      conversation_id: conversationId,
      kept: kept ? 1 : 0,
      updated_at: Date.now(),
    })
  }

  remove(conversationId: string): void {
    this.stmtDelete.run(conversationId)
  }

  deleteAllInSpace(spaceId: string): void {
    this.stmtDeleteAllInSpace.run(spaceId)
  }

  /** Deletes expired, non-kept 'read' rows. Returns the number of rows removed. */
  deleteExpiredRead(graceMs: number): number {
    const cutoff = Date.now() - graceMs
    return this.stmtDeleteExpiredRead.run(cutoff).changes
  }

  list(): ConversationTaskState[] {
    return (this.stmtListAll.all() as TaskStateRow[]).map(rowToTaskState)
  }
}
