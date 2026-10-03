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
 * A feed's kind: `ctrl:<target>` carries one author's wakes and turn completions
 * for one peer; `session:<key>` is one team session's transcript. The producer
 * treats them uniformly; only reliability policy differs (see the engine).
 */
export type FeedKind = `ctrl:${string}` | `session:${string}`

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
  // Not a key feedIdKey made: an empty kind matches no feed this node reads or writes.
  if (sep < 0) return { officeId, author: key, kind: '' as FeedKind }
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

/** Consumer → author: stop pushing this feed; the consumer keeps its cursor for a later subscribe. */
export interface FeedUnsubscribeFrame {
  kind: 'feed-unsubscribe'
  officeId: string
  feedKey: string
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
  /**
   * The author's current retention floor for this feed: entries at/below this
   * seq have been permanently pruned and will never be (re)sent. Optional so an
   * older peer's frame (no field) is read as 0 (nothing known to be pruned) —
   * never as a false "everything before this is gone" signal. A consumer whose
   * cursor sits below this floor knows the gap is not a transient loss (nack
   * would never fill it) and can jump its cursor to the floor instead of
   * nacking a range the author can never resend.
   */
  truncatedBeforeSeq?: number
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

/**
 * Serving side → peer: the feeds it can serve, in one frame instead of one
 * `feed-advertise` per feed. The peer records them and subscribes only to the
 * ones it wants.
 */
export interface FeedDigestFrame {
  kind: 'feed-digest'
  officeId: string
  feeds: Array<[feedKey: string, upToSeq: number]>
}

export type FeedSyncFrame =
  | FeedSubscribeFrame
  | FeedUnsubscribeFrame
  | FeedEntriesFrame
  | FeedAckFrame
  | FeedNackFrame
  | FeedAdvertiseFrame
  | FeedDigestFrame

/** The feed-sync frame kinds the feed transports own on the wire. */
export const FEED_SYNC_FRAME_KINDS: ReadonlySet<string> = new Set<FeedSyncFrame['kind']>([
  'feed-subscribe',
  'feed-unsubscribe',
  'feed-entries',
  'feed-ack',
  'feed-nack',
  'feed-advertise',
  'feed-digest',
])

export function isFeedSyncFrame(frame: { kind: string }): frame is FeedSyncFrame {
  return FEED_SYNC_FRAME_KINDS.has(frame.kind)
}
