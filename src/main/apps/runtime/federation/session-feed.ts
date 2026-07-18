/**
 * apps/runtime/federation -- Multi-replica session-transcript feeds
 *
 * Proactively replicates every member's run transcript to every office node,
 * IM-style, over the unified feed substrate (runtime/federation/log): the OWNER
 * appends each transcript message to its own `session:<sessionKey>` feed (single
 * writer, append-only, never pruned); every peer consumes the feed and persists
 * two things per entry — a verbatim MIRROR row (so this node can in turn serve
 * the feed to peers that cannot reach the author) and a HISTORY-CACHE row (the
 * exact rows the manager's cache-first fetchMemberHistory already reads). The
 * result: history opens from the local copy, only the un-replicated tail ever
 * crosses the wire, and a transcript survives its owner going permanently
 * offline on every node that replicated it.
 *
 * Mutable-tail contract: the transcript reader merges an in-flight turn's events
 * into a provisional trailing assistant message that keeps changing until the
 * turn ends. The publisher therefore (a) withholds that trailing message while
 * the session is active, and (b) appends a same-seq REVISION entry whenever the
 * last published message changed on disk — consumers upsert by message seq, so
 * every replica converges on the finished form even across races.
 *
 * Topology: joiners exchange frames only with the office authority (star), so
 * the authority doubles as the serving replica for joiner↔joiner replication —
 * a subscribe for a feed authored elsewhere is served from the mirror. Discovery
 * is the `feed-advertise` frame: the serving side announces `(feedKey, upToSeq)`
 * on append / peer-online / a slow re-announce tick, and a consumer whose
 * applied cursor is behind answers with a subscribe from its watermark. Both
 * halves are idempotent, so advertise doubles as the self-healing re-announce.
 *
 * Transport- and domain-agnostic seam like ctrl-feed: `sendToPeer`/`broadcast`
 * (link routing) and `readOwnedTranscript` (chat storage) are injected; nothing
 * here holds quorum, term, or election state.
 */

import type { FeedStore } from '../../federation'
import { parseTeamSessionKey } from '../../../../shared/apps/im-keys'
import type { SerializedHistoryMessage } from './protocol-m2'
import type { NodeId } from './types'
import { createDurableFeedLog, type DurableFeedLog } from './log/durable-log'
import { createFeedProducer, createFeedConsumer, type FeedProducer, type FeedConsumer } from './log/sync-engine'
import {
  feedIdKey,
  parseFeedIdKey,
  type FeedEntry,
  type FeedKind,
  type FeedSyncFrame,
} from './log/types'

const LOG_TAG = '[SessionFeed]'

const SESSION_KIND_PREFIX = 'session:'
const ENTRY_MSG = 'msg'

const DEFAULT_RETRANSMIT_MS = 5000
/** Trailing window that coalesces a burst of activity into one transcript read. */
const DEFAULT_PUBLISH_DEBOUNCE_MS = 400
/**
 * A second publish this long after the debounced one, catching transcript rows
 * persisted after the last activity flush (the final assistant message lands at
 * turn end, often after the relay's last batch).
 */
const FINALIZE_PUBLISH_MS = 3000
/** Re-announce every known feed every N retransmit ticks (self-healing discovery). */
const REANNOUNCE_EVERY_TICKS = 6
/** Transcript messages carried per feed entry batch (entries can be large: thoughts). */
const SESSION_BATCH_MAX = 16
/** Mirror rows read per serve batch. */
const MIRROR_READ_LIMIT = 10_000

/**
 * Stable feed_cache key for one member's transcript in one epoch — the rows the
 * manager's cache-first fetchMemberHistory reads. Both the on-demand pull path
 * (manager) and the proactive replication path (this module) write it, so they
 * MUST share this single definition.
 */
export function historyCacheKey(ownerNodeId: NodeId, appId: string, epochId: string): string {
  return `history\u0000${ownerNodeId}\u0000${appId}\u0000${epochId}`
}

/** Whether a feed-sync frame belongs to the session plane (vs the ctrl plane). */
export function isSessionFeedFrame(officeId: string, frame: FeedSyncFrame): boolean {
  return parseFeedIdKey(officeId, frame.feedKey).kind.startsWith(SESSION_KIND_PREFIX)
}

