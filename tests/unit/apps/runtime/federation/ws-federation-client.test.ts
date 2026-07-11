/**
 * Focused unit test for WsFederationClient's reconnect-reauth trigger (F-4).
 *
 * A minimal `ws` server accepts the auth handshake and replies auth:success.
 * The test asserts onReauth fires ONLY on a reconnect (a later auth:success
 * after a drop), never on the initial auth. This is the signal the federation
 * manager uses to re-drive a fresh join-request so a node that the host already
 * confirmed offline actually rejoins (rather than relying on bare heartbeats the
 * host now drops).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import http from 'http'
import { WebSocketServer, type WebSocket as WsServerSocket } from 'ws'

import { WsFederationClient } from '../../../../../src/main/apps/runtime/federation/ws-federation-client'

/** Poll a predicate until true or the budget elapses (real async, no fake timers). */
async function waitFor(predicate: () => boolean, budgetMs = 4000): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 15))
  }
}

describe('WsFederationClient — reconnect rejoin trigger (F-4)', () => {
  let server: http.Server
  let wss: WebSocketServer
  let port: number
  let serverSockets: WsServerSocket[]
  let client: WsFederationClient | null

  beforeEach(async () => {
    serverSockets = []
    client = null
    server = http.createServer()
    wss = new WebSocketServer({ server, path: '/ws' })
    wss.on('connection', (socket) => {
      serverSockets.push(socket)
      socket.on('message', (data) => {
        let msg: { type?: string }
        try {
          msg = JSON.parse(data.toString())
        } catch {
          return
        }
        // Accept any token: this test exercises the reconnect trigger, not auth.
        if (msg.type === 'auth') {
          socket.send(JSON.stringify({ type: 'auth:success' }))
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as { port: number }).port
  })

  afterEach(async () => {
    client?.close()
    wss.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('does not fire onReauth on the initial auth', async () => {
    let reauthCount = 0
    let opened = false
    client = new WsFederationClient({
      serverUrl: `http://127.0.0.1:${port}`,
      credentialToken: 'tok',
      onFrame: () => {},
      onStateChange: (s) => {
        if (s === 'open') opened = true
      },
      onReauth: () => {
        reauthCount += 1
      },
    })

    await waitFor(() => opened)
    expect(opened).toBe(true)
    // Give any (erroneous) reauth callback a chance to fire.
    await new Promise((r) => setTimeout(r, 50))
    expect(reauthCount).toBe(0)
  })

  it('fires onReauth after a drop + reconnect re-auth', async () => {
    let openCount = 0
    let reauthCount = 0
    client = new WsFederationClient({
      serverUrl: `http://127.0.0.1:${port}`,
      credentialToken: 'tok',
      onFrame: () => {},
      onStateChange: (s) => {
        if (s === 'open') openCount += 1
      },
      onReauth: () => {
        reauthCount += 1
      },
    })

    await waitFor(() => openCount === 1)
    expect(reauthCount).toBe(0)

    // Force a server-side drop; the client reconnects on backoff and re-auths.
    for (const s of serverSockets) s.terminate()

    await waitFor(() => openCount >= 2, 6000)
    expect(openCount).toBeGreaterThanOrEqual(2)
    await waitFor(() => reauthCount >= 1, 2000)
    expect(reauthCount).toBe(1)
  })
})
