/**
 * apps/federation -- Authority / Replication SQLite Store
 *
 * CRUD for blackboard_replication_log (single-writer append log, read by
 * hot-standbys + a new authority for catch-up/recovery) and office_authority
 * (per-office term/authority/roster epoch + replication water marks). Election
 * and quorum policy lives in runtime/federation/authority; single-writer
 * discipline here means no in-process locking is needed.
 */

import type Database from 'better-sqlite3'
import type {
  AuthorityState,
  AuthorityStatePatch,
  AuthorityStateRow,
  AuthorityStore as IAuthorityStore,
  ReplicationLogEntry,
  ReplicationLogRow,
  ReplicationOpName,
} from './types'

function rowToEntry(row: ReplicationLogRow): ReplicationLogEntry {
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(row.payload) as Record<string, unknown>
  } catch {
    payload = {}
  }
  return {
    officeId: row.office_id,
    seq: row.seq,
    term: row.term,
    op: row.op as ReplicationOpName,
    payload,
    fid: row.fid,
    taskId: row.task_id,
    createdAt: row.created_at,
  }
}

function rowToAuthority(row: AuthorityStateRow): AuthorityState {
  return {
    officeId: row.office_id,
    term: row.term,
    authorityNodeId: row.authority_node_id,
    rosterEpoch: row.roster_epoch,
    committedSeq: row.committed_seq,
    appliedSeq: row.applied_seq,
    updatedAt: row.updated_at,
  }
}

export class AuthorityStore implements IAuthorityStore {
  private readonly stmtAppend: Database.Statement
  private readonly stmtMaxSeq: Database.Statement
  private readonly stmtMinSeq: Database.Statement
  private readonly stmtHasFid: Database.Statement
  private readonly stmtListAfter: Database.Statement
  private readonly stmtPruneBefore: Database.Statement
  private readonly stmtCountByTask: Database.Statement
  private readonly stmtGetAuthority: Database.Statement
  private readonly stmtUpsertAuthority: Database.Statement

  constructor(private readonly db: Database.Database) {
    this.stmtAppend = db.prepare(`
      INSERT INTO blackboard_replication_log (
        office_id, seq, term, op, payload, fid, task_id, created_at
      ) VALUES (
        @office_id, @seq, @term, @op, @payload, @fid, @task_id, @created_at
      )
    `)
    this.stmtMaxSeq = db.prepare(`
      SELECT COALESCE(MAX(seq), 0) AS m FROM blackboard_replication_log WHERE office_id = ?
    `)
    this.stmtMinSeq = db.prepare(`
      SELECT COALESCE(MIN(seq), 0) AS m FROM blackboard_replication_log WHERE office_id = ?
    `)
    this.stmtHasFid = db.prepare(`
      SELECT 1 FROM blackboard_replication_log WHERE office_id = ? AND fid = ? LIMIT 1
    `)
    this.stmtListAfter = db.prepare(`
      SELECT * FROM blackboard_replication_log
        WHERE office_id = ? AND seq > ?
        ORDER BY seq ASC
        LIMIT ?
    `)
    this.stmtPruneBefore = db.prepare(`
      DELETE FROM blackboard_replication_log WHERE office_id = ? AND seq <= ?
    `)
    this.stmtCountByTask = db.prepare(`
      SELECT COUNT(*) AS c FROM blackboard_replication_log WHERE office_id = ? AND task_id = ?
    `)
    this.stmtGetAuthority = db.prepare(`SELECT * FROM office_authority WHERE office_id = ?`)
    this.stmtUpsertAuthority = db.prepare(`
      INSERT INTO office_authority (
        office_id, term, authority_node_id, roster_epoch, committed_seq, applied_seq, updated_at
      ) VALUES (
        @office_id, @term, @authority_node_id, @roster_epoch, @committed_seq, @applied_seq, @updated_at
      )
      ON CONFLICT(office_id) DO UPDATE SET
        term = excluded.term,
        authority_node_id = excluded.authority_node_id,
        roster_epoch = excluded.roster_epoch,
        committed_seq = excluded.committed_seq,
        applied_seq = excluded.applied_seq,
        updated_at = excluded.updated_at
    `)
  }

  // ── blackboard_replication_log ──

  appendLogEntry(entry: ReplicationLogEntry): void {
    this.stmtAppend.run({
      office_id: entry.officeId,
      seq: entry.seq,
      term: entry.term,
      op: entry.op,
      payload: JSON.stringify(entry.payload),
      fid: entry.fid,
      task_id: entry.taskId,
      created_at: entry.createdAt,
    })
  }

  getMaxSeq(officeId: string): number {
    return (this.stmtMaxSeq.get(officeId) as { m: number }).m
  }

  getMinSeq(officeId: string): number {
    return (this.stmtMinSeq.get(officeId) as { m: number }).m
  }

  hasFid(officeId: string, fid: string): boolean {
    return this.stmtHasFid.get(officeId, fid) !== undefined
  }

  listLogAfter(officeId: string, afterSeq: number, limit: number): ReplicationLogEntry[] {
    return (this.stmtListAfter.all(officeId, afterSeq, limit) as ReplicationLogRow[]).map(rowToEntry)
  }

  pruneLogBefore(officeId: string, beforeSeq: number): number {
    return this.stmtPruneBefore.run(officeId, beforeSeq).changes
  }

  countByTaskId(officeId: string, taskId: string): number {
    return (this.stmtCountByTask.get(officeId, taskId) as { c: number }).c
  }

  // ── office_authority ──

  getAuthorityState(officeId: string): AuthorityState | null {
    const row = this.stmtGetAuthority.get(officeId) as AuthorityStateRow | undefined
    return row ? rowToAuthority(row) : null
  }

  patchAuthorityState(officeId: string, patch: AuthorityStatePatch, at: number): AuthorityState {
    const cur = this.getAuthorityState(officeId)
    const next: AuthorityState = {
      officeId,
      term: patch.term ?? cur?.term ?? 0,
      authorityNodeId:
        patch.authorityNodeId !== undefined ? patch.authorityNodeId : cur?.authorityNodeId ?? null,
      rosterEpoch: patch.rosterEpoch ?? cur?.rosterEpoch ?? 0,
      committedSeq: patch.committedSeq ?? cur?.committedSeq ?? 0,
      appliedSeq: patch.appliedSeq ?? cur?.appliedSeq ?? 0,
      updatedAt: at,
    }
    this.stmtUpsertAuthority.run({
      office_id: next.officeId,
      term: next.term,
      authority_node_id: next.authorityNodeId,
      roster_epoch: next.rosterEpoch,
      committed_seq: next.committedSeq,
      applied_seq: next.appliedSeq,
      updated_at: next.updatedAt,
    })
    return next
  }
}
