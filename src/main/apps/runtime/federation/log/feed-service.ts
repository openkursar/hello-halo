/**
 * apps/runtime/federation/log -- Per-office feed service (assembly facade)
 *
 * Composes the bare core into one cohesive per-office unit: a durable log for
 * the feeds this node authors, a producer that reliably serves them to peers, a
 * consumer that applies remote feeds in order, and the shared FeedStore cursors.
 * It owns the retransmit-backstop timer and resolves the transport routing that
 * the sync engine halves deliberately leave to their host (a consumer's control
 * frames go to the feed's AUTHOR, encoded in the feed key).
 *
 * Transport- and domain-agnostic: `sendToPeer` and `apply` are injected, so the
 * manager wires it to the federation link and the message/activity/history
 * handlers without this module importing either. Nothing here holds quorum,
 * term, or election state — those stay in authority/*.
 */

import type { FeedStore } from '../../../federation'
import type { NodeId } from '../types'
import { createDurableFeedLog, type DurableFeedLog } from './durable-log'
import { createFeedProducer, createFeedConsumer, type FeedProducer, type FeedConsumer } from './sync-engine'
import {
  feedIdKey,
  parseFeedIdKey,
  type FeedEntry,
  type FeedKind,
  type FeedSyncFrame,
} from './types'

const DEFAULT_RETRANSMIT_MS = 5000

export interface FeedServiceDeps {
  store: FeedStore
  officeId: string
  /** This node's portable identity — the author of its own feeds. */
  selfNodeId: NodeId
  /** Deliver a sync frame to one peer; the caller owns transport routing. */
  sendToPeer: (peer: NodeId, frame: FeedSyncFrame) => void
  /** Apply one in-order entry from a remote feed (domain handler; may throw to defer). */
  apply: (feedKey: string, entry: FeedEntry) => void
  /**
   * Domain hook run on every tick (after retransmit + prune). The ctrl plane uses
   * it to sweep its give-up deadlines; kept generic so the substrate owns no
   * domain state. Runs on both the timer and a manual `retransmitTick()`.
   */
  onTick?: () => void
  /** Retransmit backstop interval (ms); 0 disables the auto timer (call retransmitTick manually). */
  retransmitIntervalMs?: number
  /** Max entries per sync batch. */
  batchMax?: number
  /** Wall-clock / fid / drift injection (forwarded to the durable log). */
  now?: () => number
  genFid?: () => string
  maxDriftMs?: number
}

export interface FeedService {
  /** Append to one of THIS node's feeds and push it to subscribers. */
  appendLocal(kind: FeedKind, type: string, payload: unknown): FeedEntry
  /** Start consuming a remote author's feed (sends subscribe from our watermark). */
  subscribeRemote(author: NodeId, kind: FeedKind): void
  /**
   * Register `peer` as a subscriber of THIS node's own feed of `kind` without an
   * explicit subscribe from it — the producer-side self-heal for a lost
   * subscription (driven by any inbound frame, e.g. a heartbeat). Returns true iff
   * a new subscription was added.
   */
  ensurePeerSubscribed(kind: FeedKind, peer: NodeId): boolean
  /** Route one inbound sync frame from a peer. */
  handleInbound(fromNode: NodeId, frame: FeedSyncFrame): void
  /** Forget a disconnected peer's producer subscriptions. */
  dropPeer(peer: NodeId): void
  /** Resend to any peer still behind (called by the timer, or manually in tests). */
  retransmitTick(): void
  /** Begin the retransmit-backstop timer. Idempotent. */
  start(): void
  /** Stop the timer and release resources. Idempotent. */
  stop(): void
}

