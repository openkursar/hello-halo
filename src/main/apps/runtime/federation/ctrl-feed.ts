/**
 * apps/runtime/federation -- Reliable control-plane messaging over the feed log
 *
 * Turns the fire-and-forget wake / turn-complete path into an effectively-once
 * channel by routing those control messages through the unified feed substrate
 * (runtime/federation/log): a persistent per-author outbox with ack-windowed
 * delivery, nack/backstop retransmit, and fid + seq dedup. A dropped frame is
 * redelivered, never lost; a duplicate (retransmit / gateway double-path) is
 * applied at most once — so a lost turn-complete no longer strands the sender on
 * the completion backstop (MB-2) and the reliable completion closes the reassign
 * double-execution window (H9) at its source.
 *
 * Model: every node authors ONE `ctrl` feed carrying its outbound control
 * entries. The AUTHORITY appends `wake` entries; the OWNER appends
 * `turn-complete` entries. Each entry is directed (its payload names the target
 * node), so a consumer of a peer's ctrl feed applies every entry in order but
 * only ACTS on the ones addressed to it — the feed's ordered-once apply is what
 * makes the acting idempotent.
 *
 * Transport- and domain-agnostic seam: `sendToPeer` (link routing) and the two
 * domain handlers (`onWake` / `onTurnComplete`) are injected, so the manager
 * wires this to the federation link and the kernel wake/turn-complete paths
 * without this module importing either — the same additive discipline the rest of
 * runtime/federation follows. Holds no quorum / term / election state.
 */

import type { FeedStore } from '../../federation'
import type { NodeId, SerializedWakeRequest } from './types'
import type { TurnCompletion } from '../team/message-bus'
import { createFeedService, type FeedService } from './log/feed-service'
import { feedIdKey, type FeedEntry, type FeedSyncFrame } from './log/types'

const CTRL_KIND = 'ctrl' as const
const ENTRY_WAKE = 'wake'
const ENTRY_TURN_COMPLETE = 'turn-complete'

/** A directed wake carried as a ctrl-feed entry (authority → owner). */
interface CtrlWakePayload {
  target: NodeId
  from: NodeId
  correlationId: string
  request: SerializedWakeRequest
}

/** A directed turn-complete carried as a ctrl-feed entry (owner → authority). */
interface CtrlTurnCompletePayload {
  target: NodeId
  correlationId: string
  outcome: TurnCompletion
}

export interface CtrlFeedDeps {
  officeId: string
  /** This node's portable identity — the author of its own ctrl feed. */
  selfNodeId: NodeId
  /** Durable feed persistence (apps/federation FeedStore). */
  feedStore: FeedStore
  /** Deliver a feed-sync frame to one peer; the caller owns transport routing. */
  sendToPeer: (peer: NodeId, frame: FeedSyncFrame) => void
  /** A wake addressed to THIS node arrived (drive the local turn). */
  onWake: (msg: { correlationId: string; request: SerializedWakeRequest; from: NodeId }) => void
  /** A turn-complete addressed to THIS node arrived (resolve the authority waiter). */
  onTurnComplete: (msg: { correlationId: string; outcome: TurnCompletion }) => void
  /**
   * A published wake could not be delivered: the target never acked before the
   * give-up deadline. The authority resolves the sender's completion waiter as
   * `undelivered` from this, so "the message never arrived" is known in bounded
   * time instead of hanging on the long completion backstop. Only fired for
   * wakes that were NOT delivered — a delivered wake is dropped from tracking
   * silently (its completion is awaited separately). The deadline is the SOLE
   * undeliverable arbiter: a transient presence-offline (WAN tunnel flap) must
   * not fail a wake the outbox will deliver on reconnect.
   */
  onUndeliverable?: (msg: { correlationId: string; target: NodeId; reason: string }) => void
  /** Retransmit backstop interval (ms); forwarded to the feed service. */
  retransmitIntervalMs?: number
  /** Ms after publish that an un-acked wake is declared undeliverable (backstop). */
  giveUpMs?: number
  now?: () => number
  genFid?: () => string
}

/** Default give-up backstop: long enough to ride out a WAN tunnel outage (the
 *  durable outbox redelivers on reconnect, so a temporarily-unreachable target
 *  is `pending`, not failed), short enough that a truly gone target is known
 *  well before the caller's own sync-wait ceiling. */
const DEFAULT_GIVE_UP_MS = 180_000

export interface CtrlFeed {
  /** Author a wake to a target owner; returns the assigned feed seq. */
  publishWake(target: NodeId, correlationId: string, request: SerializedWakeRequest): { seq: number }
  /** Author a turn-complete back to the authority; returns the assigned feed seq. */
  publishTurnComplete(target: NodeId, correlationId: string, outcome: TurnCompletion): { seq: number }
  /** Start consuming a peer's ctrl feed (subscribe from our persisted watermark). */
  subscribePeer(author: NodeId): void
  /** Route one inbound feed-sync frame from a peer. */
  handleFrame(from: NodeId, frame: FeedSyncFrame): void
  /** Forget a disconnected peer's producer subscriptions. */
  dropPeer(peer: NodeId): void
  /**
   * Highest seq of THIS node's ctrl feed the peer has acked — i.e. the delivery
   * watermark. A publishWake/publishTurnComplete result is `delivered` once this
   * reaches its seq; below it the message is still `pending`.
   */
  deliveredUpTo(peer: NodeId): number
  /** Resend to any subscribed peer still behind (called by the timer, or manually). */
  retransmitTick(): void
  /** Begin the retransmit-backstop timer. Idempotent. */
  start(): void
  /** Stop the timer and release resources. Idempotent. */
  stop(): void
}

