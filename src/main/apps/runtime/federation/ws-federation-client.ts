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
 * transport. Timers are unref'd so a pending reconnect never keeps the process
 * (or a test runner) alive.
 */

import WebSocket from 'ws'

import { framePlane, type FederationMessage, type FramePlane } from './types'

const LOG_TAG = '[FedClient]'

const BACKOFF_BASE_MS = 1000
const BACKOFF_MAX_MS = 30_000

/**
 * Per-plane bounded outbound queues. When the link is congested the planes
 * drain in strict priority (control → stream → artifact), and each plane's cap is
 * enforced independently so a flood of large artifact frames can neither
 * head-of-line-block nor evict coordination traffic. Control is sized so it never
 * realistically overflows; if it ever did it sheds its OWN oldest, never trading
 * a control guarantee for a lower plane. Artifact is the smallest because its
 * frames are the largest and the most droppable (a viewer simply re-fetches).
 */
const PLANE_QUEUE_CAP: Record<FramePlane, number> = {
  control: 1024,
  stream: 256,
  artifact: 32,
}
/** Drain order: highest priority first. */
const PLANE_DRAIN_ORDER: readonly FramePlane[] = ['control', 'stream', 'artifact']

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
  onFrame: (frame: FederationMessage) => void
  /** Connection lifecycle, surfaced for the manager's logging/diagnostics. */
  onStateChange?: (state: WsFederationClientState) => void
  /**
   * Fired when the link re-authenticates AFTER a prior drop — i.e. a reconnect,
   * never the initial auth. The socket reconnect + re-auth restores transport,
   * but federation membership stays whatever the host last decided (e.g.
   * confirmed-offline once it stopped hearing from this node). The consumer uses
   * this to re-drive a fresh join-request so the node re-enters the roster and
   * gets a catch-up, instead of relying on bare heartbeats the host now drops.
   */
  onReauth?: () => void
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
  private stopped = false
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  // Outbound frames held until the link is authed, segmented by plane so they
  // drain in priority and overflow is shed per-plane.
  private readonly outbound: Record<FramePlane, FederationMessage[]> = {
    control: [],
    stream: [],
    artifact: [],
  }

  constructor(private readonly deps: WsFederationClientDeps) {
    // Accept http(s) or ws(s); normalize to a ws(s) /ws endpoint.
    const base = deps.serverUrl.replace(/\/+$/, '').replace(/^http/, 'ws')
    this.wsUrl = base.endsWith('/ws') ? base : `${base}/ws`
    this.connect()
  }

  /** Send a federation frame, queueing (bounded, per-plane) until the link is authed. */
  send(frame: FederationMessage): void {
    if (this.authed && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'federation', payload: frame }))
      return
    }
    const plane = framePlane(frame)
    const queue = this.outbound[plane]
    if (queue.length >= PLANE_QUEUE_CAP[plane]) {
      // Overflow sheds within the SAME plane only — a full artifact queue never
      // evicts a queued control frame. Drop oldest of this plane.
      queue.shift()
      console.warn(`${LOG_TAG} ${plane} queue full; dropped oldest ${plane} frame url=${this.wsUrl}`)
    }
    queue.push(frame)
  }

  /** Stop reconnecting and close the socket. Idempotent. */
  close(): void {
    this.stopped = true
    this.authed = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.socket) {
      try {
        this.socket.removeAllListeners()
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

    socket.on('close', (code: number, reason: Buffer) => {
      this.authed = false
      this.setState('closed')
      const why = reason?.length ? reason.toString() : ''
      console.log(`${LOG_TAG} socket closed url=${this.wsUrl} code=${code}${why ? ` reason=${why}` : ''}`)
      if (this.stopped) return
      this.scheduleReconnect()
    })

    socket.on('error', (err: Error) => {
      console.warn(`${LOG_TAG} socket error url=${this.wsUrl} msg=${err.message}`)
      // 'close' follows and drives the reconnect; nothing else to do here.
    })
  }

  private handleMessage(data: WebSocket.RawData): void {
    let message: { type?: string; payload?: unknown; error?: string }
    try {
      message = JSON.parse(data.toString())
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
        this.authed = true
        this.hasAuthedEver = true
        this.reconnectAttempt = 0
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
      case 'federation':
        this.deps.onFrame(message.payload as FederationMessage)
        break
      // 'event'/'pong'/others are not consumed by the federation joiner leg.
    }
  }

  private flushOutbound(): void {
    if (!this.authed || this.socket?.readyState !== WebSocket.OPEN) return
    // Drain in strict plane priority so coordination goes out ahead of any
    // backlog of stream/artifact frames buffered during the reconnect.
    for (const plane of PLANE_DRAIN_ORDER) {
      const queue = this.outbound[plane]
      const pending = queue.splice(0, queue.length)
      for (const frame of pending) {
        this.socket.send(JSON.stringify({ type: 'federation', payload: frame }))
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    this.reconnectAttempt += 1
    const delay = Math.min(
      BACKOFF_BASE_MS * 2 ** (this.reconnectAttempt - 1),
      BACKOFF_MAX_MS
    )
    console.log(`${LOG_TAG} reconnecting in ${delay}ms url=${this.wsUrl} attempt=${this.reconnectAttempt}`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
    if (typeof this.reconnectTimer.unref === 'function') this.reconnectTimer.unref()
  }
}