export function createFeedService(deps: FeedServiceDeps): FeedService {
  const { store, officeId, selfNodeId } = deps
  const now = deps.now ?? Date.now

  const durableLog: DurableFeedLog = createDurableFeedLog({
    store,
    officeId,
    now: deps.now,
    genFid: deps.genFid,
    maxDriftMs: deps.maxDriftMs,
  })

  const producer: FeedProducer = createFeedProducer({
    officeId,
    batchMax: deps.batchMax,
    read: (feedKey, after, limit) => durableLog.read(feedKey, after, limit),
    latestSeq: (feedKey) => durableLog.latestSeq(feedKey),
    send: (peer, frame) => deps.sendToPeer(peer, frame),
    getPeerCursor: (feedKey, peer) => store.getPeerCursor(officeId, feedKey, peer),
    setPeerCursor: (feedKey, peer, seq) => store.setPeerCursor(officeId, feedKey, peer, seq, now()),
  })

  const consumer: FeedConsumer = createFeedConsumer({
    officeId,
    // A consumer's control frames always travel to the feed's author.
    send: (frame) => deps.sendToPeer(parseFeedIdKey(officeId, frame.feedKey).author, frame),
    apply: (feedKey, entry) => deps.apply(feedKey, entry),
    getLocalCursor: (feedKey) => store.getLocalCursor(officeId, feedKey),
    setLocalCursor: (feedKey, seq) => store.setLocalCursor(officeId, feedKey, seq, now()),
    observeHlc: (hlc) => durableLog.observeHlc(hlc),
  })

  let timer: ReturnType<typeof setInterval> | null = null
  // Feeds whose lost-subscribe self-heal has already been logged (once per feed,
  // so a persistently-empty feed re-driving its budget does not flood the log).
  const loggedResubscribe = new Set<string>()

  function ownFeedKey(kind: FeedKind): string {
    return feedIdKey({ officeId, author: selfNodeId, kind })
  }

  function appendLocal(kind: FeedKind, type: string, payload: unknown): FeedEntry {
    const feedKey = ownFeedKey(kind)
    const rec = durableLog.append(feedKey, type, payload)
    producer.notifyAppended(feedKey)
    return { seq: rec.seq, hlc: rec.hlc, fid: rec.fid, type: rec.type, payload: rec.payload, ts: rec.ts }
  }

  function subscribeRemote(author: NodeId, kind: FeedKind): void {
    consumer.subscribe(feedIdKey({ officeId, author, kind }))
  }

  function ensurePeerSubscribed(kind: FeedKind, peer: NodeId): boolean {
    return producer.ensureSubscribed(peer, ownFeedKey(kind))
  }

  function handleInbound(fromNode: NodeId, frame: FeedSyncFrame): void {
    switch (frame.kind) {
      case 'feed-subscribe':
        producer.onSubscribe(fromNode, frame.feedKey, frame.afterSeq)
        break
      case 'feed-ack':
        producer.onAck(fromNode, frame.feedKey, frame.ackedSeq)
        break
      case 'feed-nack':
        producer.onNack(fromNode, frame.feedKey, frame.missing)
        break
      case 'feed-entries':
        consumer.onEntries(frame)
        break
    }
  }

  function dropPeer(peer: NodeId): void {
    producer.dropPeer(peer)
  }

  function retransmitTick(): void {
    producer.retransmitTick()
    // Consumer-side self-heal: re-drive any subscribe that has not yet yielded a
    // batch (a lost subscribe the producer never registered). Bounded per feed.
    for (const feedKey of consumer.resubscribeStale()) {
      if (loggedResubscribe.has(feedKey)) continue
      loggedResubscribe.add(feedKey)
      console.log(`[FeedService] re-driving lost subscribe office=${officeId} feed=${feedKey}`)
    }
    // Bound outbox growth: drop each feed's prefix already acked by every live
    // subscriber. Safe because prune never trims below any subscriber's cursor.
    producer.prune((feedKey, floor) => durableLog.truncate(feedKey, floor))
    deps.onTick?.()
  }

  function start(): void {
    const interval = deps.retransmitIntervalMs ?? DEFAULT_RETRANSMIT_MS
    if (timer || interval <= 0) return
    timer = setInterval(retransmitTick, interval)
    if (typeof timer.unref === 'function') timer.unref()
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  return {
    appendLocal,
    subscribeRemote,
    ensurePeerSubscribed,
    handleInbound,
    dropPeer,
    retransmitTick,
    start,
    stop,
  }
}
