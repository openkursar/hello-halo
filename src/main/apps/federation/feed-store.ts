/**
 * apps/federation -- Unified Feed Substrate SQLite Store
 *
 * CRUD for the per-author append-only feed log (feed_log = the durable outbox),
 * its delivery/apply cursors (feed_peer_cursor / feed_local_cursor), the
 * viewer-side cache (feed_cache), and per-feed high-water marks (feed_meta).
 * Single-writer-per-feed discipline (only the author appends its own feed) means
 * no in-process locking is needed. Delivery, retention, and ordering policy live
 * in runtime/federation/log; this tier enforces only SQLite constraints.
 */

import type Database from 'better-sqlite3'
import type { FeedEntryRecord, FeedEntryRow, FeedMeta, FeedMetaRow, FeedStore as IFeedStore } from './types'

function rowToEntry(row: FeedEntryRow): FeedEntryRecord {
  let payload: unknown
  try {
    payload = JSON.parse(row.payload)
  } catch {
    payload = null
  }
  return {
    officeId: row.office_id,
    feedId: row.feed_id,
    seq: row.seq,
    hlc: row.hlc,
    fid: row.fid,
    type: row.type,
    payload,
    ts: row.ts,
    createdAt: row.created_at,
  }
}

export class FeedStore implements IFeedStore {
  private readonly stmtAppend: Database.Statement
  private readonly stmtMaxSeq: Database.Statement
  private readonly stmtMinSeq: Database.Statement
  private readonly stmtHasFid: Database.Statement
  private readonly stmtListAfter: Database.Statement
  private readonly stmtPruneBefore: Database.Statement
  private readonly stmtListLogFeedIds: Database.Statement
  private readonly stmtGetPeerCursor: Database.Statement
  private readonly stmtSetPeerCursor: Database.Statement
  private readonly stmtMinPeerCursor: Database.Statement
  private readonly stmtGetLocalCursor: Database.Statement
  private readonly stmtSetLocalCursor: Database.Statement
  private readonly stmtPutCache: Database.Statement
  private readonly stmtListCache: Database.Statement
  private readonly stmtCacheMaxSeq: Database.Statement
  private readonly stmtListCacheFeedIds: Database.Statement
  private readonly stmtGetMeta: Database.Statement
  private readonly stmtSetTruncated: Database.Statement
  private readonly stmtSetHlcHigh: Database.Statement
  private readonly stmtOfficeHlcHigh: Database.Statement

