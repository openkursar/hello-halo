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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import http from 'http'
import net from 'net'
import { WebSocketServer, WebSocket, type WebSocket as WsServerSocket } from 'ws'

import { WsFederationClient } from '../../../../../src/main/apps/runtime/federation/ws-federation-client'
import type { FederationMessage } from '../../../../../src/main/apps/runtime/federation/types'

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

/**
 * A session the consumer marks refused (a join refused for another protocol
 * version). A relay ends such a session at once, and the next connect must wait
 * the consumer's delay rather than the 1 s backoff — that pairing was a reconnect
 * loop. A host that keeps the refused session open must not be cut off: its later
 * drop (a restart, likely onto a version that admits us) reconnects as usual.
 */
describe('WsFederationClient — refused sessions', () => {
  let server: http.Server
  let wss: WebSocketServer
  let port: number
  let serverSockets: WsServerSocket[]
  let framesBySocket: FederationMessage[][]
  let client: WsFederationClient | null

  const heartbeat = (): FederationMessage => ({ kind: 'heartbeat', officeId: 'o', fromNode: 'n', ts: Date.now() })

  beforeEach(async () => {
    serverSockets = []
    framesBySocket = []
    client = null
    server = http.createServer()
    wss = new WebSocketServer({ server, path: '/ws' })
    wss.on('connection', (socket) => {
      serverSockets.push(socket)
      const frames: FederationMessage[] = []
      framesBySocket.push(frames)
      socket.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as { type?: string; payload?: FederationMessage }
        if (msg.type === 'auth') socket.send(JSON.stringify({ type: 'auth:success', payload: { wirePv: 2 } }))
        if (msg.type === 'federation' && msg.payload) frames.push(msg.payload)
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as { port: number }).port
  })

  afterEach(async () => {
    vi.useRealTimers()
    client?.close()
    wss.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  async function openClient(): Promise<WsFederationClient> {
    let opened = false
    const created = new WsFederationClient({
      serverUrl: `http://127.0.0.1:${port}`,
      credentialToken: 'tok',
      onFrame: () => {},
      onStateChange: (s) => {
        if (s === 'open') opened = true
      },
    })
    client = created
    await waitFor(() => opened)
    expect(opened).toBe(true)
    return created
  }

  it('waits the given delay, not the reconnect backoff, after the far side ends a refused session', async () => {
    const c = await openClient()
    c.markRefused(2000)
    serverSockets[0].terminate()

    // The backoff would have reconnected after 1 s.
    await new Promise((r) => setTimeout(r, 1400))
    expect(serverSockets).toHaveLength(1)
    expect(c.getHealth().refused?.retryInMs).toBeGreaterThan(0)

    await waitFor(() => serverSockets.length === 2, 2000)
    expect(serverSockets).toHaveLength(2)
    await waitFor(() => c.getHealth().connected)
    expect(c.getHealth().refused).toBeNull()
  })

  it('sends nothing after a refusal and flushes nothing of it into the next session', async () => {
    const c = await openClient()
    c.markRefused(200)
    c.send(heartbeat())
    c.send(heartbeat())
    serverSockets[0].terminate()
    c.send(heartbeat())

    await waitFor(() => serverSockets.length === 2 && c.getHealth().connected)
    await new Promise((r) => setTimeout(r, 100))
    expect(framesBySocket[0]).toEqual([])
    expect(framesBySocket[1]).toEqual([])
    expect(c.getHealth().withheld).toBe(3)

    // A fresh session carries traffic again.
    c.send(heartbeat())
    await waitFor(() => framesBySocket[1].length === 1)
    expect(framesBySocket[1]).toHaveLength(1)
  })

  it('keeps a refused session the far side holds open, and reconnects as usual when it drops later', async () => {
    const c = await openClient()
    c.markRefused(60_000)
    await new Promise((r) => setTimeout(r, 150))
    expect(serverSockets[0].readyState).toBe(WebSocket.OPEN)
    expect(c.getHealth()).toMatchObject({ connected: true, refused: { retryInMs: 0 } })

    // The host goes away long after refusing (a restart): not part of the refusal.
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true })
    vi.setSystemTime(Date.now() + 60_000)
    serverSockets[0].terminate()

    await waitFor(() => serverSockets.length === 2, 2500)
    expect(serverSockets).toHaveLength(2)
  })

  it('asked to retry, connects at once instead of when the parked delay runs out', async () => {
    const c = await openClient()
    c.markRefused(60_000)
    serverSockets[0].terminate()
    await waitFor(() => c.isRefused && !c.getHealth().connected)

    expect(c.retryRefused()).toBe(false)
    await waitFor(() => serverSockets.length === 2 && c.getHealth().connected)
    expect(c.isRefused).toBe(false)
  })

  it('asked to retry on a refused session still open, lets it carry frames again', async () => {
    const c = await openClient()
    c.markRefused(60_000)
    c.send(heartbeat())

    expect(c.retryRefused()).toBe(true)
    c.send(heartbeat())
    await waitFor(() => framesBySocket[0].length === 1)

    expect(framesBySocket[0]).toHaveLength(1)
    expect(serverSockets).toHaveLength(1)
  })

  it('asked to retry with no refusal standing, does nothing', async () => {
    const c = await openClient()

    expect(c.retryRefused()).toBe(false)
    await new Promise((r) => setTimeout(r, 150))
    expect(serverSockets).toHaveLength(1)
  })
})

/**
 * A refused session a LAN host keeps open carries nothing, so a connection that
 * died without a FIN reaching this machine (the host lost power, or dropped the
 * connection while this machine slept) would never surface, and the refusal would
 * outlive the host's update. Only the ping interval and the clock are fake here;
 * sockets and the reconnect timer are real.
 */
describe('WsFederationClient — a refused session the far side keeps open', () => {
  const spyOnPing = () => vi.spyOn(WebSocket.prototype, 'ping')
  let server: http.Server
  let wss: WebSocketServer
  let port: number
  let serverSockets: WsServerSocket[]
  let framesReceived: FederationMessage[]
  let pingsReceived: number
  let answerPings: boolean
  let client: WsFederationClient | null
  let ping: ReturnType<typeof spyOnPing>

  const PING_INTERVAL_MS = 30_000

  beforeEach(async () => {
    serverSockets = []
    framesReceived = []
    pingsReceived = 0
    answerPings = true
    client = null
    server = http.createServer()
    wss = new WebSocketServer({ server, path: '/ws', autoPong: false })
    wss.on('connection', (socket) => {
      serverSockets.push(socket)
      socket.on('ping', (data) => {
        pingsReceived += 1
        if (!answerPings) return
        socket.pong(data)
        // The client reads one ordered stream: this frame arriving proves the pong did.
        socket.send(JSON.stringify({ type: 'federation', payload: { kind: 'heartbeat', officeId: 'o', fromNode: 'host', ts: 0 } }))
      })
      socket.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as { type?: string; payload?: FederationMessage }
        // A LAN host: no wire version in the answer.
        if (msg.type === 'auth') socket.send(JSON.stringify({ type: 'auth:success' }))
        if (msg.type === 'federation' && msg.payload) framesReceived.push(msg.payload)
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as { port: number }).port
    ping = spyOnPing()
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], shouldAdvanceTime: true })
  })

  afterEach(async () => {
    client?.close()
    vi.useRealTimers()
    vi.restoreAllMocks()
    wss.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  async function openRefused(url = `http://127.0.0.1:${port}`): Promise<WsFederationClient> {
    let opened = false
    const created = new WsFederationClient({
      serverUrl: url,
      credentialToken: 'tok',
      onFrame: () => {},
      onStateChange: (s) => {
        if (s === 'open') opened = true
      },
    })
    client = created
    await waitFor(() => opened)
    expect(opened).toBe(true)
    created.markRefused(60_000)
    return created
  }

  it('pings it a full interval after the latest refusal, and keeps it while the pings are answered', async () => {
    const c = await openRefused()
    await vi.advanceTimersByTimeAsync(20_000)
    c.markRefused(60_000)
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS - 1)
    expect(ping).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(ping).toHaveBeenCalledTimes(1)
    await waitFor(() => c.getHealth().received.control.frames === 1)
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS)
    expect(ping).toHaveBeenCalledTimes(2)
    await waitFor(() => c.getHealth().received.control.frames === 2)

    expect(pingsReceived).toBe(2)
    expect(serverSockets).toHaveLength(1)
    expect(c.getHealth()).toMatchObject({ connected: true, refused: { retryInMs: 0 } })
  })

  it('ends it when a ping goes unanswered, and reconnects on the usual backoff', async () => {
    const c = await openRefused()
    answerPings = false
    const warn = vi.spyOn(console, 'warn')

    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS)
    await waitFor(() => pingsReceived === 1)
    expect(serverSockets).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS)

    // The close is long past the refusal: the 1 s backoff, not the 60 s refusal delay.
    await waitFor(() => serverSockets.length === 2 && c.getHealth().connected, 3000)
    expect(serverSockets).toHaveLength(2)
    expect(c.getHealth().refused).toBeNull()
    expect(ping).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls.filter(([line]) => String(line).includes('did not answer a ping'))).toHaveLength(1)
  })

  it('notices on the next ping that the far side forgot the connection, and reconnects', async () => {
    // In front of the server: a far side that drops the connection without a FIN
    // reaching the client, then answers the next bytes from it with a reset.
    const links: Array<{ downstream: net.Socket; upstream: net.Socket; forgotten: boolean }> = []
    const proxy = net.createServer((downstream) => {
      const link = { downstream, upstream: net.connect(port, '127.0.0.1'), forgotten: false }
      links.push(link)
      downstream.on('data', (chunk) => {
        if (link.forgotten) downstream.resetAndDestroy()
        else link.upstream.write(chunk)
      })
      link.upstream.on('data', (chunk) => {
        if (!link.forgotten) downstream.write(chunk)
      })
      link.upstream.on('close', () => {
        if (!link.forgotten) downstream.destroy()
      })
      downstream.on('close', () => link.upstream.destroy())
      downstream.on('error', () => {})
      link.upstream.on('error', () => {})
    })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    try {
      const c = await openRefused(`http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`)
      links[0].forgotten = true
      links[0].upstream.destroy()
      await waitFor(() => serverSockets[0].readyState === WebSocket.CLOSED)
      await new Promise((r) => setTimeout(r, 100))
      expect(c.getHealth()).toMatchObject({ connected: true, refused: { retryInMs: 0 } })

      await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS)
      await waitFor(() => serverSockets.length === 2 && c.getHealth().connected, 3000)
      expect(serverSockets).toHaveLength(2)
      expect(c.getHealth().refused).toBeNull()
    } finally {
      client?.close()
      client = null
      for (const { downstream, upstream } of links) {
        downstream.destroy()
        upstream.destroy()
      }
      await new Promise<void>((resolve) => proxy.close(() => resolve()))
    }
  })

  it('stops pinging once the refusal is lifted, the session ends, or the client closes', async () => {
    const c = await openRefused()
    expect(c.retryRefused()).toBe(true)
    expect(vi.getTimerCount()).toBe(0)

    c.markRefused(60_000)
    serverSockets[0].terminate()
    await waitFor(() => !c.getHealth().connected && c.isRefused)
    expect(vi.getTimerCount()).toBe(0)

    expect(c.retryRefused()).toBe(false)
    await waitFor(() => serverSockets.length === 2 && c.getHealth().connected)
    c.markRefused(60_000)
    expect(vi.getTimerCount()).toBe(1)
    c.close()
    expect(vi.getTimerCount()).toBe(0)

    await vi.advanceTimersByTimeAsync(3 * PING_INTERVAL_MS)
    expect(ping).not.toHaveBeenCalled()
  })

  it('carries frames again once the far side admits it on that session, without what it withheld', async () => {
    const frame = (fromNode: string): FederationMessage => ({ kind: 'heartbeat', officeId: 'o', fromNode, ts: 0 })
    const c = await openRefused()
    c.send(frame('while-refused'))

    c.markAdmitted()

    expect(vi.getTimerCount()).toBe(0)
    expect(c.getHealth()).toMatchObject({ connected: true, refused: null, withheld: 1 })
    c.send(frame('after-grant'))
    await waitFor(() => framesReceived.length === 1)
    await new Promise((r) => setTimeout(r, 50))
    expect(framesReceived).toEqual([frame('after-grant')])
    await vi.advanceTimersByTimeAsync(3 * PING_INTERVAL_MS)
    expect(ping).not.toHaveBeenCalled()
    expect(serverSockets).toHaveLength(1)
  })

  it('leaves a parked reconnect alone: no session of it was admitted', async () => {
    const c = await openRefused()
    serverSockets[0].terminate()
    await waitFor(() => !c.getHealth().connected && c.isRefused)

    c.markAdmitted()

    expect(c.getHealth().refused?.retryInMs).toBeGreaterThan(0)
    await new Promise((r) => setTimeout(r, 1500))
    expect(serverSockets).toHaveLength(1)
  })
})

describe('WsFederationClient — a refused credential', () => {
  it('stops for good: auth:failed is never retried', async () => {
    const server = http.createServer()
    const wss = new WebSocketServer({ server, path: '/ws' })
    let sessions = 0
    wss.on('connection', (socket) => {
      sessions += 1
      socket.on('message', () => socket.send(JSON.stringify({ type: 'auth:failed', error: 'Invalid token' })))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const states: string[] = []
    const c = new WsFederationClient({
      serverUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      credentialToken: 'revoked',
      onFrame: () => {},
      onStateChange: (s) => states.push(s),
    })
    try {
      await waitFor(() => states.includes('closed'))
      await new Promise((r) => setTimeout(r, 1500))
      expect(sessions).toBe(1)
      expect(c.retryRefused()).toBe(false)
    } finally {
      c.close()
      wss.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
