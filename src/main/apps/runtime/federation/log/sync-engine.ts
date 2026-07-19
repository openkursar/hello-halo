/**
 * apps/runtime/federation/log -- Feed sync engine (reliable delivery)
 *
 * Two transport-agnostic halves that turn the append-only feed log into an
 * effectively-once channel — the single mechanism behind Live push, reconnect
 * gap-fill, history load, and late-join backfill:
 *
 *   Producer (author side): streams a feed's tail to subscribed peers, windowed
 *     by their ack, and resends everything above a peer's ack on nack or on the
 *     retransmit backstop. A dropped frame is redelivered, never lost.
 *   Consumer (reader side): applies a remote feed strictly in seq order (the
 *     monotonic cursor is the dedup), buffers gaps, nacks holes, and
 *     cumulatively acks its watermark.
 *
 * Both receive a `send` closure (the caller routes by feed author) and persist
 * their cursor through injected getters/setters — no link, store, or timer is
 * imported here, so each half is unit-testable in isolation.
 */

import type {
  FeedAckFrame,
  FeedEntriesFrame,
  FeedEntry,
  FeedNackFrame,
  FeedSubscribeFrame,
} from './types'

const DEFAULT_BATCH_MAX = 64

// ── Producer (author side) ──

export interface FeedProducerDeps {
  officeId: string
  /** Entries with seq in (afterSeq, +∞) ascending, capped at limit. */
  read: (feedKey: string, afterSeq: number, limit: number) => FeedEntry[]
  /** Highest persisted seq for a feed (0 if none). */
  latestSeq: (feedKey: string) => number
  /** Emit a batch to one peer; the caller owns transport routing. */
  send: (peer: string, frame: FeedEntriesFrame) => void
  /** Persisted per-peer delivery watermark. */
  getPeerCursor: (feedKey: string, peer: string) => number
  setPeerCursor: (feedKey: string, peer: string, ackedSeq: number) => void
  /** Max entries per batch (default 64). */
  batchMax?: number
}

export interface FeedProducer {
  /** Register live-push interest and replay the tail from the peer's declared floor. */
  onSubscribe(peer: string, feedKey: string, afterSeq: number): void
  /** Advance a peer's delivery watermark and stream the next window. */
  onAck(peer: string, feedKey: string, ackedSeq: number): void
  /** Resend explicit missing ranges. */
  onNack(peer: string, feedKey: string, ranges: { from: number; to: number }[]): void
  /** After a local append: push the new tail to every subscribed peer. */
  notifyAppended(feedKey: string): void
  /** Retransmit backstop: resend from ack for any peer still behind (call on a timer). */
  retransmitTick(): void
  /**
   * Trim each served feed below the lowest delivery watermark among its live
   * subscribers. `truncate(feedKey, floor)` removes entries with seq <= floor.
   * The floor is the min per-peer cursor across current subscribers, so it never
   * drops below what any live peer has acked — a lagging peer is never left with
   * an unfillable gap. Advances only forward (per-feed high-water), so a stable
   * fleet prunes each acked prefix once. Bounds outbox growth (a fully-acked feed
   * shrinks) without a separate retention timer.
   */
  prune(truncate: (feedKey: string, floor: number) => void): void
  /** Forget a peer entirely (disconnect). */
  dropPeer(peer: string): void
  /** Forget one subscription (panel close / leave). */
  unsubscribe(peer: string, feedKey: string): void
}