  constructor(private readonly db: Database.Database) {
    this.stmtAppend = db.prepare(`
      INSERT INTO feed_log (
        office_id, feed_id, seq, hlc, fid, type, payload, ts, created_at
      ) VALUES (
        @office_id, @feed_id, @seq, @hlc, @fid, @type, @payload, @ts, @created_at
      )
    `)
    this.stmtMaxSeq = db.prepare(`
      SELECT COALESCE(MAX(seq), 0) AS m FROM feed_log WHERE office_id = ? AND feed_id = ?
    `)
    this.stmtMinSeq = db.prepare(`
      SELECT COALESCE(MIN(seq), 0) AS m FROM feed_log WHERE office_id = ? AND feed_id = ?
    `)
    this.stmtHasFid = db.prepare(`
      SELECT 1 FROM feed_log WHERE office_id = ? AND feed_id = ? AND fid = ? LIMIT 1
    `)
    this.stmtListAfter = db.prepare(`
      SELECT * FROM feed_log
        WHERE office_id = ? AND feed_id = ? AND seq > ?
        ORDER BY seq ASC
        LIMIT ?
    `)
    this.stmtPruneBefore = db.prepare(`
      DELETE FROM feed_log WHERE office_id = ? AND feed_id = ? AND seq <= ?
    `)
    this.stmtListLogFeedIds = db.prepare(`
      SELECT DISTINCT feed_id FROM feed_log WHERE office_id = ?
    `)

    this.stmtGetPeerCursor = db.prepare(`
      SELECT acked_seq FROM feed_peer_cursor
        WHERE office_id = ? AND feed_id = ? AND peer_node = ?
    `)
    this.stmtSetPeerCursor = db.prepare(`
      INSERT INTO feed_peer_cursor (office_id, feed_id, peer_node, acked_seq, updated_at)
        VALUES (@office_id, @feed_id, @peer_node, @acked_seq, @updated_at)
      ON CONFLICT(office_id, feed_id, peer_node) DO UPDATE SET
        acked_seq = excluded.acked_seq,
        updated_at = excluded.updated_at
    `)
    this.stmtMinPeerCursor = db.prepare(`
      SELECT MIN(acked_seq) AS m FROM feed_peer_cursor WHERE office_id = ? AND feed_id = ?
    `)

    this.stmtGetLocalCursor = db.prepare(`
      SELECT applied_seq FROM feed_local_cursor WHERE office_id = ? AND feed_id = ?
    `)
    this.stmtSetLocalCursor = db.prepare(`
      INSERT INTO feed_local_cursor (office_id, feed_id, applied_seq, updated_at)
        VALUES (@office_id, @feed_id, @applied_seq, @updated_at)
      ON CONFLICT(office_id, feed_id) DO UPDATE SET
        applied_seq = excluded.applied_seq,
        updated_at = excluded.updated_at
    `)

    this.stmtPutCache = db.prepare(`
      INSERT INTO feed_cache (office_id, feed_id, seq, entry_json)
        VALUES (@office_id, @feed_id, @seq, @entry_json)
      ON CONFLICT(office_id, feed_id, seq) DO UPDATE SET entry_json = excluded.entry_json
    `)
    this.stmtListCache = db.prepare(`
      SELECT seq, entry_json FROM feed_cache
        WHERE office_id = ? AND feed_id = ? AND seq > ?
        ORDER BY seq ASC
        LIMIT ?
    `)
    this.stmtCacheMaxSeq = db.prepare(`
      SELECT COALESCE(MAX(seq), 0) AS m FROM feed_cache WHERE office_id = ? AND feed_id = ?
    `)
    this.stmtListCacheFeedIds = db.prepare(`
      SELECT DISTINCT feed_id FROM feed_cache WHERE office_id = ?
    `)

    this.stmtGetMeta = db.prepare(`SELECT * FROM feed_meta WHERE office_id = ? AND feed_id = ?`)
    this.stmtSetTruncated = db.prepare(`
      INSERT INTO feed_meta (office_id, feed_id, truncated_before_seq, hlc_high)
        VALUES (@office_id, @feed_id, @truncated_before_seq, NULL)
      ON CONFLICT(office_id, feed_id) DO UPDATE SET
        truncated_before_seq = excluded.truncated_before_seq
    `)
    this.stmtSetHlcHigh = db.prepare(`
      INSERT INTO feed_meta (office_id, feed_id, truncated_before_seq, hlc_high)
        VALUES (@office_id, @feed_id, 0, @hlc_high)
      ON CONFLICT(office_id, feed_id) DO UPDATE SET hlc_high = excluded.hlc_high
    `)
    this.stmtOfficeHlcHigh = db.prepare(`
      SELECT MAX(hlc_high) AS m FROM feed_meta WHERE office_id = ? AND hlc_high IS NOT NULL
    `)
  }

  // ── feed_log ──

  appendEntry(entry: FeedEntryRecord): void {
    this.stmtAppend.run({
      office_id: entry.officeId,
      feed_id: entry.feedId,
      seq: entry.seq,
      hlc: entry.hlc,
      fid: entry.fid,
      type: entry.type,
      payload: JSON.stringify(entry.payload ?? null),
      ts: entry.ts,
      created_at: entry.createdAt,
    })
  }

  getMaxSeq(officeId: string, feedId: string): number {
    return (this.stmtMaxSeq.get(officeId, feedId) as { m: number }).m
  }

  getMinSeq(officeId: string, feedId: string): number {
    return (this.stmtMinSeq.get(officeId, feedId) as { m: number }).m
  }

