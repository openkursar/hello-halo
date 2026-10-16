/**
 * apps/runtime/federation -- Joiner-side outbound WS client
 *
 * The joiner role's only network leg: an outbound WebSocket to the host office's
 * server. It authenticates with the office credential, then exchanges
 * 'federation' frames. This is a thin transport — it carries no join/presence
 * semantics; the coordinator drives those through a FederationLink backed by
 * this client.
 *
 * Uses the `ws` npm library directly. That is a library dependency, not the
 * http/* transport tier, so the federation module's downward-only dependency
 * direction holds: the joiner never imports websocket.ts.
 *
 * Reconnect uses exponential backoff (1s→…→30s cap), mirroring the renderer
 * transport, except after a refusal the consumer reports (markRefused): the
 * consumer's retry delay then replaces it. Timers are unref'd so a pending
 * reconnect never keeps the process (or a test runner) alive.
 */

import WebSocket from 'ws'

import { framePlane, type FederationMessage, type FramePlane, type NodeId } from './types'
import { PlaneQueue } from './plane-queue'

const LOG_TAG = '[FedClient]'

/**
 * The wire envelope. A feed-plane frame carries its plane: a relay cannot tell a
 * transcript frame from a ctrl-feed one by kind, and does not read payloads.
 */
function envelope(frame: FederationMessage, to: NodeId | null): string {
  const plane = framePlane(frame)
  return JSON.stringify({ type: 'federation', ...(to ? { to } : {}), ...(plane === 'feed' ? { plane } : {}), payload: frame })
}

const BACKOFF_BASE_MS = 1000
const BACKOFF_MAX_MS = 30_000

export type WsFederationClientState = 'connecting' | 'open' | 'closed'

/**
 * A signed identity proof answering the host's auth challenge. Shape mirrors the
 * host-side device-key resolver contract (http/identity); this module treats it
 * as opaque data — building/signing it is injected so the federation layer never
 * imports the identity/key modules (dependency direction).
 */
export type FederationAuthProof = Record<string, unknown>

export interface WsFederationClientDeps {
  /** Host server base URL, e.g. ws://host:3017 or http://host:3017 (upgraded). */
  serverUrl: string
  /** Office-member credential token presented on the WS auth handshake. */
  credentialToken: string
  /**
   * Build the signed proof for a host-issued auth challenge (base64 nonce →
   * device-key proof). A federation session REQUIRES a proven node identity:
   * when this is absent or returns null the client cannot complete the node
   * handshake and closes (the host would reject its frames anyway).
   */
  makeAuthProof?: (nonce: string) => FederationAuthProof | null
  /**
   * The office this connection speaks for, carried in the auth payload. Enables
   * ROSTER RE-ENTRY on the receiving side: when the invite token cannot be
   * verified there (it was signed by a lost creator's key — e.g. dialing a
   * newly-elected authority), a proven identity that is already an admitted
   * node of this office is re-admitted without a fresh invite.
   */
  officeId?: string
  /** Delivered every inbound 'federation' frame after auth succeeds. */
  onFrame: (frame: FederationMessage, from?: NodeId) => void
  /** Connection lifecycle, surfaced for the manager's logging/diagnostics. */
  onStateChange?: (state: WsFederationClientState) => void
  /**
   * GATEWAY sessions only: the relay reported the room's host is gone
   * (gw:host-lost). Receiving it also proves this joined office rides a
   * gateway — the manager marks the office relay-backed so a later election
   * win claims the room (gw:host-attach with the new term) instead of trying
   * to dial WAN peers directly. LAN sessions never see this envelope.
   */
  onGatewayHostLost?: () => void
  /**
   * Fired when the link re-authenticates AFTER a prior drop — i.e. a reconnect,
   * never the initial auth. The socket reconnect + re-auth restores transport,
   * but federation membership stays whatever the host last decided (e.g.
   * confirmed-offline once it stopped hearing from this node). The consumer uses
   * this to re-drive a fresh join-request so the node re-enters the roster and
   * gets a catch-up, instead of relying on bare heartbeats the host now drops.
   */
  onReauth?: () => void
  /**
   * Fired once when this link has failed to establish for `attempts` consecutive
   * tries — the address is not merely flaky, it is wrong or unroutable from here.
   * Advice, not a stop: retrying continues, and the consumer decides whether to
   * route elsewhere. A leg that can never connect is not harmless — every frame
   * addressed to it queues, overflows, and is shed where no layer above can see.
   */
  onUnreachable?: (attempts: number) => void
}

/** Consecutive failed connects after which a link is reported as unreachable. */
const UNREACHABLE_AFTER_ATTEMPTS = 5

