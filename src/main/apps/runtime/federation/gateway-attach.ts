/**
 * apps/runtime/federation -- Host-side outbound gateway attachment
 *
 * When an office is relayed through a federation gateway, the HOST opens one
 * outbound WebSocket per hosted office to the gateway, authenticates with the
 * same two-leg device-key handshake as any federation session, then claims the
 * room with `gw:host-attach { officeId }`. After `gw:attached` the host sends
 * ADDRESSED frames — `{ type:'federation', to, payload }` where `to` is a
 * nodeId (unicast) or null (broadcast to admitted room members) — and receives
 * plain `{ type:'federation', payload }` frames the gateway relays from
 * members (the gateway has already asserted the sender's session identity).
 *
 * This is deliberately a separate client from WsFederationClient: the joiner
 * client is un-addressed (member → gateway frames always route to host) and
 * carries join semantics via the coordinator, while this session speaks the
 * gw:* control vocabulary and addressed sends. Sharing a socket class would
 * force `to` and attach state into the joiner path for no benefit.
 *
 * Uses the `ws` npm library directly (library dependency, not the http/*
 * transport tier). Identity/signing is injected — this module never imports
 * the identity module (dependency direction).
 */

import WebSocket from 'ws'

import { framePlane, type FederationMessage, type FramePlane, type NodeId } from './types'
import { GATEWAY_WIRE_PV } from './protocol-m2'

const LOG_TAG = '[GwAttach]'

const BACKOFF_BASE_MS = 1000
const BACKOFF_MAX_MS = 30_000

/** Directory entry TTL is 90s (§9.3); refresh comfortably inside it. */
const ANNOUNCE_INTERVAL_MS = 60_000

/** Same per-plane bounded outbound queues as the joiner client (§5.3). */
const PLANE_QUEUE_CAP: Record<FramePlane, number> = {
  control: 1024,
  stream: 256,
  artifact: 32,
}
const PLANE_DRAIN_ORDER: readonly FramePlane[] = ['control', 'stream', 'artifact']

export type GatewayAttachState = 'connecting' | 'open' | 'attached' | 'closed'

/**
 * Signature payload for `gw:announce` (§9.3). Exact byte layout is part of the
 * wire contract with the gateway — the gateway verifies with the session's
 * proven public key. Exported so tests can assert byte-exactness.
 */
export function buildAnnounceSigPayload(
  officeId: string,
  identityId: string,
  ts: number,
  endpoints: readonly string[]
): string {
  return `halo-gw-announce\n${officeId}\n${identityId}\n${ts}\n${endpoints.join('\n')}`
}

export interface GatewayAttachDeps {
  /** Gateway base URL, e.g. https://gw.example.com or ws://host:8443. */
  gatewayUrl: string
  /** The office this attachment hosts. One socket serves exactly one office. */
  officeId: string
  /**
   * Build the signed device-key proof for the gateway's auth challenge. The
   * gateway admits on this proof alone (it cannot verify office tokens), so a
   * host session without a proof factory cannot attach.
   */
  makeAuthProof: (nonce: string) => Record<string, unknown> | null
  /**
   * Office credential token carried on auth for envelope symmetry with §3.2.
   * The gateway treats it as opaque; the host has no invite of its own, so
   * this defaults to ''.
   */
  credentialToken?: string
  /**
   * Delivered every inbound relayed federation frame after attach. `from` is the
   * gateway-stamped, already-proven origin identity (§9.2) — authoritative for
   * frames whose payload carries no fromNode (presence-update/stream-frames/
   * turn-complete); absent on host→member frames that never reach a host.
   */
  onFrame: (frame: FederationMessage, from?: string) => void
  /** Lifecycle for logging/diagnostics; 'attached' means the room is claimed. */
  onStateChange?: (state: GatewayAttachState) => void
  /**
   * Fired on `gw:error`. Errors arriving before attach also drive an internal
   * reconnect (the room may free up, e.g. a stale HOST_CONFLICT).
   */
  onGatewayError?: (code: string, detail?: string) => void
  // ── Announce (§9.3, all-or-nothing: omit any of these to disable) ──
  /** Ed25519 device-key signature over the UTF-8 payload, base64. Injected. */
  signAnnounce?: (payload: string) => string
  /** The local node's identity id (must match the session-proven identity). */
  getIdentityId?: () => string
  /** Currently advertised direct endpoints; empty list skips the announce. */
  getEndpoints?: () => string[]
  /** Optional human label for the directory. */
  getDisplayName?: () => string | undefined
  /**
   * The office's current authority tenure, stamped on gw:host-attach (v2-gw
   * term lock): a freshly-elected authority takes the room over immediately,
   * a resurrected stale host is refused (STALE_TERM). Absent → term-less v1
   * attach (retention-window takeover semantics).
   */
  getTerm?: () => number
  /** Test seam; production uses the 60s default. */
  announceIntervalMs?: number
}

