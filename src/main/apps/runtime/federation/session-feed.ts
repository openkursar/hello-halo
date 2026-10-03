/**
 * apps/runtime/federation -- Session-transcript feeds
 *
 * Replicates members' run transcripts over the unified feed substrate
 * (runtime/federation/log). The OWNER appends each transcript message to its own
 * `session:<sessionKey>` feed (single writer, append-only). The office authority
 * keeps a copy of every feed: a verbatim MIRROR row it serves onward, plus a
 * HISTORY-CACHE row. Any other node copies only the feeds a local viewer shows
 * (`wantsReplica`), keeps just the history-cache rows, and releases a copy's
 * subscription a grace period after nobody here shows it. History is readable
 * while the authority is online; a copy that is not local is fetched when shown
 * and never reads as "this member said nothing".
 *
 * Mutable-tail contract: the transcript reader merges an in-flight turn's events
 * into a provisional trailing assistant message that keeps changing until the
 * turn ends. The publisher therefore (a) withholds that trailing message while
 * the session is active, and (b) appends a same-seq REVISION entry whenever the
 * last published message changed on disk — consumers upsert by message seq, so
 * every replica converges on the finished form even across races.
 *
 * Topology: joiners exchange frames only with the office authority (star), so a
 * subscribe for a feed authored elsewhere is served from the authority's mirror.
 * Discovery: an owner announces its own feeds to the authority with
 * `feed-advertise`; the authority announces to peers with `feed-digest` (the full
 * list when a peer joins or comes online, then only what grew). A consumer that
 * wants a feed and is behind answers with a subscribe from its watermark.
 * Retention: a node that does not serve prunes its own feeds below the
 * authority's ack.
 *
 * Transport- and domain-agnostic seam like ctrl-feed: `sendToPeer`/`broadcast`
 * (link routing) and `readOwnedTranscript` (chat storage) are injected; nothing
 * here holds quorum, term, or election state.
 */

import type { FeedStore } from '../../federation'
import { buildTeamSessionKey, parseTeamSessionKey } from '../../../../shared/apps/im-keys'
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
/**
 * Full `feed-digest` resend to every peer every N ticks (10 min at 5 s). In
 * between each gets only the feeds that grew since it was last told, so an idle
 * office announces nothing; the full resend heals a dropped digest.
 */
const FULL_DIGEST_EVERY_TICKS = 120
/**
 * How long a copied feed stays subscribed after no local viewer shows it any
 * more, so a panel closed and reopened does not churn subscriptions.
 */
export const REPLICA_RELEASE_GRACE_MS = 60_000
/** How long an epoch has been over before a node that does not serve drops its unwanted copy. */
export const SETTLED_EPOCH_ARCHIVE_MS = 7 * 24 * 60 * 60 * 1000
/** Settled-copy archiving pass cadence in retransmit ticks (6 h at the default 5 s). */
const ARCHIVE_EVERY_TICKS = 4320
/** Transcript messages carried per feed entry batch (entries can be large: thoughts). */
const SESSION_BATCH_MAX = 16
/**
 * Ceiling on ONE published transcript message. A turn with long tool calls yields
 * a single message whose thought trace runs to megabytes; published whole it
 * exceeds the relay's per-frame limit, and the durable outbox re-offers it on
 * every reconnect. Nothing downstream can break that loop, so the bound belongs
 * here, where the entry is created.
 */