/** Minimum gap between shed-frame warnings per plane, so a dead link cannot flood the log. */
const DROP_LOG_INTERVAL_MS = 30_000

/**
 * How soon after a refusal a close by the far side still belongs to it. A relay
 * ends a refused member's session within its close grace (100 ms). A host that
 * keeps a refused session and drops it later is going away — most likely
 * restarting, after which it may admit us — so that close reconnects as usual.
 */
const REFUSED_CLOSE_WINDOW_MS = 10_000

/**
 * How often a refused session the far side keeps open is pinged. Nothing else
 * writes to it, and a connection that died without a FIN surfaces only on a
 * write. The first ping comes long after REFUSED_CLOSE_WINDOW_MS, so a close it
 * causes reconnects as usual.
 */
const REFUSED_PING_INTERVAL_MS = 30_000

/** What a link can report about itself, for the office-level health line. */
export interface WsLinkHealth {
  url: string
  connected: boolean
  /** Consecutive failed connect attempts; 0 once connected. */
  failedAttempts: number
  /**
   * Set while the far side has refused this node: `retryInMs` is 0 while the
   * refused session is still open, and counts down once a reconnect is parked.
   */
  refused: { retryInMs: number } | null
  /** Frames not sent since this client was created because the far side had refused this node. */
  withheld: number
  /** Frames shed by queue overflow since this client was created, by plane. */
  dropped: Record<FramePlane, number>
  /** Federation frames and bytes received since this client was created, by plane. */
  received: Record<FramePlane, { frames: number; bytes: number }>
  /** The same, by frame kind (`<plane>.<kind>` outside the control plane). */
  receivedByKind: Record<string, { frames: number; bytes: number }>
}

/**
 * Outbound WS client to a host office. Constructed open: it connects eagerly and
 * reconnects on drop until close() is called. Frames sent before auth complete
 * are queued and flushed on auth:success.
 */
export class WsFederationClient {
  private readonly wsUrl: string
  private socket: WebSocket | null = null
  private authed = false
  // True once any auth:success has happened in this client's lifetime. A later
  // auth:success while this is already set means the link came back from a drop,
  // which is what distinguishes a reconnect-reauth (fire onReauth) from the
  // initial auth (do not).
  private hasAuthedEver = false
  private gatewaySession = false

  /** The link rides a relay gateway (wire version announced at auth), not a LAN host socket. */
  get isGatewaySession(): boolean {
    return this.gatewaySession
  }

  /** A refusal stands: the session was marked refused, or the reconnect after it is parked. */
  get isRefused(): boolean {
    return this.refusal !== null || this.parkedUntil !== 0
  }
  private stopped = false
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  // Outbound frames held until the link is authed, segmented by plane so they
  // drain in priority and overflow is shed per-plane.
  // Frames waiting for the link, by plane (see PlaneQueue for the bounds).
  private readonly outbound = new PlaneQueue<{ frame: FederationMessage; to: NodeId | null }>()
  // Frames shed by overflow, and when each plane last reported it. Counted rather
  // than logged per frame: a link that cannot connect sheds one every couple of
  // seconds, and a per-frame line buries the fact that thousands are gone.
  private readonly dropped: Record<FramePlane, number> = { control: 0, stream: 0, feed: 0, artifact: 0 }
  private readonly lastDropLogAt: Record<FramePlane, number> = { control: 0, stream: 0, feed: 0, artifact: 0 }
  private unreachableReported = false
  // The current session was refused (see markRefused); cleared by the next connect.
  private refusal: { at: number; retryAfterMs: number } | null = null
  // When a reconnect parked after a refused session ended is due; 0 when not parked.
  private parkedUntil = 0
  private withheld = 0
  // Pings a refused session while the far side keeps it open (see watchRefusedSession).
  private refusedPing: ReturnType<typeof setInterval> | null = null
  private refusedPingUnanswered = false
  // Inbound volume, the number a joiner's cost is judged by (health line).
  private readonly received: Record<FramePlane, { frames: number; bytes: number }> = {
    control: { frames: 0, bytes: 0 },
    stream: { frames: 0, bytes: 0 },
    feed: { frames: 0, bytes: 0 },
    artifact: { frames: 0, bytes: 0 },
  }
  private readonly receivedByKind = new Map<string, { frames: number; bytes: number }>()

  constructor(private readonly deps: WsFederationClientDeps) {
    // Accept http(s) or ws(s); normalize to a ws(s) /ws endpoint.
    const base = deps.serverUrl.replace(/\/+$/, '').replace(/^http/, 'ws')
    this.wsUrl = base.endsWith('/ws') ? base : `${base}/ws`
    this.connect()
  }

