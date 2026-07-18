/**
 * apps/runtime/federation/log -- Feed substrate types
 *
 * The wire/domain shapes for the unified feed log: a feed identity, a feed
 * entry, and the four sync frames (subscribe / entries / ack / nack) that carry
 * Live push and Catch-up pull over the SAME mechanism. Transport-agnostic: the
 * sync engine is handed a `send` closure and never imports a link.
 */

import type { NodeId } from '../types'

/**
 * A feed's kind. `ctrl` and `act` are one-per-author-per-office; `session:<key>`
 * is one per team session (its transcript). The producer treats them uniformly;
 * only reliability policy differs (see the engine).
 */
export type FeedKind = 'ctrl' | 'act' | `session:${string}`

/** Fully-qualified feed identity within an office. `feedId` is the string form. */
export interface FeedId {
  officeId: string
  author: NodeId
  kind: FeedKind
}

/**
 * The string used as the DB `feed_id` column and the wire feed key. Author is
 * encoded so a consumer subscribing to `<author>/<kind>` addresses exactly one
 * single-writer log. Kinds that already contain the author's session key still
 * qualify by author for symmetry and cross-office safety.
 */
export function feedIdKey(id: FeedId): string {
  return `${id.author}\u0000${id.kind}`
}

export function parseFeedIdKey(officeId: string, key: string): FeedId {
  const sep = key.indexOf('\u0000')
  if (sep < 0) return { officeId, author: key, kind: 'ctrl' }
  return { officeId, author: key.slice(0, sep), kind: key.slice(sep + 1) as FeedKind }
}

/** One feed entry as it travels and is applied (mirrors FeedEntryRecord sans store cols). */
export interface FeedEntry {
  seq: number
  hlc: string
  fid: string
  type: string
  payload: unknown
  ts: number
}

// ── Sync frames (control plane) ──

/** Consumer → author: "I hold this feed up to afterSeq; subscribe + replay the tail." */
export interface FeedSubscribeFrame {
  kind: 'feed-subscribe'
  officeId: string
  feedKey: string
  afterSeq: number
}

/** Author → consumer: a batch of entries (Live push or Catch-up replay share this). */
export interface FeedEntriesFrame {
  kind: 'feed-entries'
  officeId: string
  feedKey: string
  entries: FeedEntry[]
  /** Highest seq the author has for this feed (lets the consumer detect completeness). */
  upToSeq: number
  /** True when more entries remain beyond this batch (cursor continuation). */
  more: boolean
}

/** Consumer → author: cumulative delivery confirmation up to ackedSeq. */
export interface FeedAckFrame {
  kind: 'feed-ack'
  officeId: string
  feedKey: string
  ackedSeq: number
}

/** Consumer → author: explicit gap request (missing seq ranges, inclusive). */
export interface FeedNackFrame {
  kind: 'feed-nack'
  officeId: string
  feedKey: string
  missing: { from: number; to: number }[]
}

/**
 * Serving side → peers: this feed exists and holds entries up to `upToSeq`.
 * The discovery half of proactive replication: a consumer whose applied cursor
 * is behind answers with a `feed-subscribe` from its watermark. Idempotent and
 * safe to re-send (an up-to-date consumer ignores it), so it doubles as the
 * self-healing re-announce on reconnect / late join.
 */
export interface FeedAdvertiseFrame {
  kind: 'feed-advertise'
  officeId: string
  feedKey: string
  upToSeq: number
}

export type FeedSyncFrame =
  | FeedSubscribeFrame
  | FeedEntriesFrame
  | FeedAckFrame
  | FeedNackFrame
  | FeedAdvertiseFrame

/** The feed-sync frame kinds the feed transports own on the wire. */
export const FEED_SYNC_FRAME_KINDS: ReadonlySet<string> = new Set<FeedSyncFrame['kind']>([
  'feed-subscribe',
  'feed-entries',
  'feed-ack',
  'feed-nack',
  'feed-advertise',
])

export function isFeedSyncFrame(frame: { kind: string }): frame is FeedSyncFrame {
  return FEED_SYNC_FRAME_KINDS.has(frame.kind)
}
