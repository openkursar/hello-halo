/**
 * Shared test helper: a minimal in-process federation gateway speaking the
 * v1-gw wire vocabulary a host attachment exercises — the two-leg auth
 * handshake, gw:host-attach/gw:attached, addressed host frames, gw:announce and
 * gw:evict capture, and relaying member frames to the host session. Just enough
 * gateway to prove the TS client side; the real gateway is the Go binary.
 */

import http from 'http'
import { randomBytes } from 'crypto'
import { WebSocketServer, WebSocket } from 'ws'

export interface CapturedHostFrame {
  to: string | null
  payload: Record<string, unknown>
}

export interface CapturedAnnounce {
  endpoints: string[]
  displayName?: string
  ts: number
  sig: string
}

export interface FakeGateway {
  url: string
  /** Addressed federation frames received from the host session, in order. */
  hostFrames: CapturedHostFrame[]
  /** gw:announce payloads received, in order. */
  announces: CapturedAnnounce[]
  /** gw:evict nodeIds received, in order. */
  evictions: string[]
  /** Device-key proofs presented on auth leg 2, in order of session. */
  authProofs: Array<Record<string, unknown>>
  /** Full auth payloads received (both legs), in order — carries token/officeId. */
  authPayloads: Array<Record<string, unknown>>
  /** How many times a session completed gw:host-attach. */
  attachCount: () => number
  /** Push a message object to the current host session (JSON-encoded). */
  sendToHost: (message: Record<string, unknown>) => void
  /**
   * Relay a member federation frame to the host: { type:'federation', from?, payload }.
   * `from` mirrors the real gateway's stamped sender identity (§9.2).
   */
  relayToHost: (frame: Record<string, unknown>, from?: string) => void
  /** Server-side drop of the host socket (drives client reconnect). */
  dropHost: () => void
  close: () => Promise<void>
}

export interface FakeGatewayOptions {
  /** Refuse this many gw:host-attach attempts with HOST_CONFLICT before accepting (§9.2 pinning). */
  rejectAttaches?: number
}

export async function startFakeGateway(options: FakeGatewayOptions = {}): Promise<FakeGateway> {
  const server = http.createServer()
  const wss = new WebSocketServer({ server, path: '/ws' })

  const hostFrames: CapturedHostFrame[] = []
  const announces: CapturedAnnounce[] = []
  const evictions: string[] = []
  const authProofs: Array<Record<string, unknown>> = []
  const authPayloads: Array<Record<string, unknown>> = []
  let attaches = 0
  let attachRejectsLeft = options.rejectAttaches ?? 0
  let hostSocket: WebSocket | null = null

  wss.on('connection', (socket) => {
    let authed = false
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as {
        type: string
        to?: string | null
        payload?: Record<string, unknown>
      }
      switch (message.type) {
        case 'auth': {
          if (message.payload) authPayloads.push(message.payload)
          const proof = message.payload?.proof as Record<string, unknown> | undefined
          if (!proof) {
            socket.send(
              JSON.stringify({
                type: 'auth:challenge',
                payload: { nonce: randomBytes(32).toString('base64') },
              })
            )
            return
          }
          authProofs.push(proof)
          authed = true
          socket.send(JSON.stringify({ type: 'auth:success' }))
          return
        }
        case 'gw:host-attach': {
          if (!authed) return
          if (attachRejectsLeft > 0) {
            attachRejectsLeft -= 1
            socket.send(
              JSON.stringify({ type: 'gw:error', payload: { code: 'HOST_CONFLICT' } })
            )
            return
          }
          attaches += 1
          hostSocket = socket
          socket.send(JSON.stringify({ type: 'gw:attached', payload: { role: 'host' } }))
          return
        }
        case 'federation':
          hostFrames.push({
            to: (message.to ?? null) as string | null,
            payload: message.payload as Record<string, unknown>,
          })
          return
        case 'gw:announce':
          announces.push(message.payload as unknown as CapturedAnnounce)
          return
        case 'gw:evict':
          evictions.push((message.payload as { nodeId: string }).nodeId)
          return
      }
    })
    socket.on('close', () => {
      if (hostSocket === socket) hostSocket = null
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port

  return {
    url: `http://127.0.0.1:${port}`,
    hostFrames,
    announces,
    evictions,
    authProofs,
    authPayloads,
    attachCount: () => attaches,
    sendToHost: (message) => hostSocket?.send(JSON.stringify(message)),
    relayToHost: (frame, from) =>
      hostSocket?.send(JSON.stringify({ type: 'federation', ...(from ? { from } : {}), payload: frame })),
    dropHost: () => hostSocket?.terminate(),
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate()
        wss.close(() => server.close(() => resolve()))
      }),
  }
}

/** Poll a predicate until true or the budget elapses (real async, no fake timers). */
export async function waitFor(predicate: () => boolean, budgetMs = 4000): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 25))
  }
}
