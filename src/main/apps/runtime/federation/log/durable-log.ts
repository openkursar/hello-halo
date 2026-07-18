/**
 * apps/runtime/federation/log -- Durable feed log (author side)
 *
 * The write end of a node's own feeds: allocate the next per-feed seq, stamp a
 * hybrid logical clock and a cross-restart-unique fid, and persist — so a
 * dropped-then-resent frame is idempotent and a restart never restarts seq at 1.
 * Single-writer per feed (only the author appends its own feed) + a
 * single-threaded event loop mean the read-max/insert pair needs no lock, the
 * same discipline the blackboard replication log relies on.
 */

import { randomUUID } from 'crypto'

import type { FeedStore, FeedEntryRecord } from '../../../federation'
import { createHybridClock, type HybridClock } from './hlc'
import type { FeedEntry } from './types'

export interface DurableFeedLogDeps {
  store: FeedStore
  officeId: string
  /** Wall-clock source (injectable for tests). */
  now?: () => number
  /** fid generator (injectable for tests); defaults to UUIDv4. */
  genFid?: () => string
  /** Max ms a remote HLC may exceed local wall before clamping (see hlc). */
  maxDriftMs?: number
}

export interface DurableFeedLog {
  /** Append one authored entry to a feed; returns the persisted record. */
  append(feedKey: string, type: string, payload: unknown): FeedEntryRecord
  /** Entries with seq in (afterSeq, +∞) ascending, capped at limit. */
  read(feedKey: string, afterSeq: number, limit: number): FeedEntry[]
  /** Highest persisted seq for a feed (0 if none). */
  latestSeq(feedKey: string): number
  /** Merge a received HLC into the office clock (call before applying remote entries). */
  observeHlc(remoteHlc: string): void
  /** Current office HLC without advancing (diagnostics/tests). */
  peekHlc(): string
  /** Trim entries at/below beforeSeq and record the retention floor. */
  truncate(feedKey: string, beforeSeq: number): number
}

/** Map a stored record to the lighter wire/apply shape. */
function toEntry(rec: FeedEntryRecord): FeedEntry {
  return { seq: rec.seq, hlc: rec.hlc, fid: rec.fid, type: rec.type, payload: rec.payload, ts: rec.ts }
}

export function createDurableFeedLog(deps: DurableFeedLogDeps): DurableFeedLog {
  const { store, officeId } = deps
  const now = deps.now ?? Date.now
  const genFid = deps.genFid ?? randomUUID

  // One HLC per office, seeded from the persisted high-water so a restart never
  // moves it backwards even if the log tail was later truncated.
  const clock: HybridClock = createHybridClock({
    now,
    seed: store.getOfficeHlcHigh(officeId),
    maxDriftMs: deps.maxDriftMs,
    onDriftClamp: (remotePt, wall) =>
      console.warn(`[FeedLog] office=${officeId} clamped remote HLC pt=${remotePt} ahead of wall=${wall}`),
    onCounterOverflow: (pt) =>
      console.warn(`[FeedLog] office=${officeId} HLC counter overflow at pt=${pt}; stepped physical time`),
  })

  function append(feedKey: string, type: string, payload: unknown): FeedEntryRecord {
    // Anchor seq to the retention floor, not just the live max: once a fully
    // acked feed is pruned to empty, getMaxSeq is 0, and reusing seq 1 would be
    // silently dropped by a consumer whose applied cursor is already higher.
    const floor = store.getMeta(officeId, feedKey)?.truncatedBeforeSeq ?? 0
    const seq = Math.max(store.getMaxSeq(officeId, feedKey), floor) + 1
    const hlc = clock.tick()
    // Persist the clock high-water BEFORE the entry: hlc_high is a monotonic
    // max, so advancing it first is always safe — if the insert then throws,
    // the clock stays ahead (harmless) rather than regressing on restart.
    store.setHlcHigh(officeId, feedKey, hlc)
    const rec: FeedEntryRecord = {
      officeId,
      feedId: feedKey,
      seq,
      hlc,
      fid: genFid(),
      type,
      payload,
      ts: now(),
      createdAt: now(),
    }
    store.appendEntry(rec)
    return rec
  }

  function read(feedKey: string, afterSeq: number, limit: number): FeedEntry[] {
    return store.listAfter(officeId, feedKey, afterSeq, limit).map(toEntry)
  }

  function latestSeq(feedKey: string): number {
    return store.getMaxSeq(officeId, feedKey)
  }

  function observeHlc(remoteHlc: string): void {
    const merged = clock.update(remoteHlc)
    // Persist under a reserved feed so the merged high-water survives restart
    // even for a node that only consumes (never authors) in this office.
    store.setHlcHigh(officeId, '\u0000clock', merged)
  }

  function peekHlc(): string {
    return clock.peek()
  }

  function truncate(feedKey: string, beforeSeq: number): number {
    const removed = store.pruneBefore(officeId, feedKey, beforeSeq)
    // Keep the retention floor monotonic so it can safely anchor seq allocation.
    const floor = store.getMeta(officeId, feedKey)?.truncatedBeforeSeq ?? 0
    if (beforeSeq > floor) store.setTruncatedBefore(officeId, feedKey, beforeSeq)
    return removed
  }

  return { append, read, latestSeq, observeHlc, peekHlc, truncate }
}
