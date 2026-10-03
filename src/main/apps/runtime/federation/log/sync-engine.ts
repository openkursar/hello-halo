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
  FeedUnsubscribeFrame,
} from './types'

const DEFAULT_BATCH_MAX = 64

/**
 * Default wire ceiling for one batch. Deliberately well under the relay's own
 * per-frame limit so a node talking to an older relay (a lower limit than ours)
 * still fits, and so the envelope overhead around the entries has room.
 */
const DEFAULT_MAX_BATCH_BYTES = 512 * 1024

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
  /**
   * Max serialized bytes per batch. A count-only bound says nothing about wire
   * size, and a transport that refuses an oversized frame closes the connection —
   * after which the same batch is rebuilt and re-sent on reconnect, forever.
   */
  maxBatchBytes?: number
  /**
   * Every peer entitled to eventually read this feed, independent of whether it
   * is currently connected or has ever subscribed (e.g. the office roster minus
   * self). `prune` folds these into its floor alongside the live subscriber set
   * so a member who is merely offline — or has not joined the run yet — is never
   * treated as "caught up" for retention purposes. Omitted only by callers that
   * never prune (or by tests exercising delivery in isolation).
   */
  knownPeers?: (feedKey: string) => string[]
  /**
   * Current retention floor for a feed (entries at/below it no longer exist).
   * Surfaced on every `feed-entries` frame so a consumer whose cursor is behind
   * it can tell "not yet arrived" from "gone forever" and skip the gap instead
   * of nacking a range that will never be filled. Defaults to 0 (nothing pruned).
   */
  truncatedBeforeSeq?: (feedKey: string) => number
}

export interface FeedProducer {
  /** Register live-push interest and replay the tail from the peer's declared floor. */
  onSubscribe(peer: string, feedKey: string, afterSeq: number): void
  /**
   * Register `peer` as a live subscriber of `feedKey` WITHOUT an explicit
   * feed-subscribe from it — self-heals a subscription whose subscribe frame was
   * lost while the peer stayed connected (its heartbeat, not its subscribe, is the
   * trigger). Idempotent: a peer already subscribed is left untouched (the
   * retransmit backstop owns its catch-up); a newly added peer is streamed the tail
   * from its persisted cursor, never moved backward. Returns true iff it added a
   * new subscription (so the caller can log the heal once).
   */
  ensureSubscribed(peer: string, feedKey: string): boolean
  /** Advance a peer's delivery watermark and stream the next window. */
  onAck(peer: string, feedKey: string, ackedSeq: number): void
  /** Resend explicit missing ranges. */
  onNack(peer: string, feedKey: string, ranges: { from: number; to: number }[]): void
  /** After a local append: push the new tail to every subscribed peer. */
  notifyAppended(feedKey: string): void
  /** Retransmit backstop: resend from ack for any peer still behind (call on a timer). */
  retransmitTick(): void
  /**
   * Trim each served feed below the lowest delivery watermark among BOTH its
   * live subscribers and every other known peer (`knownPeers`). `truncate(feedKey,
   * floor)` removes entries with seq <= floor. Folding in known-but-not-currently-
   * subscribed peers (not just the online set) is required, not optional: a peer
   * who is merely offline, or has not subscribed yet, has a persisted cursor of 0
   * until it does — computing the floor from only who happens to be connected
   * right now prunes data a temporarily-absent member still needs, leaving it
   * permanently unable to catch up once it (re)joins. Advances only forward
   * (per-feed high-water), so a stable fleet prunes each acked prefix once.
   * Bounds outbox growth (a fully-acked feed shrinks) without a separate
   * retention timer.
   */
  prune(truncate: (feedKey: string, floor: number) => void): void
  /** Forget a peer entirely (disconnect). */
  dropPeer(peer: string): void
  /** Forget one subscription (panel close / leave). */
  unsubscribe(peer: string, feedKey: string): void
}

