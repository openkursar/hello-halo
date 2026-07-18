/**
 * apps/runtime/federation -- Cross-node activity stream relay
 *
 * Two halves of the "a teammate's live stream appears on every node" feature,
 * both transport-agnostic (sink + Emitter injected/imported, never http/*):
 *
 *   RelayCapture (owner side) — subscribes onAgentEvent, captures only sessions
 *     this node owns, batches frames per sessionKey, and hands each flush to an
 *     injected sink. Runs off the event callback so the producer never blocks.
 *
 *   StreamReplay (viewer side) — re-fires each received frame as a local
 *     emitAgentEvent so the existing ipc/agent → renderer/WS chain delivers it
 *     unchanged. Per-sessionKey seq dedup makes apply() idempotent.
 *
 * INV-NO-LOOP is enforced structurally at each guard below (isOwnTeamSession +
 * the relayed flag) and asserted in tests.
 *
 * Scope: in-memory streamSeq with a per-process originRun so viewers survive an
 * owner restart (the watermark resets with the new run instead of dropping the
 * new frames), drop-incremental backpressure, ordered replay + dedup. Full
 * reorder/gap-fill is future work.
 *
 * Dependency direction: imports services/agent (downward, allowed); never http/*.
 */

import { randomUUID } from 'crypto'

import { onAgentEvent, emitAgentEvent } from '../../../services/agent/events'
import type { IDisposable } from '../../../platform/event'
import { classifyChannel, type StreamFrame, type StreamFramesFrame } from './types'

const LOG_TAG = '[Relay]'

// ── Batching / backpressure constants ──

/** Flush a session's batch this long after its first pending frame. */
const BATCH_WINDOW_MS = 50
/** Flush early once a batch reaches this many frames. */
const BATCH_MAX_FRAMES = 64
/** Flush early once a batch's serialized size reaches ~this many bytes. */
const BATCH_MAX_BYTES = 64 * 1024
/**
 * Hard cap on a session's pending batch length. Past this, drop the OLDEST
 * incremental frames first (keep milestones); never block the producer
 * (priority: never-block > bounded > keep-milestones).
 */
const PENDING_HARD_CAP = 4 * BATCH_MAX_FRAMES

export interface RelayCaptureDeps {
  /**
   * True only for a team session owned by THIS node — the privacy boundary AND
   * the INV-NO-LOOP guard. Bootstrap composes this from isTeamSessionKey +
   * a teamStore ownerNodeId === SELF_NODE_ID lookup.
   */
  isOwnTeamSession: (conversationId: string) => boolean
  /** Office a session belongs to, so the sink can route the batch. Null = skip. */
  resolveOffice: (conversationId: string) => string | null
  /** Transport hand-off for a flushed batch (async/non-blocking). */
  sink: (officeId: string, batch: StreamFramesFrame) => void
  now?: () => number
}

export interface RelayCapture {
  /** Subscribe onAgentEvent; returns a disposable the caller stores. */
  start(): IDisposable
  /** Flush every pending batch (teardown / deterministic tests). */
  flushAll(): void
}

interface PendingBatch {
  frames: StreamFrame[]
  /** Approx serialized size of the pending frames, for the byte trigger. */
  bytes: number
  timer: ReturnType<typeof setTimeout> | null
}