export function createFeedProducer(deps: FeedProducerDeps): FeedProducer {
  const batchMax = deps.batchMax ?? DEFAULT_BATCH_MAX
  // feedKey -> set of subscribed peers wanting live push.
  const subs = new Map<string, Set<string>>()
  // feedKey -> last floor already pruned, so prune only advances forward.
  const prunedFloor = new Map<string, number>()

  function subscribed(feedKey: string, peer: string): boolean {
    return subs.get(feedKey)?.has(peer) ?? false
  }

  /** Send one batch starting above fromSeq; returns the last seq sent (0 if none). */
  function pushBatch(peer: string, feedKey: string, fromSeq: number): number {
    const entries = deps.read(feedKey, fromSeq, batchMax)
    if (entries.length === 0) return 0
    const latest = deps.latestSeq(feedKey)
    const lastSeq = entries[entries.length - 1].seq
    deps.send(peer, {
      kind: 'feed-entries',
      officeId: deps.officeId,
      feedKey,
      entries,
      upToSeq: latest,
      more: lastSeq < latest,
    })
    return lastSeq
  }

  function onSubscribe(peer: string, feedKey: string, afterSeq: number): void {
    let set = subs.get(feedKey)
    if (!set) {
      set = new Set()
      subs.set(feedKey, set)
    }
    set.add(peer)
    // Trust the consumer's declared floor: a single-writer log is replayable and
    // the consumer applies idempotently, so replaying from afterSeq (even if it
    // is below what we previously acked) is safe and is how a consumer that lost
    // its cursor recovers.
    deps.setPeerCursor(feedKey, peer, afterSeq)
    pushBatch(peer, feedKey, afterSeq)
  }

  function onAck(peer: string, feedKey: string, ackedSeq: number): void {
    const cur = deps.getPeerCursor(feedKey, peer)
    // Only a FORWARD ack releases the next window. A non-advancing ack (the peer
    // is stalled, e.g. an apply keeps deferring) must NOT immediately re-push, or
    // producer and consumer live-lock; the rate-limited retransmit backstop owns
    // resends for a genuinely stuck-but-behind peer.
    if (ackedSeq <= cur) return
    deps.setPeerCursor(feedKey, peer, ackedSeq)
    if (subscribed(feedKey, peer) && ackedSeq < deps.latestSeq(feedKey)) {
      pushBatch(peer, feedKey, ackedSeq)
    }
  }

  function onNack(peer: string, feedKey: string, ranges: { from: number; to: number }[]): void {
    for (const range of ranges) {
      if (range.to < range.from) continue
      const want = range.to - range.from + 1
      const entries = deps
        .read(feedKey, range.from - 1, want)
        .filter((e) => e.seq >= range.from && e.seq <= range.to)
      if (entries.length === 0) continue
      const latest = deps.latestSeq(feedKey)
      deps.send(peer, {
        kind: 'feed-entries',
        officeId: deps.officeId,
        feedKey,
        entries,
        upToSeq: latest,
        more: entries[entries.length - 1].seq < latest,
      })
    }
  }

  function notifyAppended(feedKey: string): void {
    const set = subs.get(feedKey)
    if (!set) return
    set.forEach((peer) => {
      pushBatch(peer, feedKey, deps.getPeerCursor(feedKey, peer))
    })
  }

  function retransmitTick(): void {
    subs.forEach((set, feedKey) => {
      const latest = deps.latestSeq(feedKey)
      set.forEach((peer) => {
        const cur = deps.getPeerCursor(feedKey, peer)
        if (cur < latest) pushBatch(peer, feedKey, cur)
      })
    })
  }

  function prune(truncate: (feedKey: string, floor: number) => void): void {
    subs.forEach((set, feedKey) => {
      if (set.size === 0) return
      let floor = Infinity
      set.forEach((peer) => {
        const cur = deps.getPeerCursor(feedKey, peer)
        if (cur < floor) floor = cur
      })
      // No subscriber has acked anything yet, or we already pruned to here.
      if (floor === Infinity || floor <= (prunedFloor.get(feedKey) ?? 0)) return
      prunedFloor.set(feedKey, floor)
      truncate(feedKey, floor)
    })
  }

  function dropPeer(peer: string): void {
    subs.forEach((set) => set.delete(peer))
  }

  function unsubscribe(peer: string, feedKey: string): void {
    subs.get(feedKey)?.delete(peer)
  }

  return {
    onSubscribe,
    onAck,
    onNack,
    notifyAppended,
    retransmitTick,
    prune,
    dropPeer,
    unsubscribe,
  }
}

// ── Consumer (reader side) ──

export interface FeedConsumerDeps {
  officeId: string
  /** Emit a control frame toward the feed's author; the caller owns routing. */
  send: (frame: FeedSubscribeFrame | FeedAckFrame | FeedNackFrame) => void
  /** Apply one in-order entry (domain handler). May throw to defer (will retry). */
  apply: (feedKey: string, entry: FeedEntry) => void
  /** Persisted applied watermark for this remote feed. */
  getLocalCursor: (feedKey: string) => number
  setLocalCursor: (feedKey: string, appliedSeq: number) => void
  /** Merge a received HLC into the local office clock (called before apply). */
  observeHlc?: (hlc: string) => void
  /** Max out-of-order entries buffered above the gap per feed (default 8192). */
  pendingMax?: number
}