export function createCtrlFeed(deps: CtrlFeedDeps): CtrlFeed {
  const { officeId, selfNodeId, feedStore, onWake, onTurnComplete } = deps
  const ownFeedKey = feedIdKey({ officeId, author: selfNodeId, kind: CTRL_KIND })
  const now = deps.now ?? Date.now
  const giveUpMs = deps.giveUpMs ?? DEFAULT_GIVE_UP_MS

  // Wakes this node authored that are awaiting delivery to their target, keyed by
  // feed seq. A wake is removed once its target acks past its seq (delivered) or
  // once the give-up deadline passes (undeliverable). Turn-complete entries are
  // NOT tracked: their author does not wait on delivery — the substrate prunes
  // them once acked, and a lost one is the authority's backstop concern.
  const outstandingWakes = new Map<
    number,
    { target: NodeId; correlationId: string; deadlineAt: number }
  >()

  /** A wake at `seq` to `target` has reached the target once the target's ack
   *  cursor over our feed covers it. */
  function isDelivered(target: NodeId, seq: number): boolean {
    return feedStore.getPeerCursor(officeId, ownFeedKey, target) >= seq
  }

  function markUndeliverable(seq: number, target: NodeId, correlationId: string, reason: string): void {
    outstandingWakes.delete(seq)
    deps.onUndeliverable?.({ correlationId, target, reason })
  }

  /** Run on every feed tick: retire delivered wakes, fail ones past their deadline. */
  function sweepOutstanding(): void {
    const t = now()
    for (const [seq, o] of outstandingWakes) {
      if (isDelivered(o.target, seq)) {
        outstandingWakes.delete(seq)
        continue
      }
      if (t >= o.deadlineAt) markUndeliverable(seq, o.target, o.correlationId, 'timeout')
    }
  }

  /** Domain apply: an inbound ctrl entry from a remote author, in seq order. */
  function applyCtrl(_feedKey: string, entry: FeedEntry): void {
    if (entry.type === ENTRY_WAKE) {
      const p = entry.payload as CtrlWakePayload
      // Only the addressed owner acts; other subscribers consumed-but-ignore.
      if (p.target !== selfNodeId) return
      onWake({ correlationId: p.correlationId, request: p.request, from: p.from })
      return
    }
    if (entry.type === ENTRY_TURN_COMPLETE) {
      const p = entry.payload as CtrlTurnCompletePayload
      if (p.target !== selfNodeId) return
      onTurnComplete({ correlationId: p.correlationId, outcome: p.outcome })
      return
    }
    // Unknown ctrl entry types are consumed (cursor advances) but not acted on, so
    // a forward-compatible sender never stalls an older consumer.
  }

  const feed: FeedService = createFeedService({
    store: feedStore,
    officeId,
    selfNodeId,
    sendToPeer: deps.sendToPeer,
    apply: applyCtrl,
    onTick: sweepOutstanding,
    ...(deps.retransmitIntervalMs !== undefined ? { retransmitIntervalMs: deps.retransmitIntervalMs } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.genFid ? { genFid: deps.genFid } : {}),
  })

  function publishWake(target: NodeId, correlationId: string, request: SerializedWakeRequest): { seq: number } {
    const payload: CtrlWakePayload = { target, from: selfNodeId, correlationId, request }
    const entry = feed.appendLocal(CTRL_KIND, ENTRY_WAKE, payload)
    outstandingWakes.set(entry.seq, { target, correlationId, deadlineAt: now() + giveUpMs })
    console.log(
      `[CtrlFeed] publish wake office=${officeId} seq=${entry.seq} target=${target} corr=${correlationId} deliveredUpTo=${deliveredUpTo(target)}`
    )
    return { seq: entry.seq }
  }

  function publishTurnComplete(
    target: NodeId,
    correlationId: string,
    outcome: TurnCompletion
  ): { seq: number } {
    const payload: CtrlTurnCompletePayload = { target, correlationId, outcome }
    const entry = feed.appendLocal(CTRL_KIND, ENTRY_TURN_COMPLETE, payload)
    console.log(
      `[CtrlFeed] publish turn-complete office=${officeId} seq=${entry.seq} target=${target} corr=${correlationId} deliveredUpTo=${deliveredUpTo(target)}`
    )
    return { seq: entry.seq }
  }

  // Log a peer's subscription once per process (re-subscribes fire on every
  // heartbeat frame — logging each would flood the file at 2s cadence).
  const loggedSubscribes = new Set<NodeId>()

  function subscribePeer(author: NodeId): void {
    if (!loggedSubscribes.has(author)) {
      loggedSubscribes.add(author)
      console.log(
        `[CtrlFeed] subscribe peer office=${officeId} author=${author} fromCursor=${feedStore.getLocalCursor(officeId, feedIdKey({ officeId, author, kind: CTRL_KIND }))}`
      )
    }
    feed.subscribeRemote(author, CTRL_KIND)
  }

  function deliveredUpTo(peer: NodeId): number {
    return feedStore.getPeerCursor(officeId, ownFeedKey, peer)
  }

  return {
    publishWake,
    publishTurnComplete,
    subscribePeer,
    handleFrame: (from, frame) => feed.handleInbound(from, frame),
    dropPeer: (peer) => feed.dropPeer(peer),
    deliveredUpTo,
    retransmitTick: () => feed.retransmitTick(),
    start: () => feed.start(),
    stop: () => feed.stop(),
  }
}