export interface SessionFeedDeps {
  officeId: string
  /** This node's portable identity — the author of its own session feeds. */
  selfNodeId: NodeId
  /** Durable feed persistence (apps/federation FeedStore). */
  feedStore: FeedStore
  /** Deliver a sync frame to one peer; the caller owns transport routing. */
  sendToPeer: (peer: NodeId, frame: FeedSyncFrame) => void
  /** Fan a sync frame to every connected peer (host: all clients; joiner: upstream). */
  broadcast: (frame: FeedSyncFrame) => void
  /** Owner-side: serialized transcript of a member THIS node owns (sync read). */
  readOwnedTranscript: (teamId: string, appId: string, epochId: string) => SerializedHistoryMessage[] | null
  /**
   * Whether a turn is currently running for this session on THIS node. The
   * transcript reader merges an in-flight turn's events into a PROVISIONAL last
   * assistant message (flushed at end-of-file) whose content keeps changing until
   * the turn ends — publishing that snapshot would freeze a half-written message
   * into every replica. While active, the trailing assistant message is withheld
   * and the session stays dirty until an idle publish completes it.
   */
  isSessionActive: (sessionKey: string) => boolean
  /**
   * Whether this node currently serves mirrored feeds to peers. True on the
   * office authority (the star's hub); a plain joiner replicates for itself but
   * does not re-announce. Read live so an elected survivor starts serving.
   */
  servesMirror: () => boolean
  /**
   * A replicated transcript row was persisted into the local history cache.
   * The manager coalesces this into a renderer refresh signal so an open member
   * panel picks up rows that arrived while it was not live-streaming (late
   * replication after an outage, another node's turn, a revision).
   */
  onApplied?: (info: { ownerNodeId: NodeId; appId: string; epochId: string }) => void
  /**
   * Origin gate for inbound feed-entries: whether `from` may carry entries of a
   * feed authored by `author`. The manager encodes the topology trust (author
   * itself, the office authority as serving replica, or the transport's
   * self-label on a joined office's single upstream leg).
   */
  acceptEntriesFrom: (from: NodeId, author: NodeId) => boolean
  /** Retransmit backstop interval (ms); 0 disables the timer (tests tick manually). */
  retransmitIntervalMs?: number
  publishDebounceMs?: number
  now?: () => number
  genFid?: () => string
}

export interface SessionFeed {
  /** Coalesce a publish of an owned session's un-replicated transcript tail. */
  schedulePublish(sessionKey: string): void
  /** Publish an owned session's tail now; returns how many messages were appended. */
  publishOwnedTail(sessionKey: string): number
  /** Advertise every feed this node can serve (own + mirrored) to one peer. */
  advertiseAllTo(peer: NodeId): void
  /** Route one inbound feed-sync frame from a peer. */
  handleFrame(from: NodeId, frame: FeedSyncFrame): void
  /** Forget a disconnected peer's producer subscriptions. */
  dropPeer(peer: NodeId): void
  /** Resend/re-announce backstop (called by the timer, or manually in tests). */
  retransmitTick(): void
  /** Publish any tail persisted before a restart, then begin the timer. Idempotent. */
  start(): void
  /** Stop timers and release resources. Idempotent. */
  stop(): void
}