export interface FeedConsumer {
  /** Ask the author to (re)start the stream from our applied watermark. */
  subscribe(feedKey: string): void
  /** Handle a received batch: order, dedup, apply, ack, and nack any gap. */
  onEntries(frame: FeedEntriesFrame): void
}

export function createFeedConsumer(deps: FeedConsumerDeps): FeedConsumer {
  const pendingMax = deps.pendingMax ?? 8192
  // feedKey -> out-of-order buffer (seq -> entry) awaiting a contiguous run.
  const pending = new Map<string, Map<number, FeedEntry>>()

  function bufferFor(feedKey: string): Map<number, FeedEntry> {
    let m = pending.get(feedKey)
    if (!m) {
      m = new Map()
      pending.set(feedKey, m)
    }
    return m
  }

  function subscribe(feedKey: string): void {
    deps.send({
      kind: 'feed-subscribe',
      officeId: deps.officeId,
      feedKey,
      afterSeq: deps.getLocalCursor(feedKey),
    })
  }

  /** Missing seq ranges below upToSeq, given the current cursor + buffered seqs. */
  function computeGaps(cursor: number, buffered: number[], upToSeq: number): { from: number; to: number }[] {
    const ranges: { from: number; to: number }[] = []
    let expect = cursor + 1
    for (const k of buffered) {
      if (k <= cursor) continue
      if (k > expect) ranges.push({ from: expect, to: k - 1 })
      expect = k + 1
    }
    if (expect <= upToSeq) ranges.push({ from: expect, to: upToSeq })
    return ranges
  }

  function onEntries(frame: FeedEntriesFrame): void {
    const { feedKey, upToSeq, more } = frame
    const buf = bufferFor(feedKey)
    let cursor = deps.getLocalCursor(feedKey)

    // Admission is seq-guarded ONLY. The monotonic cursor already makes apply
    // effectively-once (an entry at or below it never re-applies; a single-writer
    // feed never issues one fid at two seqs), so an entry above the cursor must
    // ALWAYS be (re-)admitted — the producer's resend is the only way a gap ever
    // fills. A fid table recorded at admission would poison exactly that path:
    // an entry evicted by the overflow bound below came back "already seen" and
    // was dropped forever, stalling the feed at the hole (same invariant as the
    // replication layer's apply-path-only dedup rule).
    for (const entry of frame.entries) {
      if (entry.seq <= cursor) continue // already applied (retransmit)
      deps.observeHlc?.(entry.hlc)
      buf.set(entry.seq, entry)
    }

    // Bound the gap buffer: a producer that keeps sending far-ahead seqs while a
    // low gap never fills must not grow memory without limit. Evict the
    // furthest-ahead entries (least likely to apply next); the nack below re-asks
    // for whatever is missing, so a dropped far entry is re-sent, never lost.
    if (buf.size > pendingMax) {
      const ordered = Array.from(buf.keys()).sort((a, b) => a - b)
      for (let i = pendingMax; i < ordered.length; i++) buf.delete(ordered[i])
    }

    // Apply the contiguous run from cursor+1. A throwing apply defers the rest:
    // the entry stays buffered and is retried on the next batch/retransmit.
    while (buf.has(cursor + 1)) {
      const next = buf.get(cursor + 1)!
      try {
        deps.apply(feedKey, next)
      } catch (err) {
        console.warn(
          `[FeedConsumer] office=${deps.officeId} feed=${feedKey} apply deferred at seq=${cursor + 1}: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
        break
      }
      buf.delete(cursor + 1)
      cursor += 1
      deps.setLocalCursor(feedKey, cursor)
    }

    deps.send({ kind: 'feed-ack', officeId: deps.officeId, feedKey, ackedSeq: cursor })

    // A complete batch (no more coming) that still leaves a gap below upToSeq
    // means a frame was lost — request it explicitly instead of waiting.
    if (!more && cursor < upToSeq) {
      const gaps = computeGaps(cursor, Array.from(buf.keys()).sort((a, b) => a - b), upToSeq)
      if (gaps.length > 0) {
        deps.send({ kind: 'feed-nack', officeId: deps.officeId, feedKey, missing: gaps })
      }
    }
  }

  return { subscribe, onEntries }
}