export function createRelayCapture(deps: RelayCaptureDeps): RelayCapture {
  const { isOwnTeamSession, resolveOffice, sink } = deps
  const now = deps.now ?? (() => Date.now())

  // Fresh per capture instance (= per process run). Stamped on every batch so
  // viewers can tell "this producer restarted, its seq domain restarted at 1"
  // apart from "these frames are duplicates" — without it, an owner restart made
  // viewers silently drop every new frame below the old watermark.
  const originRun = randomUUID()

  // Per-sessionKey monotonic counter (starts at 1; a new epoch ⇒ new sessionKey
  // ⇒ fresh counter). In-memory only; a restart is signaled via originRun above.
  const streamSeq = new Map<string, number>()
  const pending = new Map<string, PendingBatch>()

  function nextSeq(sessionKey: string): number {
    const seq = (streamSeq.get(sessionKey) ?? 0) + 1
    streamSeq.set(sessionKey, seq)
    return seq
  }

  function flush(sessionKey: string): void {
    const batch = pending.get(sessionKey)
    if (!batch || batch.frames.length === 0) return
    if (batch.timer) {
      clearTimeout(batch.timer)
      batch.timer = null
    }
    pending.delete(sessionKey)

    const officeId = resolveOffice(sessionKey)
    if (officeId === null) return

    sink(officeId, {
      kind: 'stream-frames',
      officeId,
      sessionKey,
      baseSeq: batch.frames[0].seq,
      frames: batch.frames,
      originRun,
    })
  }

  /**
   * Drop the oldest incremental frames to bring a saturated batch back under
   * the cap; if incrementals are exhausted and milestones still overflow, drop
   * the oldest milestone (bounded wins over keep-milestones). Never blocks the
   * caller.
   */
  function shed(batch: PendingBatch): void {
    let i = 0
    while (batch.frames.length > PENDING_HARD_CAP && i < batch.frames.length) {
      if (batch.frames[i].kind === 'incremental') {
        batch.frames.splice(i, 1)
        continue
      }
      i++
    }
    while (batch.frames.length > PENDING_HARD_CAP) {
      batch.frames.shift()
    }
    console.warn(`${LOG_TAG} backpressure shed sessionKey saturated, dropped to ${batch.frames.length}`)
  }

  function enqueue(sessionKey: string, frame: StreamFrame): void {
    let batch = pending.get(sessionKey)
    if (!batch) {
      batch = { frames: [], bytes: 0, timer: null }
      pending.set(sessionKey, batch)
    }
    batch.frames.push(frame)
    batch.bytes += approxBytes(frame)

    if (batch.frames.length > PENDING_HARD_CAP) shed(batch)

    if (batch.frames.length >= BATCH_MAX_FRAMES || batch.bytes >= BATCH_MAX_BYTES) {
      flush(sessionKey)
      return
    }
    if (!batch.timer) {
      batch.timer = setTimeout(() => flush(sessionKey), BATCH_WINDOW_MS)
      if (typeof batch.timer.unref === 'function') batch.timer.unref()
    }
  }

  function start(): IDisposable {
    return onAgentEvent((e) => {
      // INV-NO-LOOP (structural): never re-capture an event that arrived via
      // relay replay, even for a session this node owns. A host fan-out can echo
      // a producer's own batch back to it (broadcast to all office clients incl.
      // the producer); without this guard the owner would re-capture its own
      // replayed frames and relay them again — an unbounded A→B→A amplification
      // loop. The owner-only filter below does NOT stop this, because a relayed
      // frame for an OWNED session passes it. This flag does.
      if (e.relayed) return

      // Owner-only + team-only: the privacy boundary AND the INV-NO-LOOP guard.
      // A viewer node's re-fired events are for members it does NOT own, so they
      // are rejected here — never re-captured, no relay loop.
      if (!isOwnTeamSession(e.conversationId)) return

      const sessionKey = e.conversationId
      const frame: StreamFrame = {
        seq: nextSeq(sessionKey),
        kind: classifyChannel(e.channel),
        channel: e.channel,
        spaceId: e.spaceId,
        payload: e.data,
      }
      enqueue(sessionKey, frame)
    })
  }

  function flushAll(): void {
    for (const sessionKey of [...pending.keys()]) flush(sessionKey)
  }

  return { start, flushAll }
}

export interface StreamReplayDeps {
  now?: () => number
}

export interface StreamReplay {
  /** Re-fire each new frame as a local agent event; idempotent per sessionKey. */
  apply(batch: StreamFramesFrame): void
}

export function createStreamReplay(_deps: StreamReplayDeps = {}): StreamReplay {
  // Per-sessionKey highest applied seq. Same-machine LAN ⇒ in-order; a basic seq
  // guard + dedup is sufficient for now (full reorder/gap-fill is backlog).
  const lastSeq = new Map<string, number>()
  // Per-sessionKey producer run id last seen (see StreamFramesFrame.originRun).
  const lastRun = new Map<string, string>()

  function apply(batch: StreamFramesFrame): void {
    // A NEW producer run means the owner restarted and its seq domain restarted
    // at 1: reset the watermark so post-restart frames are replayed instead of
    // silently dropped as "duplicates" of the previous run's higher seqs.
    if (batch.originRun && lastRun.get(batch.sessionKey) !== batch.originRun) {
      lastRun.set(batch.sessionKey, batch.originRun)
      lastSeq.delete(batch.sessionKey)
    }
    const seen = lastSeq.get(batch.sessionKey) ?? 0
    let highest = seen
    // Sort by seq so an out-of-order batch still replays in stream order.
    const ordered = [...batch.frames].sort((a, b) => a.seq - b.seq)
    for (const frame of ordered) {
      if (frame.seq <= seen) continue // dedup drop
      // Re-fire into the local Emitter, tagged relayed=true so the local
      // RelayCapture refuses to re-capture it (INV-NO-LOOP, structural). This
      // holds even on the producing node when a host fan-out echoes the batch
      // back to it — the owner-only filter alone would NOT, since the session is
      // owned here.
      emitAgentEvent(frame.channel, frame.spaceId, batch.sessionKey, frame.payload, true)
      if (frame.seq > highest) highest = frame.seq
    }
    if (highest > seen) lastSeq.set(batch.sessionKey, highest)
  }

  return { apply }
}

/** Cheap per-frame size estimate for the batch byte trigger (no full JSON). */
function approxBytes(frame: StreamFrame): number {
  try {
    return JSON.stringify(frame).length
  } catch {
    return 64
  }
}