/**
 * Outbound host attachment to a federation gateway. Constructed open: it
 * connects eagerly and reconnects (re-auth + re-attach) on drop until close()
 * is called. Frames sent before the room is attached are queued per-plane.
 */
export class GatewayAttachClient {
  private readonly wsUrl: string
  private socket: WebSocket | null = null
  private attachedFlag = false
  private stopped = false
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private announceTimer: ReturnType<typeof setInterval> | null = null
  private readonly outbound: Record<FramePlane, Array<{ to: NodeId | null; frame: FederationMessage }>> = {
    control: [],
    stream: [],
    artifact: [],
  }

  constructor(private readonly deps: GatewayAttachDeps) {
    const base = deps.gatewayUrl.replace(/\/+$/, '').replace(/^http/, 'ws')
    this.wsUrl = base.endsWith('/ws') ? base : `${base}/ws`
    this.connect()
  }

  /** True once the gateway has acknowledged this session as the room's host. */
  isAttached(): boolean {
    return this.attachedFlag && this.socket?.readyState === WebSocket.OPEN
  }

  /**
   * Send an addressed federation frame through the gateway: `to` is a nodeId
   * for unicast, null for a broadcast to admitted members. Queued (bounded,
   * per-plane) until the room is attached.
   */
  send(to: NodeId | null, frame: FederationMessage): void {
    if (this.isAttached()) {
      this.socket!.send(JSON.stringify({ type: 'federation', to, payload: frame }))
      return
    }
    const plane = framePlane(frame)
    const queue = this.outbound[plane]
    if (queue.length >= PLANE_QUEUE_CAP[plane]) {
      queue.shift()
      console.warn(`${LOG_TAG} ${plane} queue full; dropped oldest ${plane} frame url=${this.wsUrl}`)
    }
    queue.push({ to, frame })
  }

  /** Ask the gateway to drop a member's session (kick/leave transport cleanup). */
  evict(nodeId: NodeId): void {
    if (!this.isAttached()) return
    this.socket!.send(JSON.stringify({ type: 'gw:evict', payload: { nodeId } }))
  }

  /** Stop reconnecting and close the socket. Idempotent. */
  close(): void {
    this.stopped = true
    this.attachedFlag = false
    this.stopAnnounce()
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
    console.log(`${LOG_TAG} closed office=${this.deps.officeId} url=${this.wsUrl}`)
  }

  // ── Internals ──

  private setState(state: GatewayAttachState): void {
    this.deps.onStateChange?.(state)
  }

  private connect(): void {
    if (this.stopped) return
    this.attachedFlag = false
    this.setState('connecting')
    console.log(
      `${LOG_TAG} connecting office=${this.deps.officeId} url=${this.wsUrl} attempt=${this.reconnectAttempt}`
    )

    const socket = new WebSocket(this.wsUrl)
    this.socket = socket

    socket.on('open', () => {
      socket.send(
        JSON.stringify({
          type: 'auth',
          payload: {
            token: this.deps.credentialToken ?? '',
            federation: true,
            officeId: this.deps.officeId,
            wirePv: GATEWAY_WIRE_PV,
          },
        })
      )
    })

    socket.on('message', (data: WebSocket.RawData) => {
      this.handleMessage(data)
    })

    socket.on('close', (code: number, reason: Buffer) => {
      this.attachedFlag = false
      this.stopAnnounce()
      this.setState('closed')
      const why = reason?.length ? reason.toString() : ''
      console.log(`${LOG_TAG} socket closed url=${this.wsUrl} code=${code}${why ? ` reason=${why}` : ''}`)
      if (this.stopped) return
      this.scheduleReconnect()
    })

    socket.on('error', (err: Error) => {
      console.warn(`${LOG_TAG} socket error url=${this.wsUrl} msg=${err.message}`)
      // 'close' follows and drives the reconnect.
    })
  }