export function createSessionFeed(deps: SessionFeedDeps): SessionFeed {
  const { officeId, selfNodeId, feedStore } = deps
  const now = deps.now ?? Date.now
  const publishDebounceMs = deps.publishDebounceMs ?? DEFAULT_PUBLISH_DEBOUNCE_MS

  const durableLog: DurableFeedLog = createDurableFeedLog({
    store: feedStore,
    officeId,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.genFid ? { genFid: deps.genFid } : {}),
  })

  // Author side: serves THIS node's own session feeds. Session feeds are never
  // pruned (no producer.prune call anywhere in this module): a transcript is the
  // long-term record every late joiner backfills from, so retention is permanent
  // by design — unlike the ctrl plane's acked-prefix trim.
  const ownProducer: FeedProducer = createFeedProducer({
    officeId,
    batchMax: SESSION_BATCH_MAX,
    read: (feedKey, after, limit) => durableLog.read(feedKey, after, limit),
    latestSeq: (feedKey) => durableLog.latestSeq(feedKey),
    send: (peer, frame) => deps.sendToPeer(peer, frame),
    getPeerCursor: (feedKey, peer) => feedStore.getPeerCursor(officeId, feedKey, peer),
    setPeerCursor: (feedKey, peer, seq) => feedStore.setPeerCursor(officeId, feedKey, peer, seq, now()),
  })

  /** Contiguous mirror rows above afterSeq (corrupt rows end the run — contiguity first). */
  function readMirror(feedKey: string, afterSeq: number, limit: number): FeedEntry[] {
    const out: FeedEntry[] = []
    for (const row of feedStore.listCache(officeId, feedKey, afterSeq, limit)) {
      try {
        out.push(JSON.parse(row.entryJson) as FeedEntry)
      } catch {
        break
      }
    }
    return out
  }

  // Serving-replica side: serves feeds AUTHORED ELSEWHERE from the mirror rows
  // this node replicated — how the star's hub carries joiner↔joiner replication.
  const mirrorProducer: FeedProducer = createFeedProducer({
    officeId,
    batchMax: SESSION_BATCH_MAX,
    read: (feedKey, after, limit) => readMirror(feedKey, after, Math.min(limit, MIRROR_READ_LIMIT)),
    latestSeq: (feedKey) => feedStore.getCacheMaxSeq(officeId, feedKey),
    send: (peer, frame) => deps.sendToPeer(peer, frame),
    getPeerCursor: (feedKey, peer) => feedStore.getPeerCursor(officeId, feedKey, peer),
    setPeerCursor: (feedKey, peer, seq) => feedStore.setPeerCursor(officeId, feedKey, peer, seq, now()),
  })

  /** Persist one replicated entry: the mirror row + the history-cache row. */
  function applyEntry(feedKey: string, entry: FeedEntry): void {
    const id = parseFeedIdKey(officeId, feedKey)
    if (!id.kind.startsWith(SESSION_KIND_PREFIX)) return
    const sessionKey = id.kind.slice(SESSION_KIND_PREFIX.length)
    const parsed = parseTeamSessionKey(sessionKey)
    if (!parsed || parsed.teamId !== officeId) {
      console.warn(`${LOG_TAG} entry for foreign/invalid session key office=${officeId} feed=${feedKey}; ignoring`)
      return
    }
    if (entry.type !== ENTRY_MSG) return // forward-compat: consume, don't act
    const msg = entry.payload as SerializedHistoryMessage
    if (typeof msg?.seq !== 'number') {
      console.warn(`${LOG_TAG} malformed msg payload office=${officeId} feed=${feedKey} seq=${entry.seq}; ignoring`)
      return
    }
    // Mirror row: the verbatim entry, so this node can serve the feed onward.
    feedStore.putCache(officeId, feedKey, entry.seq, JSON.stringify(entry))
    // History-cache row: exactly what the cache-first fetchMemberHistory reads —
    // this line is what turns a viewer's history open into a local read.
    feedStore.putCache(
      officeId,
      historyCacheKey(id.author, parsed.appId, parsed.epochId),
      msg.seq,
      JSON.stringify(msg)
    )
    // Push the grown mirror to any peer subscribed through this node, and let
    // peers that have not discovered the feed yet learn it exists.
    mirrorProducer.notifyAppended(feedKey)
    if (deps.servesMirror()) advertise(feedKey)
    deps.onApplied?.({ ownerNodeId: id.author, appId: parsed.appId, epochId: parsed.epochId })
  }

  const consumer: FeedConsumer = createFeedConsumer({
    officeId,
    // Control frames travel toward the author; on a joined office the link's
    // single upstream leg routes them to the serving authority regardless.
    send: (frame) => deps.sendToPeer(parseFeedIdKey(officeId, frame.feedKey).author, frame),
    apply: (feedKey, entry) => applyEntry(feedKey, entry),
    getLocalCursor: (feedKey) => feedStore.getLocalCursor(officeId, feedKey),
    setLocalCursor: (feedKey, seq) => feedStore.setLocalCursor(officeId, feedKey, seq, now()),
    observeHlc: (hlc) => durableLog.observeHlc(hlc),
  })

  // ── Publishing (owner side) ──

  function ownFeedKey(sessionKey: string): string {
    return feedIdKey({ officeId, author: selfNodeId, kind: `${SESSION_KIND_PREFIX}${sessionKey}` as FeedKind })
  }

  // Sessions whose transcript may still hold an unpublished (or provisional)
  // tail. Swept on the tick until an idle publish leaves nothing withheld.
  const dirtySessions = new Set<string>()

  /**
   * Message identity for revision detection. Excludes `ts`: the reader
   * synthesizes a timestamp when an event carries none, so it can drift between
   * reads of an unchanged message and must not count as a content change.
   */
  function msgFingerprint(msg: SerializedHistoryMessage): string {
    return JSON.stringify({
      role: msg.role,
      content: msg.content,
      thoughts: msg.thoughts ?? null,
      thoughtsSummary: msg.thoughtsSummary ?? null,
    })
  }

  function publishOwnedTail(sessionKey: string): number {
    const parsed = parseTeamSessionKey(sessionKey)
    if (!parsed || parsed.teamId !== officeId) return 0
    const feedKey = ownFeedKey(sessionKey)
    const messages = deps.readOwnedTranscript(parsed.teamId, parsed.appId, parsed.epochId)
    if (!messages || messages.length === 0) return 0

    // An in-flight turn's trailing assistant message is a PROVISIONAL flush that
    // keeps changing until the turn ends — withhold it and stay dirty so the
    // idle sweep publishes the finished version.
    const active = deps.isSessionActive(sessionKey)
    const publishable =
      active && messages[messages.length - 1]?.role === 'assistant' ? messages.slice(0, -1) : messages

    // The published message watermark is the LAST entry's payload seq (not the
    // feed seq): a revision entry re-carries an earlier message seq, so the two
    // sequences diverge once a revision was ever appended.
    const feedTail = durableLog.latestSeq(feedKey)
    const lastEntry = feedTail > 0 ? durableLog.read(feedKey, feedTail - 1, 1)[0] : undefined
    const lastMsg = lastEntry?.payload as SerializedHistoryMessage | undefined
    const publishedSeq = typeof lastMsg?.seq === 'number' ? lastMsg.seq : 0

    let appended = 0
    // Self-heal: if the last published message has since changed on disk (an
    // active-gate race, or a replica poisoned before the gate existed), append a
    // revision entry carrying the SAME message seq — consumers upsert their
    // history cache by that seq, so every replica converges on the final form.
    if (lastMsg && publishedSeq > 0) {
      const current = publishable.find((m) => m.seq === publishedSeq)
      if (current && msgFingerprint(current) !== msgFingerprint(lastMsg)) {
        durableLog.append(feedKey, ENTRY_MSG, current)
        appended++
      }
    }
    for (const msg of publishable) {
      if (msg.seq <= publishedSeq) continue
      durableLog.append(feedKey, ENTRY_MSG, msg)
      appended++
    }
    if (appended > 0) {
      ownProducer.notifyAppended(feedKey)
      advertise(feedKey)
    }

    // Fully published only when nothing was withheld and the transcript holds no
    // unseen tail; otherwise keep sweeping.
    if (!active && publishable.length === messages.length) dirtySessions.delete(sessionKey)
    else dirtySessions.add(sessionKey)
    return appended
  }

  // Per-sessionKey trailing debounce + one finalize pass (see FINALIZE_PUBLISH_MS).
  const publishTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const finalizeTimers = new Map<string, ReturnType<typeof setTimeout>>()

  function armTimer(
    map: Map<string, ReturnType<typeof setTimeout>>,
    sessionKey: string,
    delayMs: number,
    fn: () => void
  ): void {
    const existing = map.get(sessionKey)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      map.delete(sessionKey)
      fn()
    }, delayMs)
    if (typeof timer.unref === 'function') timer.unref()
    map.set(sessionKey, timer)
  }

  function schedulePublish(sessionKey: string): void {
    armTimer(publishTimers, sessionKey, publishDebounceMs, () => {
      safePublish(sessionKey)
      armTimer(finalizeTimers, sessionKey, FINALIZE_PUBLISH_MS, () => safePublish(sessionKey))
    })
  }

  function safePublish(sessionKey: string): void {
    try {
      publishOwnedTail(sessionKey)
    } catch (err) {
      console.warn(
        `${LOG_TAG} publish failed office=${officeId} session=${sessionKey}: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }

  // ── Discovery (advertise ↔ subscribe) ──

  // feedKey -> highest seq already broadcast, so append-driven advertises fire
  // only when the feed actually grew (the slow re-announce tick bypasses this).
  const advertisedUpTo = new Map<string, number>()

  function servableUpTo(feedKey: string): number {
    const author = parseFeedIdKey(officeId, feedKey).author
    return author === selfNodeId
      ? durableLog.latestSeq(feedKey)
      : feedStore.getCacheMaxSeq(officeId, feedKey)
  }

  function advertiseFrame(feedKey: string, upToSeq: number): FeedSyncFrame {
    return { kind: 'feed-advertise', officeId, feedKey, upToSeq }
  }

  function advertise(feedKey: string): void {
    const upToSeq = servableUpTo(feedKey)
    if (upToSeq <= (advertisedUpTo.get(feedKey) ?? 0)) return
    advertisedUpTo.set(feedKey, upToSeq)
    deps.broadcast(advertiseFrame(feedKey, upToSeq))
  }

  /** Every session feed this node can serve: authored + (when serving) mirrored. */
  function servableFeedKeys(): string[] {
    const keys = new Set<string>()
    for (const key of feedStore.listLogFeedIds(officeId)) {
      const id = parseFeedIdKey(officeId, key)
      if (id.author === selfNodeId && id.kind.startsWith(SESSION_KIND_PREFIX)) keys.add(key)
    }
    if (deps.servesMirror()) {
      for (const key of feedStore.listCacheFeedIds(officeId)) {
        if (parseFeedIdKey(officeId, key).kind.startsWith(SESSION_KIND_PREFIX)) keys.add(key)
      }
    }
    return [...keys]
  }

  function advertiseAllTo(peer: NodeId): void {
    for (const feedKey of servableFeedKeys()) {
      const upToSeq = servableUpTo(feedKey)
      if (upToSeq > 0) deps.sendToPeer(peer, advertiseFrame(feedKey, upToSeq))
    }
  }

  function reannounceAll(): void {
    for (const feedKey of servableFeedKeys()) {
      const upToSeq = servableUpTo(feedKey)
      if (upToSeq > 0) deps.broadcast(advertiseFrame(feedKey, upToSeq))
    }
  }

  function handleAdvertise(frame: { feedKey: string; upToSeq: number }): void {
    const author = parseFeedIdKey(officeId, frame.feedKey).author
    if (author === selfNodeId) return // own feed announced back (broadcast echo)
    if (feedStore.getLocalCursor(officeId, frame.feedKey) >= frame.upToSeq) return
    consumer.subscribe(frame.feedKey)
  }

  // ── Inbound routing ──

  function handleFrame(from: NodeId, frame: FeedSyncFrame): void {
    switch (frame.kind) {
      case 'feed-advertise':
        handleAdvertise(frame)
        break
      case 'feed-entries': {
        const author = parseFeedIdKey(officeId, frame.feedKey).author
        if (!deps.acceptEntriesFrom(from, author)) {
          console.warn(
            `${LOG_TAG} entries origin rejected office=${officeId} from=${from} author=${author}; dropping`
          )
          return
        }
        consumer.onEntries(frame)
        break
      }
      case 'feed-subscribe':
      case 'feed-ack':
      case 'feed-nack': {
        // Serve own feeds from the durable log; feeds authored elsewhere from the
        // mirror (this node acting as the star's serving replica).
        const producer =
          parseFeedIdKey(officeId, frame.feedKey).author === selfNodeId ? ownProducer : mirrorProducer
        if (frame.kind === 'feed-subscribe') producer.onSubscribe(from, frame.feedKey, frame.afterSeq)
        else if (frame.kind === 'feed-ack') producer.onAck(from, frame.feedKey, frame.ackedSeq)
        else producer.onNack(from, frame.feedKey, frame.missing)
        break
      }
    }
  }

  function dropPeer(peer: NodeId): void {
    ownProducer.dropPeer(peer)
    mirrorProducer.dropPeer(peer)
  }

  // ── Lifecycle ──

  let timer: ReturnType<typeof setInterval> | null = null
  let tickCount = 0
  let healed = false

  function retransmitTick(): void {
    ownProducer.retransmitTick()
    mirrorProducer.retransmitTick()
    // Dirty sweep: a session that still withholds an in-flight tail (or whose
    // publish raced the turn end) republishes until an idle publish completes it.
    for (const sessionKey of [...dirtySessions]) safePublish(sessionKey)
    tickCount += 1
    if (tickCount % REANNOUNCE_EVERY_TICKS === 0) reannounceAll()
  }

  /** Publish any owned tail persisted before the last shutdown (missed triggers). */
  function healOwnedFeeds(): void {
    for (const feedKey of feedStore.listLogFeedIds(officeId)) {
      const id = parseFeedIdKey(officeId, feedKey)
      if (id.author !== selfNodeId || !id.kind.startsWith(SESSION_KIND_PREFIX)) continue
      safePublish(id.kind.slice(SESSION_KIND_PREFIX.length))
    }
  }

  function start(): void {
    if (!healed) {
      healed = true
      healOwnedFeeds()
    }
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
    for (const t of publishTimers.values()) clearTimeout(t)
    publishTimers.clear()
    for (const t of finalizeTimers.values()) clearTimeout(t)
    finalizeTimers.clear()
  }

  return {
    schedulePublish,
    publishOwnedTail,
    advertiseAllTo,
    handleFrame,
    dropPeer,
    retransmitTick,
    start,
    stop,
  }
}