export function createFeedProducer(deps: FeedProducerDeps): FeedProducer {
  const batchMax = deps.batchMax ?? DEFAULT_BATCH_MAX
  const maxBatchBytes = deps.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES
  // feedKey -> set of subscribed peers wanting live push.
  const subs = new Map<string, Set<string>>()
  // feedKey -> last floor already pruned, so prune only advances forward.
  const prunedFloor = new Map<string, number>()
  // feedKeys whose head entry is itself over the wire ceiling, so the warning is
  // written once per feed rather than on every retransmit tick.
  const loggedOversized = new Set<string>()

  function subscribed(feedKey: string, peer: string): boolean {
    return subs.get(feedKey)?.has(peer) ?? false
  }

  /**
   * Trim a read window to what fits in one frame. The first entry is always kept:
   * one that alone exceeds the ceiling still has to move or the whole feed stalls
   * behind it forever. It is reported because writing an entry that large is the
   * actual defect.
   */
  function fitBatch(feedKey: string, entries: FeedEntry[]): FeedEntry[] {
    const fitted: FeedEntry[] = []
    let bytes = 0
    for (const entry of entries) {
      const size = JSON.stringify(entry).length
      if (fitted.length > 0 && bytes + size > maxBatchBytes) break
      if (fitted.length === 0 && size > maxBatchBytes && !loggedOversized.has(feedKey)) {
        loggedOversized.add(feedKey)
        console.error(
          `[FeedProducer] office=${deps.officeId} feed=${feedKey} seq=${entry.seq} type=${entry.type} ` +
            `is ${size} bytes, over the ${maxBatchBytes}-byte frame ceiling; sending it alone — ` +
            `a transport that refuses it will keep dropping this connection`
        )
      }
      fitted.push(entry)
      bytes += size
    }
    return fitted
  }

  /** The batch above fromSeq, or null for a genuinely idle feed (nothing to send or report). */
  function buildBatch(feedKey: string, fromSeq: number): FeedEntriesFrame | null {
    const floor = deps.truncatedBeforeSeq?.(feedKey) ?? 0
    const entries = fitBatch(feedKey, deps.read(feedKey, fromSeq, batchMax))
    if (entries.length === 0 && floor <= fromSeq) return null
    const latest = deps.latestSeq(feedKey)
    const lastSeq = entries.length > 0 ? entries[entries.length - 1].seq : fromSeq
    return {
      kind: 'feed-entries',
      officeId: deps.officeId,
      feedKey,
      entries,
      upToSeq: latest,
      // A peer behind the retention floor is fully caught up once it reaches the
      // floor, even with no entries in this batch (an idle-since-pruning feed).
      more: Math.max(lastSeq, floor) < latest,
      truncatedBeforeSeq: floor,
    }
  }

  /** Send one batch starting above fromSeq. */
  function pushBatch(peer: string, feedKey: string, fromSeq: number): void {
    const frame = buildBatch(feedKey, fromSeq)
    if (frame) deps.send(peer, frame)
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
    // Always answer a subscribe, even with nothing to send: the consumer re-drives
    // a subscribe until some batch arrives, so a silent answer to an idle feed
    // was a re-subscribe every minute, forever.
    deps.send(peer, buildBatch(feedKey, afterSeq) ?? {
      kind: 'feed-entries',
      officeId: deps.officeId,
      feedKey,
      entries: [],
      upToSeq: deps.latestSeq(feedKey),
      more: false,
      truncatedBeforeSeq: deps.truncatedBeforeSeq?.(feedKey) ?? 0,
    })
  }

  function ensureSubscribed(peer: string, feedKey: string): boolean {
    let set = subs.get(feedKey)
    if (!set) {
      set = new Set()
      subs.set(feedKey, set)
    }
    if (set.has(peer)) return false
    set.add(peer)
    // Trust the persisted cursor as the floor (never rewind it) — the peer applies
    // idempotently by seq, so streaming the tail from what it last acked is safe and
    // avoids resending an already-applied prefix. A peer with no cursor gets the
    // full feed from 0.
    pushBatch(peer, feedKey, deps.getPeerCursor(feedKey, peer))
    return true
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
    const floor = deps.truncatedBeforeSeq?.(feedKey) ?? 0
    for (const range of ranges) {
      if (range.to < range.from) continue
      const want = range.to - range.from + 1
      const entries = fitBatch(
        feedKey,
        deps.read(feedKey, range.from - 1, want).filter((e) => e.seq >= range.from && e.seq <= range.to)
      )
      const latest = deps.latestSeq(feedKey)
      if (entries.length === 0) {
        // The requested range was already pruned: nothing will EVER fill it by
        // resend. Say so explicitly instead of staying silent, so the peer can
        // jump its cursor to the floor instead of re-nacking the same dead range
        // on every retransmit tick forever (the permanent nack/resend deadlock a
        // late-joining or long-disconnected peer would otherwise hit).
        if (floor >= range.from) {
          deps.send(peer, {
            kind: 'feed-entries',
            officeId: deps.officeId,
            feedKey,
            entries: [],
            upToSeq: latest,
            more: floor < latest,
            truncatedBeforeSeq: floor,
          })
        }
        continue
      }
      deps.send(peer, {
        kind: 'feed-entries',
        officeId: deps.officeId,
        feedKey,
        entries,
        upToSeq: latest,
        more: Math.max(entries[entries.length - 1].seq, floor) < latest,
        truncatedBeforeSeq: floor,
      })
    }
  }

  function notifyAppended(feedKey: string): void {
    const set = subs.get(feedKey)
    if (!set) return
    // Caught-up subscribers share a cursor, so the window is read and sized once
    // per distinct cursor rather than once per peer.
    const byCursor = new Map<number, string[]>()
    set.forEach((peer) => {
      const cursor = deps.getPeerCursor(feedKey, peer)
      const peers = byCursor.get(cursor)
      if (peers) peers.push(peer)
      else byCursor.set(cursor, [peer])
    })
    byCursor.forEach((peers, cursor) => {
      const frame = buildBatch(feedKey, cursor)
      if (!frame) return
      for (const peer of peers) deps.send(peer, frame)
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
      const known = deps.knownPeers?.(feedKey) ?? []
      // Union of who is currently subscribed with every peer that is entitled to
      // read this feed at all — a peer that is merely offline, or has not joined
      // yet, still counts (its unset cursor defaults to 0 via getPeerCursor), so
      // it is never treated as caught up just because it is not connected right
      // now. Only truly no-one-to-serve (no live subscriber, no known peer) skips.
      const peers = new Set<string>(known)
      set.forEach((peer) => peers.add(peer))
      if (peers.size === 0) return
      let floor = Infinity
      peers.forEach((peer) => {
        const cur = deps.getPeerCursor(feedKey, peer)
        if (cur < floor) floor = cur
      })
      // No peer has acked anything yet, or we already pruned to here.
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
    ensureSubscribed,
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
  send: (frame: FeedSubscribeFrame | FeedUnsubscribeFrame | FeedAckFrame | FeedNackFrame) => void
  /** Apply one in-order entry (domain handler). May throw to defer (will retry). */
  apply: (feedKey: string, entry: FeedEntry) => void
  /** Persisted applied watermark for this remote feed. */
  getLocalCursor: (feedKey: string) => number
  setLocalCursor: (feedKey: string, appliedSeq: number) => void
  /** Merge a received HLC into the local office clock (called before apply). */
  observeHlc?: (hlc: string) => void
  /** Max out-of-order entries buffered above the gap per feed (default 8192). */
  pendingMax?: number
  /**
   * Runs one received batch's store writes (hlc, applies, cursor) as a unit, so a
   * batch costs one commit instead of several per entry. The ack is sent after it
   * returns, so nothing is acknowledged before it is durable.
   */
  transaction?: <T>(fn: () => T) => T
}

export interface FeedConsumer {
  /** Ask the author to (re)start the stream from our applied watermark. */
  subscribe(feedKey: string): void
  /**
   * Subscribe once: a no-op when this consumer already subscribed to the feed
   * (the re-drive and the producer's own heal cover a lost subscribe). Returns
   * true iff it sent a subscribe. Use `subscribe` for an explicit restart after
   * a reconnect.
   */
  ensureSubscribed(feedKey: string): boolean
  /**
   * Stop receiving a feed: the author is told to stop pushing, and the applied
   * cursor stays so a later subscribe resumes from it. Returns false when this
   * consumer was not subscribed.
   */
  unsubscribe(feedKey: string): boolean
  /** Handle a received batch: order, dedup, apply, ack, and nack any gap. */
  onEntries(frame: FeedEntriesFrame): void
  /**
   * Re-send feed-subscribe frames for feeds subscribed but from which no batch
   * has yet arrived — self-heals a lost subscribe (the producer never registered
   * us, so it will never push nor retransmit). Called off the retransmit tick.
   * Returns what was re-driven this pass, with how many attempts have now gone
   * unanswered, so the caller can log the first heal and escalate a stuck one.
   */
  resubscribeStale(): { feedKey: string; attempts: number }[]
}

/**
 * Ticks between re-drives of an unanswered subscribe. Fast at first — a subscribe
 * lost in transit should heal in seconds — then a slow heartbeat, so a
 * legitimately silent feed is not polled.
 *
 * It never stops. A bounded budget makes a lost subscribe permanent: once spent,
 * this side waits forever for a stream that was never registered, and the author
 * has no way to learn it should push.
 */
function redriveIntervalTicks(attempts: number): number {
  if (attempts < 6) return 1
  if (attempts < 12) return 6
  return 12
}

/** Attempts after which an unanswered subscribe is reported as stuck, and the period of repeats. */
export const RESUBSCRIBE_ALERT_AFTER = 12

export function createFeedConsumer(deps: FeedConsumerDeps): FeedConsumer {
  const pendingMax = deps.pendingMax ?? 8192
  // feedKey -> out-of-order buffer (seq -> entry) awaiting a contiguous run.
  const pending = new Map<string, Map<number, FeedEntry>>()
  // feedKey -> how many re-drives have gone unanswered, and how many ticks since
  // the last one. Present only while a subscribed feed has yet to yield its first
  // batch; cleared on the first onEntries.
  const awaitingFirstBatch = new Map<string, { attempts: number; ticksWaited: number }>()
  // Feeds this consumer has subscribed to in this process.
  const subscribed = new Set<string>()

  function bufferFor(feedKey: string): Map<number, FeedEntry> {
    let m = pending.get(feedKey)
    if (!m) {
      m = new Map()
      pending.set(feedKey, m)
    }
    return m
  }

  function sendSubscribe(feedKey: string): void {
    deps.send({
      kind: 'feed-subscribe',
      officeId: deps.officeId,
      feedKey,
      afterSeq: deps.getLocalCursor(feedKey),
    })
  }

  function subscribe(feedKey: string): void {
    // Arm the re-drive: if this subscribe (or the producer's registration) is
    // lost, the retransmit tick re-asks until a batch arrives. Re-arming on every
    // subscribe() means a reconnect restarts the fast window.
    awaitingFirstBatch.set(feedKey, { attempts: 0, ticksWaited: 0 })
    subscribed.add(feedKey)
    sendSubscribe(feedKey)
  }

  function ensureSubscribed(feedKey: string): boolean {
    if (subscribed.has(feedKey)) return false
    subscribe(feedKey)
    return true
  }

  function unsubscribe(feedKey: string): boolean {
    if (!subscribed.delete(feedKey)) return false
    awaitingFirstBatch.delete(feedKey)
    pending.delete(feedKey)
    deps.send({ kind: 'feed-unsubscribe', officeId: deps.officeId, feedKey })
    return true
  }

  function resubscribeStale(): { feedKey: string; attempts: number }[] {
    const redriven: { feedKey: string; attempts: number }[] = []
    for (const [feedKey, state] of awaitingFirstBatch) {
      state.ticksWaited += 1
      if (state.ticksWaited < redriveIntervalTicks(state.attempts)) continue
      state.ticksWaited = 0
      state.attempts += 1
      sendSubscribe(feedKey)
      redriven.push({ feedKey, attempts: state.attempts })
    }
    return redriven
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
    // A batch arrived ⇒ the producer has us registered; stop the re-drive burst.
    awaitingFirstBatch.delete(feedKey)
    const buf = bufferFor(feedKey)
    const cursor = deps.transaction
      ? deps.transaction(() => admitAndApply(frame, buf))
      : admitAndApply(frame, buf)

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

  /** Buffer the batch and apply the contiguous run; returns the new applied cursor. */
  function admitAndApply(frame: FeedEntriesFrame, buf: Map<number, FeedEntry>): number {
    const { feedKey } = frame
    let cursor = deps.getLocalCursor(feedKey)

    // The author has permanently discarded everything at/below truncatedBeforeSeq
    // (bounded retention — see FeedProducer.prune). If our cursor is still behind
    // that floor, the missing prefix is not a transient loss: no nack or backstop
    // retransmit will ever produce it, because it no longer exists anywhere. Jump
    // the cursor to the floor so ordered apply and gap detection both resume from
    // data that still exists — the fix for the permanent nack/resend deadlock a
    // late-joining or long-disconnected peer would otherwise hit forever (the
    // author kept resending its live tail; the peer kept nacking a dead range).
    const truncatedBeforeSeq = frame.truncatedBeforeSeq ?? 0
    if (truncatedBeforeSeq > cursor) {
      for (const seq of buf.keys()) {
        if (seq <= truncatedBeforeSeq) buf.delete(seq)
      }
      cursor = truncatedBeforeSeq
      deps.setLocalCursor(feedKey, cursor)
      console.warn(
        `[FeedConsumer] office=${deps.officeId} feed=${feedKey} skipped a discarded prefix, cursor -> ${cursor}`
      )
    }

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
    const startCursor = cursor
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
      // Without a transaction every applied entry persists its cursor at once, so
      // a crash mid-batch never re-applies what already took effect. Inside one,
      // the cursor commits together with the rows, so a single write suffices.
      if (!deps.transaction) deps.setLocalCursor(feedKey, cursor)
    }
    if (deps.transaction && cursor !== startCursor) deps.setLocalCursor(feedKey, cursor)
    return cursor
  }

  return { subscribe, ensureSubscribed, unsubscribe, onEntries, resubscribeStale }
}