const MAX_PUBLISHED_MESSAGE_BYTES = 256 * 1024
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
  if (frame.kind === 'feed-digest') return true
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
  /**
   * Owner-side: serialized transcript of a member THIS node owns (sync read).
   * `sinceSeq` (a publish watermark) narrows the read to that message and
   * everything after it — the idle sweep republishes every few seconds while a
   * turn runs, so a whole-transcript read there would cost O(transcript size)
   * per tick. Inclusive of `sinceSeq` itself: the revision self-heal compares
   * the last published message against its current on-disk form.
   */
  readOwnedTranscript: (
    teamId: string,
    appId: string,
    epochId: string,
    sinceSeq?: number
  ) => SerializedHistoryMessage[] | null
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
  /**
   * The office authority this node publishes to. A node that does not serve
   * drops the prefix of its own feeds the authority has acked — the authority's
   * mirror is the office's copy from then on. Absent → own feeds are kept whole.
   */
  authorityNodeId?: () => NodeId | null
  /**
   * Whether this node keeps a local copy of `feedKey`: true while a local viewer
   * shows the session. A feed it does not want is only remembered (`upToSeq`),
   * and subscribed when a panel opens on it. Absent → every announced feed is
   * replicated.
   */
  wantsReplica?: (feedKey: string) => boolean
  /**
   * Serving side: the peers to announce feeds to, as `feed-digest` frames (one
   * full digest when a peer comes online, then only what grew since it was last
   * told, plus a slow full resend). Null or absent → this node does not serve:
   * its own feeds are announced to its upstream with one `feed-advertise` each.
   */
  announceTargets?: () => NodeId[] | null
  /**
   * When an epoch ended (null while open or unknown). A node that does not serve
   * drops its copy of feeds it no longer wants once their epoch has been over
   * for `SETTLED_EPOCH_ARCHIVE_MS`; opening such a history fetches it again.
   */
  epochEndedAt?: (epochId: string) => number | null
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
  /** Re-check which remembered feeds are wanted now, and subscribe the ones behind. */
  refreshWanted(): void
  /**
   * Restart every copy this node is taking. After a (re)join the serving node may
   * have restarted and forgotten its subscribers, like live-stream subscriptions.
   */
  resubscribeCopies(): void
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
    truncatedBeforeSeq: (feedKey) => feedStore.getMeta(officeId, feedKey)?.truncatedBeforeSeq ?? 0,
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
    latestSeq: (feedKey) => servableUpTo(feedKey),
    send: (peer, frame) => deps.sendToPeer(peer, frame),
    getPeerCursor: (feedKey, peer) => feedStore.getPeerCursor(officeId, feedKey, peer),
    setPeerCursor: (feedKey, peer, seq) => feedStore.setPeerCursor(officeId, feedKey, peer, seq, now()),
    truncatedBeforeSeq: (feedKey) => mirrorFloor(feedKey),
  })

  /**
   * Below this seq the mirror holds nothing. A node mirrors only while it serves
   * (a plain joiner never serves anyone), so a node elected later starts its
   * mirror mid-feed; announcing that floor lets a consumer behind it skip ahead
   * instead of nacking a range this replica can never produce. A consumer that
   * skips keeps a hole in its history copy, which the cache-first history read
   * detects and fills from the owner.
   */
  function mirrorFloor(feedKey: string): number {
    const min = feedStore.getCacheMinSeq(officeId, feedKey)
    return min > 1 ? min - 1 : 0
  }

  /** Keep the mirror a contiguous suffix: a row that would leave a hole replaces what came before it. */
  function writeMirrorRow(feedKey: string, entry: FeedEntry): void {
    const max = servableUpTo(feedKey)
    if (max > 0 && max < entry.seq - 1) {
      const dropped = feedStore.deleteCacheFeed(officeId, feedKey)
      console.warn(
        `${LOG_TAG} mirror restarted office=${officeId} feed=${feedKey} at seq=${entry.seq}; dropped ${dropped} rows before a gap`
      )
    }
    feedStore.putCache(officeId, feedKey, entry.seq, JSON.stringify(entry))
    servable.set(feedKey, entry.seq)
  }

  // Feeds whose mirror grew during the batch being applied; served onward once
  // the batch is done rather than once per entry.
  const mirrorGrew = new Set<string>()

  /** Push each grown mirror to peers subscribed through this node and announce it to the rest. */
  function flushMirrorGrowth(): void {
    for (const feedKey of mirrorGrew) {
      mirrorProducer.notifyAppended(feedKey)
      advertise(feedKey)
    }
    mirrorGrew.clear()
  }

  /** Persist one replicated entry: the history-cache row, plus the mirror row while serving. */
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
    // History-cache row: exactly what the cache-first fetchMemberHistory reads —
    // this line is what turns a viewer's history open into a local read.
    feedStore.putCache(
      officeId,
      historyCacheKey(id.author, parsed.appId, parsed.epochId),
      msg.seq,
      JSON.stringify(msg)
    )
    // Mirror row: the verbatim entry, so this node can serve the feed onward. Only
    // the serving node needs it — a joiner that mirrored every feed paid a second
    // copy of every transcript for a replica nobody reads.
    if (deps.servesMirror()) {
      writeMirrorRow(feedKey, entry)
      mirrorGrew.add(feedKey)
    }
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
    // A batch of transcript entries commits once instead of several writes per entry.
    transaction: (fn) => feedStore.transaction(fn),
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

  // Sessions already reported as carrying an over-ceiling message, so the warning
  // is written once per session rather than on every publish sweep.
  const loggedTrimmed = new Set<string>()

  /**
   * A published copy of `msg` that fits the wire ceiling. The thought trace is the
   * part that grows without bound, so it goes first; a viewer seeing less detail
   * is a cost worth paying for a replica that arrives at all. `seq` and `role` are
   * untouched — consumers upsert history by message seq, so a trimmed copy must
   * still read as a revision of the same message.
   */
  function fitPublishedMessage(
    sessionKey: string,
    msg: SerializedHistoryMessage
  ): SerializedHistoryMessage {
    const size = JSON.stringify(msg).length
    if (size <= MAX_PUBLISHED_MESSAGE_BYTES) return msg

    if (!loggedTrimmed.has(sessionKey)) {
      loggedTrimmed.add(sessionKey)
      console.warn(
        `${LOG_TAG} transcript message too large to replicate: session=${sessionKey} seq=${msg.seq} ` +
          `bytes=${size} ceiling=${MAX_PUBLISHED_MESSAGE_BYTES}; publishing without its thought trace`
      )
    }

    const withoutThoughts: SerializedHistoryMessage = { ...msg }
    delete withoutThoughts.thoughts
    delete withoutThoughts.thoughtsSummary
    if (JSON.stringify(withoutThoughts).length <= MAX_PUBLISHED_MESSAGE_BYTES) return withoutThoughts

    // Still over: the text itself is the bulk. Keep a readable head and say what
    // was cut, so a replica reads as truncated rather than as a shorter answer.
    const envelopeBytes = JSON.stringify({ ...withoutThoughts, content: '' }).length
    const room = Math.max(0, MAX_PUBLISHED_MESSAGE_BYTES - envelopeBytes - 128)
    return {
      ...withoutThoughts,
      content: `${withoutThoughts.content.slice(0, room)}\n\n[truncated for cross-machine replication: ${size} bytes]`,
    }
  }

  function publishOwnedTail(sessionKey: string): number {
    const parsed = parseTeamSessionKey(sessionKey)
    if (!parsed || parsed.teamId !== officeId) return 0
    const feedKey = ownFeedKey(sessionKey)

    // The published message watermark is the LAST entry's payload seq (not the
    // feed seq): a revision entry re-carries an earlier message seq, so the two
    // sequences diverge once a revision was ever appended. Read BEFORE the
    // transcript: it bounds the read to what is left to publish.
    const feedTail = durableLog.latestSeq(feedKey)
    const lastEntry = feedTail > 0 ? durableLog.read(feedKey, feedTail - 1, 1)[0] : undefined
    const lastMsg = lastEntry?.payload as SerializedHistoryMessage | undefined
    const publishedSeq = typeof lastMsg?.seq === 'number' ? lastMsg.seq : 0

    const active = deps.isSessionActive(sessionKey)
    const messages = deps.readOwnedTranscript(parsed.teamId, parsed.appId, parsed.epochId, publishedSeq)
    if (!messages) return 0
    // An empty tail after a watermark means nothing new since the last publish:
    // an idle session has therefore completed publishing (clear the marker the
    // idle publish used to clear); an active one still withholds its final form.
    if (messages.length === 0) {
      if (!active) dirtySessions.delete(sessionKey)
      return 0
    }

    // An in-flight turn's trailing assistant message is a PROVISIONAL flush that
    // keeps changing until the turn ends — withhold it and stay dirty so the
    // idle sweep publishes the finished version.
    const publishable =
      active && messages[messages.length - 1]?.role === 'assistant' ? messages.slice(0, -1) : messages

    let appended = 0
    // Self-heal: if the last published message has since changed on disk (an
    // active-gate race, or a replica poisoned before the gate existed), append a
    // revision entry carrying the SAME message seq — consumers upsert their
    // history cache by that seq, so every replica converges on the final form.
    if (lastMsg && publishedSeq > 0) {
      const current = publishable.find((m) => m.seq === publishedSeq)
      // Compare the forms that are actually PUBLISHED. Fingerprinting the on-disk
      // message against a trimmed replica would differ forever, and this branch
      // would append a revision on every sweep.
      const currentPublished = current ? fitPublishedMessage(sessionKey, current) : undefined
      if (currentPublished && msgFingerprint(currentPublished) !== msgFingerprint(lastMsg)) {
        durableLog.append(feedKey, ENTRY_MSG, currentPublished)
        appended++
      }
    }
    for (const msg of publishable) {
      if (msg.seq <= publishedSeq) continue
      durableLog.append(feedKey, ENTRY_MSG, fitPublishedMessage(sessionKey, msg))
      appended++
    }
    if (appended > 0) {
      servable.set(feedKey, durableLog.latestSeq(feedKey))
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

  // Every session feed this node can serve (own, or mirrored while serving) ->
  // its highest seq. Kept in memory from appends and applies; the tables are
  // scanned once, so a re-announce never re-reads the whole cache.
  const servable = new Map<string, number>()
  let servableSeeded = false

  function seedServable(): void {
    if (servableSeeded) return
    servableSeeded = true
    for (const key of feedStore.listLogFeedIds(officeId)) {
      const id = parseFeedIdKey(officeId, key)
      if (id.author !== selfNodeId || !id.kind.startsWith(SESSION_KIND_PREFIX)) continue
      if (!servable.has(key)) servable.set(key, durableLog.latestSeq(key))
    }
    for (const key of feedStore.listCacheFeedIds(officeId)) {
      const id = parseFeedIdKey(officeId, key)
      if (id.author === selfNodeId || !id.kind.startsWith(SESSION_KIND_PREFIX)) continue
      if (!servable.has(key)) servable.set(key, feedStore.getCacheMaxSeq(officeId, key))
    }
  }

  function servableUpTo(feedKey: string): number {
    seedServable()
    return servable.get(feedKey) ?? 0
  }

  function advertiseFrame(feedKey: string, upToSeq: number): FeedSyncFrame {
    return { kind: 'feed-advertise', officeId, feedKey, upToSeq }
  }

  function advertise(feedKey: string): void {
    const upToSeq = servableUpTo(feedKey)
    if (upToSeq <= (advertisedUpTo.get(feedKey) ?? 0)) return
    advertisedUpTo.set(feedKey, upToSeq)
    // A serving node's peers learn it from the next tick's delta digest.
    if (!deps.announceTargets?.()) deps.broadcast(advertiseFrame(feedKey, upToSeq))
  }

  // Digest peer -> (feedKey -> upToSeq it was last told).
  const toldDigest = new Map<NodeId, Map<string, number>>()

  function sendDigest(peer: NodeId, feeds: Array<[string, number]>): void {
    if (feeds.length === 0) return
    let told = toldDigest.get(peer)
    if (!told) toldDigest.set(peer, (told = new Map()))
    for (const [feedKey, upToSeq] of feeds) told.set(feedKey, upToSeq)
    deps.sendToPeer(peer, { kind: 'feed-digest', officeId, feeds })
  }

  /** Each peer gets only the feeds that grew since it was last told. */
  function sendDigestDeltas(targets: NodeId[]): void {
    let list: Array<[string, number]> | null = null
    for (const peer of targets) {
      list ??= servableList()
      const told = toldDigest.get(peer)
      sendDigest(peer, told ? list.filter(([key, upToSeq]) => (told.get(key) ?? 0) < upToSeq) : list)
    }
  }

  /** Every session feed this node can serve: authored + (when serving) mirrored. */
  function servableFeedKeys(): string[] {
    seedServable()
    const serving = deps.servesMirror()
    const keys: string[] = []
    for (const key of servable.keys()) {
      if (serving || parseFeedIdKey(officeId, key).author === selfNodeId) keys.push(key)
    }
    return keys
  }

  function servableList(): Array<[string, number]> {
    const feeds: Array<[string, number]> = []
    for (const feedKey of servableFeedKeys()) {
      const upToSeq = servableUpTo(feedKey)
      if (upToSeq > 0) feeds.push([feedKey, upToSeq])
    }
    return feeds
  }

  function advertiseAllTo(peer: NodeId): void {
    sendDigest(peer, servableList())
  }

  /**
   * Self-healing re-announce: a node that does not serve re-advertises its own
   * feeds to its upstream; a serving node resends every peer the full digest,
   * but only rarely (deltas go every tick).
   */
  function reannounceAll(fullDigest: boolean): void {
    const targets = deps.announceTargets?.()
    if (!targets) {
      for (const [feedKey, upToSeq] of servableList()) deps.broadcast(advertiseFrame(feedKey, upToSeq))
      return
    }
    if (fullDigest) for (const peer of targets) advertiseAllTo(peer)
  }

  // Feeds announced to this node that it has not replicated (not wanted yet).
  const knownFeeds = new Map<string, number>()
  // Remote feeds this node subscribed to, and when each one no longer wanted is released.
  const replicating = new Set<string>()
  const releaseAt = new Map<string, number>()

  function replicate(feedKey: string, restart: boolean): void {
    replicating.add(feedKey)
    releaseAt.delete(feedKey)
    if (restart) consumer.subscribe(feedKey)
    else consumer.ensureSubscribed(feedKey)
  }

  /**
   * A copied feed nobody here shows any more stops arriving after a grace period:
   * the authority stops pushing it, and the cursor stays for when it is shown
   * again. Traffic follows the sessions shown now, not every session ever shown.
   */
  function releaseUnwanted(): void {
    const t = now()
    for (const feedKey of replicating) {
      if (wanted(feedKey)) {
        releaseAt.delete(feedKey)
        continue
      }
      const due = releaseAt.get(feedKey)
      if (due === undefined) {
        releaseAt.set(feedKey, t + REPLICA_RELEASE_GRACE_MS)
        continue
      }
      if (t < due) continue
      releaseAt.delete(feedKey)
      replicating.delete(feedKey)
      consumer.unsubscribe(feedKey)
    }
  }

  function wanted(feedKey: string): boolean {
    return deps.wantsReplica?.(feedKey) ?? true
  }

  /**
   * `fromAuthor`: the feed's own author announced it (after an append, or after
   * it restarted and forgot who subscribed), so a copy already running restarts.
   * A serving node's digest does not restart one: that copy is being pushed.
   */
  function handleAdvertise(frame: { feedKey: string; upToSeq: number }, fromAuthor: boolean): void {
    const author = parseFeedIdKey(officeId, frame.feedKey).author
    if (author === selfNodeId) return // own feed announced back (broadcast echo)
    if (!parseFeedIdKey(officeId, frame.feedKey).kind.startsWith(SESSION_KIND_PREFIX)) return
    knownFeeds.set(frame.feedKey, Math.max(knownFeeds.get(frame.feedKey) ?? 0, frame.upToSeq))
    if (!wanted(frame.feedKey)) return
    if (feedStore.getLocalCursor(officeId, frame.feedKey) >= frame.upToSeq) return
    replicate(frame.feedKey, fromAuthor || !replicating.has(frame.feedKey))
  }

  function resubscribeCopies(): void {
    for (const feedKey of replicating) consumer.subscribe(feedKey)
  }

  function refreshWanted(): void {
    for (const [feedKey, upToSeq] of knownFeeds) {
      if (!wanted(feedKey)) continue
      if (replicating.has(feedKey)) {
        releaseAt.delete(feedKey)
        continue
      }
      if (feedStore.getLocalCursor(officeId, feedKey) >= upToSeq) continue
      replicate(feedKey, false)
    }
    releaseUnwanted()
  }

  // ── Archiving copies nobody here wants ──

  /**
   * On a node that does not serve, the copy of a feed it does not want is
   * dropped once the feed's epoch has been over long enough: its history rows
   * go and its cursor returns to 0, so opening that history later subscribes
   * afresh through the authority's mirror (or reports it unreachable while the
   * authority is offline) instead of reading a partial copy.
   */
  function archiveSettledCopies(): void {
    if (deps.servesMirror() || !deps.wantsReplica || !deps.epochEndedAt) return
    const cutoff = now() - SETTLED_EPOCH_ARCHIVE_MS
    let archived = 0
    for (const key of feedStore.listCacheFeedIds(officeId)) {
      if (!key.startsWith('history\u0000')) continue
      const [, owner, appId, epochId] = key.split('\u0000')
      if (!owner || !appId || !epochId || owner === selfNodeId) continue
      const ended = deps.epochEndedAt(epochId)
      if (ended === null || ended > cutoff) continue
      const feedKey = feedIdKey({
        officeId,
        author: owner,
        kind: `${SESSION_KIND_PREFIX}${buildTeamSessionKey(appId, officeId, epochId)}` as FeedKind,
      })
      // Still subscribed (not yet past its release grace): entries keep arriving.
      if (wanted(feedKey) || replicating.has(feedKey)) continue
      feedStore.deleteCacheFeed(officeId, key)
      feedStore.setLocalCursor(officeId, feedKey, 0, now())
      archived += 1
    }
    if (archived > 0) console.log(`${LOG_TAG} archived ${archived} settled transcript copies office=${officeId}`)
  }

  // ── Inbound routing ──

  function handleFrame(from: NodeId, frame: FeedSyncFrame): void {
    switch (frame.kind) {
      case 'feed-digest':
        for (const [feedKey, upToSeq] of frame.feeds) handleAdvertise({ feedKey, upToSeq }, false)
        break
      case 'feed-advertise':
        handleAdvertise(frame, parseFeedIdKey(officeId, frame.feedKey).author === from)
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
        flushMirrorGrowth()
        break
      }
      case 'feed-unsubscribe': {
        const producer =
          parseFeedIdKey(officeId, frame.feedKey).author === selfNodeId ? ownProducer : mirrorProducer
        producer.unsubscribe(from, frame.feedKey)
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
    toldDigest.delete(peer)
  }

  // ── Retention ──

  // Own feed -> the floor already pruned to, so each pass only moves forward.
  const ownPrunedThrough = new Map<string, number>()

  /**
   * While another node is the authority, keep only the part of each own feed it
   * has not acked yet, plus the last entry (the publisher reads it back to know
   * what it already published). The authority keeps its own feeds whole: its
   * copy is the one the office reads.
   */
  function pruneOwnFeeds(): void {
    if (deps.servesMirror()) return
    const authority = deps.authorityNodeId?.()
    if (!authority || authority === selfNodeId) return
    seedServable()
    for (const [feedKey, latest] of servable) {
      if (parseFeedIdKey(officeId, feedKey).author !== selfNodeId) continue
      const floor = Math.min(feedStore.getPeerCursor(officeId, feedKey, authority), latest - 1)
      if (floor <= (ownPrunedThrough.get(feedKey) ?? 0)) continue
      durableLog.truncate(feedKey, floor)
      ownPrunedThrough.set(feedKey, floor)
    }
  }

  /**
   * A node that does not serve has no use for mirror rows of feeds authored
   * elsewhere (older versions wrote them on every node). Its history-cache rows
   * are kept — they are what opens history locally.
   */
  function dropUnservedMirrors(): void {
    if (deps.servesMirror()) return
    seedServable()
    let dropped = 0
    for (const feedKey of [...servable.keys()]) {
      if (parseFeedIdKey(officeId, feedKey).author === selfNodeId) continue
      dropped += feedStore.deleteCacheFeed(officeId, feedKey)
      servable.delete(feedKey)
    }
    if (dropped > 0) console.log(`${LOG_TAG} dropped ${dropped} unserved mirror rows office=${officeId}`)
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
    releaseUnwanted()
    tickCount += 1
    const targets = deps.announceTargets?.()
    if (targets) sendDigestDeltas(targets)
    if (tickCount % REANNOUNCE_EVERY_TICKS === 0) {
      reannounceAll(tickCount % FULL_DIGEST_EVERY_TICKS === 0)
      pruneOwnFeeds()
    }
    // Once, after the authority role has had time to settle following a start.
    if (tickCount === REANNOUNCE_EVERY_TICKS * 2) dropUnservedMirrors()
    if (tickCount === REANNOUNCE_EVERY_TICKS * 4 || tickCount % ARCHIVE_EVERY_TICKS === 0) archiveSettledCopies()
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
    refreshWanted,
    resubscribeCopies,
    handleFrame,
    dropPeer,
    retransmitTick,
    start,
    stop,
  }
}