  private handleMessage(data: WebSocket.RawData): void {
    let message: { type?: string; payload?: unknown; error?: string; from?: string }
    try {
      message = JSON.parse(data.toString())
    } catch {
      console.warn(`${LOG_TAG} dropped non-JSON message url=${this.wsUrl}`)
      return
    }

    switch (message.type) {
      case 'auth:challenge': {
        const nonce = (message.payload as { nonce?: unknown } | undefined)?.nonce
        const proof = typeof nonce === 'string' ? this.deps.makeAuthProof(nonce) : null
        if (!proof) {
          console.warn(`${LOG_TAG} no identity proof available; cannot attach url=${this.wsUrl}`)
          this.close()
          break
        }
        this.socket?.send(
          JSON.stringify({
            type: 'auth',
            payload: {
              token: this.deps.credentialToken ?? '',
              federation: true,
              officeId: this.deps.officeId,
              proof,
              wirePv: GATEWAY_WIRE_PV,
            },
          })
        )
        break
      }
      case 'auth:success': {
        // v2-gw negotiation: a v1 gateway echoes no wirePv — it still relays,
        // but the term lock + hostless election relay are unavailable there
        // (takeover falls back to the retention window). Logged explicitly so
        // a degraded deployment is visible, never silent.
        const gwPv = (message.payload as { wirePv?: unknown } | undefined)?.wirePv
        if (typeof gwPv !== 'number' || gwPv < GATEWAY_WIRE_PV) {
          console.warn(
            `${LOG_TAG} gateway wire v${typeof gwPv === 'number' ? gwPv : 1} < v${GATEWAY_WIRE_PV}: term lock + hostless election relay unavailable url=${this.wsUrl}`
          )
        }
        console.log(`${LOG_TAG} authenticated url=${this.wsUrl}; attaching office=${this.deps.officeId}`)
        this.setState('open')
        const term = this.deps.getTerm?.() ?? 0
        this.socket?.send(
          JSON.stringify({
            type: 'gw:host-attach',
            payload: { officeId: this.deps.officeId, ...(term > 0 ? { term } : {}) },
          })
        )
        break
      }
      case 'auth:failed':
        // Not transient at the auth layer; stop retrying.
        console.warn(`${LOG_TAG} auth failed url=${this.wsUrl} error=${message.error ?? 'unknown'}`)
        this.close()
        break
      case 'gw:attached':
        this.attachedFlag = true
        this.reconnectAttempt = 0
        this.setState('attached')
        console.log(`${LOG_TAG} attached as host office=${this.deps.officeId} url=${this.wsUrl}`)
        this.flushOutbound()
        this.startAnnounce()
        break
      case 'gw:error': {
        const { code, detail } = (message.payload as { code?: string; detail?: string } | undefined) ?? {}
        console.warn(
          `${LOG_TAG} gateway error office=${this.deps.officeId} code=${code ?? 'unknown'}${detail ? ` detail=${detail}` : ''}`
        )
        this.deps.onGatewayError?.(code ?? 'unknown', detail)
        if (!this.attachedFlag) {
          // Attach was refused (e.g. HOST_CONFLICT with a live holder). Retry
          // with backoff — the room frees up when the stale host drops.
          try {
            this.socket?.close()
          } catch {
            /* closing */
          }
        }
        break
      }
      case 'federation':
        this.deps.onFrame(message.payload as FederationMessage, message.from)
        break
      // gw:host-lost is a member-facing notice; a host session never receives it.
    }
  }

  private flushOutbound(): void {
    if (!this.isAttached()) return
    for (const plane of PLANE_DRAIN_ORDER) {
      const queue = this.outbound[plane]
      const pending = queue.splice(0, queue.length)
      for (const { to, frame } of pending) {
        this.socket!.send(JSON.stringify({ type: 'federation', to, payload: frame }))
      }
    }
  }

  private startAnnounce(): void {
    this.stopAnnounce()
    const { signAnnounce, getIdentityId, getEndpoints } = this.deps
    if (!signAnnounce || !getIdentityId || !getEndpoints) return
    const sendAnnounce = (): void => {
      if (!this.isAttached()) return
      const endpoints = getEndpoints()
      if (!endpoints.length) return
      const ts = Date.now()
      const sig = signAnnounce(buildAnnounceSigPayload(this.deps.officeId, getIdentityId(), ts, endpoints))
      const displayName = this.deps.getDisplayName?.()
      this.socket!.send(
        JSON.stringify({
          type: 'gw:announce',
          payload: { endpoints, ...(displayName ? { displayName } : {}), ts, sig },
        })
      )
    }
    sendAnnounce()
    this.announceTimer = setInterval(sendAnnounce, this.deps.announceIntervalMs ?? ANNOUNCE_INTERVAL_MS)
    if (typeof this.announceTimer.unref === 'function') this.announceTimer.unref()
  }

  private stopAnnounce(): void {
    if (this.announceTimer) {
      clearInterval(this.announceTimer)
      this.announceTimer = null
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    this.reconnectAttempt += 1
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** (this.reconnectAttempt - 1), BACKOFF_MAX_MS)
    console.log(`${LOG_TAG} reconnecting in ${delay}ms url=${this.wsUrl} attempt=${this.reconnectAttempt}`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
    if (typeof this.reconnectTimer.unref === 'function') this.reconnectTimer.unref()
  }
}