  /**
   * Send a federation frame, queueing (bounded, per-plane) until the link is
   * authed. `to` is the intended target node, stamped on the envelope: a LAN
   * host and a hosted gateway room ignore it (member frames route to the
   * host), but a HOSTLESS gateway room uses it to deliver addressed election
   * traffic (votes, catch-up replies) to exactly one member instead of
   * fanning it out roomwide.
   */
  send(frame: FederationMessage, to?: NodeId | null): void {
    // After a refusal nothing is sent until the next connect: the far side drops
    // it, and a backlog flushed into the next session meets the same refusal —
    // or trips a relay's per-session frame limit before the join gets through.
    if (this.refusal || this.parkedUntil) {
      this.withheld += 1
      return
    }
    if (this.authed && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(envelope(frame, to ?? null))
      return
    }
    const plane = framePlane(frame)
    // Overflow sheds within the SAME plane only — a full artifact queue never
    // evicts a queued control frame.
    const dropped = this.outbound.push(plane, { frame, to: to ?? null }, () => JSON.stringify(frame).length)
    if (dropped > 0) {
      this.dropped[plane] += dropped
      this.reportDropped(plane)
    }
  }

  /**
   * Say that frames are being lost, at a bounded rate, and say WHY: a shed frame
   * on a link that never connected is a dead address, not congestion, and the two
   * call for opposite responses. The count is cumulative because the magnitude is
   * the signal — a handful is a hiccup, thousands is a channel eating traffic.
   */
  private reportDropped(plane: FramePlane): void {
    const now = Date.now()
    if (now - this.lastDropLogAt[plane] < DROP_LOG_INTERVAL_MS) return
    this.lastDropLogAt[plane] = now
    const why = this.authed
      ? 'link is authed but the queue is not draining'
      : `link has never carried a frame since its last connect (failed attempts=${this.reconnectAttempt})`
    console.warn(
      `${LOG_TAG} ${plane} queue full; shedding frames url=${this.wsUrl} ` +
        `droppedTotal=${this.dropped[plane]} — ${why}`
    )
  }

  /** Connection state and cumulative losses, for the office-level health line. */
  getHealth(): WsLinkHealth {
    return {
      url: this.wsUrl,
      connected: this.authed && this.socket?.readyState === WebSocket.OPEN,
      failedAttempts: this.authed ? 0 : this.reconnectAttempt,
      refused: this.parkedUntil
        ? { retryInMs: Math.max(0, this.parkedUntil - Date.now()) }
        : this.refusal ? { retryInMs: 0 } : null,
      withheld: this.withheld,
      dropped: { ...this.dropped },
      received: {
        control: { ...this.received.control },
        stream: { ...this.received.stream },
        feed: { ...this.received.feed },
        artifact: { ...this.received.artifact },
      },
      receivedByKind: Object.fromEntries([...this.receivedByKind].map(([kind, r]) => [kind, { ...r }])),
    }
  }

  /**
   * The far side refused this node on the current session — the consumer judges
   * what counts, e.g. a refused join. The session carries nothing more. If the
   * far side ends it right away (a relay closes a refused member at once), the
   * next connect waits `retryAfterMs` instead of the reconnect backoff; a session
   * it keeps open stays open and is pinged, so its later drop reconnects as usual
   * even when no FIN arrives.
   */
  markRefused(retryAfterMs: number): void {
    if (this.stopped) return
    this.refusal = { at: Date.now(), retryAfterMs }
    this.watchRefusedSession()
  }

  /**
   * Ask again now rather than when the refusal said: a parked reconnect is moved
   * to the next tick, and a refused session the far side kept open carries
   * frames again — returning true, since only then must the consumer re-send
   * what was refused (a reconnect re-authenticates and fires onReauth). Nothing
   * happens while no refusal stands; an attempt is already on its way then.
   */
  retryRefused(): boolean {
    if (this.stopped) return false
    if (this.parkedUntil) {
      this.scheduleConnect(0)
      return false
    }
    if (!this.refusal) return false
    this.refusal = null
    this.stopRefusedPing()
    return true
  }

  /**
   * The far side admitted this node on the current session after refusing it
   * there (a second join was in flight): the session carries frames again. What
   * was withheld meanwhile stays dropped. A parked client has no session to be
   * admitted on, so its park is left alone.
   */
  markAdmitted(): void {
    if (!this.refusal) return
    this.refusal = null
    this.stopRefusedPing()
  }