  hasFid(officeId: string, feedId: string, fid: string): boolean {
    return this.stmtHasFid.get(officeId, feedId, fid) !== undefined
  }

  listAfter(officeId: string, feedId: string, afterSeq: number, limit: number): FeedEntryRecord[] {
    return (this.stmtListAfter.all(officeId, feedId, afterSeq, limit) as FeedEntryRow[]).map(rowToEntry)
  }

  pruneBefore(officeId: string, feedId: string, beforeSeq: number): number {
    return this.stmtPruneBefore.run(officeId, feedId, beforeSeq).changes
  }

  listLogFeedIds(officeId: string): string[] {
    return (this.stmtListLogFeedIds.all(officeId) as { feed_id: string }[]).map((r) => r.feed_id)
  }

  // ── feed_peer_cursor ──

  getPeerCursor(officeId: string, feedId: string, peerNode: string): number {
    const row = this.stmtGetPeerCursor.get(officeId, feedId, peerNode) as { acked_seq: number } | undefined
    return row?.acked_seq ?? 0
  }

  setPeerCursor(officeId: string, feedId: string, peerNode: string, ackedSeq: number, at: number): void {
    this.stmtSetPeerCursor.run({
      office_id: officeId,
      feed_id: feedId,
      peer_node: peerNode,
      acked_seq: ackedSeq,
      updated_at: at,
    })
  }

  getMinPeerCursor(officeId: string, feedId: string): number | null {
    const row = this.stmtMinPeerCursor.get(officeId, feedId) as { m: number | null } | undefined
    return row?.m ?? null
  }

  // ── feed_local_cursor ──

  getLocalCursor(officeId: string, feedId: string): number {
    const row = this.stmtGetLocalCursor.get(officeId, feedId) as { applied_seq: number } | undefined
    return row?.applied_seq ?? 0
  }

  setLocalCursor(officeId: string, feedId: string, appliedSeq: number, at: number): void {
    this.stmtSetLocalCursor.run({
      office_id: officeId,
      feed_id: feedId,
      applied_seq: appliedSeq,
      updated_at: at,
    })
  }

  // ── feed_cache ──

  putCache(officeId: string, feedId: string, seq: number, entryJson: string): void {
    this.stmtPutCache.run({ office_id: officeId, feed_id: feedId, seq, entry_json: entryJson })
  }

  listCache(officeId: string, feedId: string, afterSeq: number, limit: number): { seq: number; entryJson: string }[] {
    const rows = this.stmtListCache.all(officeId, feedId, afterSeq, limit) as { seq: number; entry_json: string }[]
    return rows.map((r) => ({ seq: r.seq, entryJson: r.entry_json }))
  }

  getCacheMaxSeq(officeId: string, feedId: string): number {
    return (this.stmtCacheMaxSeq.get(officeId, feedId) as { m: number }).m
  }

  listCacheFeedIds(officeId: string): string[] {
    return (this.stmtListCacheFeedIds.all(officeId) as { feed_id: string }[]).map((r) => r.feed_id)
  }

  // ── feed_meta ──

  getMeta(officeId: string, feedId: string): FeedMeta | null {
    const row = this.stmtGetMeta.get(officeId, feedId) as FeedMetaRow | undefined
    if (!row) return null
    return {
      officeId: row.office_id,
      feedId: row.feed_id,
      truncatedBeforeSeq: row.truncated_before_seq,
      hlcHigh: row.hlc_high,
    }
  }

  setTruncatedBefore(officeId: string, feedId: string, beforeSeq: number): void {
    this.stmtSetTruncated.run({ office_id: officeId, feed_id: feedId, truncated_before_seq: beforeSeq })
  }

  setHlcHigh(officeId: string, feedId: string, hlc: string): void {
    this.stmtSetHlcHigh.run({ office_id: officeId, feed_id: feedId, hlc_high: hlc })
  }

  getOfficeHlcHigh(officeId: string): string | null {
    const row = this.stmtOfficeHlcHigh.get(officeId) as { m: string | null } | undefined
    return row?.m ?? null
  }
}