  /** Stop reconnecting and close the socket. Idempotent. */
  close(): void {
    this.stopped = true
    this.authed = false
    this.stopRefusedPing()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.socket) {
      // Closing a socket that is still handshaking makes `ws` emit 'error'
      // asynchronously. removeAllListeners drops the 'error' handler, and an
      // EventEmitter 'error' with no listener is promoted to an uncaught
      // exception the synchronous catch below can never see — keep a sink.
      this.socket.removeAllListeners()
      this.socket.on('error', () => {})
      try {
        this.socket.close()
      } catch {
        /* already closing */
      }
      this.socket = null
    }
    this.setState('closed')
    console.log(`${LOG_TAG} closed url=${this.wsUrl}`)
  }

  // ── Internals ──

  private setState(state: WsFederationClientState): void {
    this.deps.onStateChange?.(state)
  }

  private connect(): void {
    if (this.stopped) return
    this.authed = false
    this.refusal = null
    this.parkedUntil = 0
    this.stopRefusedPing()
    this.setState('connecting')
    console.log(`${LOG_TAG} connecting url=${this.wsUrl} attempt=${this.reconnectAttempt}`)

    const socket = new WebSocket(this.wsUrl)
    this.socket = socket

    socket.on('open', () => {
      console.log(`${LOG_TAG} socket open url=${this.wsUrl}`)
      // Leg 1 of the node handshake: request a federation session. The host
      // answers with auth:challenge; the signed proof rides the second auth.
      socket.send(
        JSON.stringify({
          type: 'auth',
          payload: {
            token: this.deps.credentialToken,
            federation: true,
            ...(this.deps.officeId ? { officeId: this.deps.officeId } : {}),
          },
        })
      )
    })

    socket.on('message', (data: WebSocket.RawData) => {
      this.handleMessage(data)
    })

    socket.on('pong', () => {
      this.refusedPingUnanswered = false
    })

    socket.on('close', (code: number, reason: Buffer) => {
      this.authed = false
      this.stopRefusedPing()
      this.setState('closed')
      const why = reason?.length ? reason.toString() : ''
      console.log(`${LOG_TAG} socket closed url=${this.wsUrl} code=${code}${why ? ` reason=${why}` : ''}`)
      if (this.stopped) return
      const refusal = this.refusal
      this.refusal = null
      if (refusal && Date.now() - refusal.at <= REFUSED_CLOSE_WINDOW_MS) {
        this.park(refusal.retryAfterMs)
        return
      }
      this.scheduleReconnect()
    })

    socket.on('error', (err: Error) => {
      console.warn(`${LOG_TAG} socket error url=${this.wsUrl} msg=${err.message}`)
      // 'close' follows and drives the reconnect; nothing else to do here.
    })
  }

  private handleMessage(data: WebSocket.RawData): void {
    let message: { type?: string; payload?: unknown; error?: string; from?: string }
    const text = data.toString()
    try {
      message = JSON.parse(text)
    } catch {
      console.warn(`${LOG_TAG} dropped non-JSON message url=${this.wsUrl}`)
      return
    }

    switch (message.type) {
      case 'auth:challenge': {
        // Leg 2: sign the host's one-shot nonce with the local identity key and
        // re-auth with the proof attached. Without a proof factory (or when it
        // cannot sign) the node handshake is impossible — close instead of
        // hammering the host with an unprovable session.
        const nonce = (message.payload as { nonce?: unknown } | undefined)?.nonce
        const proof =
          typeof nonce === 'string' ? this.deps.makeAuthProof?.(nonce) ?? null : null
        if (!proof) {
          console.warn(`${LOG_TAG} auth challenge received but no identity proof available url=${this.wsUrl}`)
          this.close()
          break
        }
        this.socket?.send(
          JSON.stringify({
            type: 'auth',
            payload: {
              token: this.deps.credentialToken,
              federation: true,
              proof,
              ...(this.deps.officeId ? { officeId: this.deps.officeId } : {}),
            },
          })
        )
        break
      }
      case 'auth:success': {
        const isReauth = this.hasAuthedEver
        if (!isReauth) this.gatewaySession = typeof (message.payload as { wirePv?: unknown } | undefined)?.wirePv === 'number'
        this.authed = true
        this.hasAuthedEver = true
        this.reconnectAttempt = 0
        // The address works again; a later outage must be able to announce itself.
        this.unreachableReported = false
        this.setState('open')
        console.log(`${LOG_TAG} authenticated url=${this.wsUrl}${isReauth ? ' (reconnect)' : ''}`)
        this.flushOutbound()
        // Re-drive the join AFTER flushing so the request rides the live socket,
        // not a stale queued frame.
        if (isReauth) {
          console.log(`${LOG_TAG} re-driving join after reconnect url=${this.wsUrl}`)
          this.deps.onReauth?.()
        }
        break
      }
      case 'auth:failed':
        // Auth failures are not transient; stop retrying so we don't hammer the
        // host with a credential it has already rejected.
        console.warn(`${LOG_TAG} auth failed url=${this.wsUrl} error=${message.error ?? 'unknown'}`)
        this.close()
        break
      case 'federation': {
        const frame = message.payload as FederationMessage
        const tally = this.received[framePlane(frame)]
        tally.frames += 1
        tally.bytes += text.length
        // A kind that rides a plane other than control is named with it, so a
        // transcript frame is told apart from the same kind on the ctrl feed.
        const plane = framePlane(frame)
        const kindKey = plane === 'control' ? frame.kind : `${plane}.${frame.kind}`
        let byKind = this.receivedByKind.get(kindKey)
        if (!byKind) this.receivedByKind.set(kindKey, (byKind = { frames: 0, bytes: 0 }))
        byKind.frames += 1
        byKind.bytes += text.length
        this.deps.onFrame(frame, this.gatewaySession ? message.from : undefined)
        break
      }
      case 'gw:host-lost':
        console.warn(`${LOG_TAG} gateway reports host lost url=${this.wsUrl}`)
        this.deps.onGatewayHostLost?.()
        break
      // 'event'/'pong'/others are not consumed by the federation joiner leg.
    }
  }

  private flushOutbound(): void {
    if (!this.authed || this.socket?.readyState !== WebSocket.OPEN) return
    // Drain in strict plane priority so coordination goes out ahead of any
    // backlog of stream/feed/artifact frames buffered during the reconnect.
    const socket = this.socket
    this.outbound.drain(({ frame, to }) => socket.send(envelope(frame, to)))
  }

  /**
   * A refused session the far side keeps open carries no frames, so a connection
   * that died silently would hold the refusal for good. Each ping writes to it (a
   * peer that forgot the connection answers with a reset), and a ping still
   * unanswered at the next one ends it; either close reconnects as usual.
   * Restarted by every refusal, so the first ping is a full interval away.
   */
  private watchRefusedSession(): void {
    this.stopRefusedPing()
    this.refusedPingUnanswered = false
    this.refusedPing = setInterval(() => {
      const socket = this.socket
      // `ws` throws on a ping before the socket opens.
      if (!socket || socket.readyState !== WebSocket.OPEN) return
      if (this.refusedPingUnanswered) {
        console.warn(
          `${LOG_TAG} refused session did not answer a ping within ${REFUSED_PING_INTERVAL_MS}ms; ` +
            `ending it to reconnect url=${this.wsUrl}`
        )
        this.stopRefusedPing()
        socket.terminate()
        return
      }
      this.refusedPingUnanswered = true
      socket.ping()
    }, REFUSED_PING_INTERVAL_MS)
    if (typeof this.refusedPing.unref === 'function') this.refusedPing.unref()
  }

  private stopRefusedPing(): void {
    if (!this.refusedPing) return
    clearInterval(this.refusedPing)
    this.refusedPing = null
  }

  /** The far side ended a session it had just refused: stay away for `ms`, then connect once. */
  private park(ms: number): void {
    this.parkedUntil = Date.now() + ms
    console.log(`${LOG_TAG} refused session ended; next connect in ${ms}ms url=${this.wsUrl}`)
    this.scheduleConnect(ms)
  }

  private scheduleConnect(ms: number): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, ms)
    if (typeof this.reconnectTimer.unref === 'function') this.reconnectTimer.unref()
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    this.reconnectAttempt += 1
    const delay = Math.min(
      BACKOFF_BASE_MS * 2 ** (this.reconnectAttempt - 1),
      BACKOFF_MAX_MS
    )
    console.log(`${LOG_TAG} reconnecting in ${delay}ms url=${this.wsUrl} attempt=${this.reconnectAttempt}`)
    // Announced once, and only after enough tries to rule out a transient drop.
    // Retrying continues regardless: the address may come back, and the consumer
    // may have nowhere better to send. What must not continue is the SILENCE.
    if (!this.unreachableReported && this.reconnectAttempt >= UNREACHABLE_AFTER_ATTEMPTS) {
      this.unreachableReported = true
      console.warn(
        `${LOG_TAG} unreachable after ${this.reconnectAttempt} attempts url=${this.wsUrl}; ` +
          `anything addressed here is queueing and will be shed`
      )
      this.deps.onUnreachable?.(this.reconnectAttempt)
    }
    this.scheduleConnect(delay)
  }
}
