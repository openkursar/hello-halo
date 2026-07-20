/**
 * WebSocket manager tests. handleClientMessage and sendToClient are module-
 * private, so they are exercised through the public surface: initWebSocket
 * wires a connection handler onto a fake WebSocketServer, and each simulated
 * client exposes the on('message') callback that handleClientMessage runs
 * behind. broadcastToWebSocket is tested directly against the resulting
 * authenticated/subscribed client set.
 *
 * `ws` is mocked (fake server + OPEN constant), auth is mocked to control
 * the authenticate outcome, and the lazily-imported ai-terminal module is
 * mocked so terminal-input/resize dispatch can be asserted.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'events'

const OPEN = 1

class FakeWebSocketServer extends EventEmitter {
  close = vi.fn()
}

const wssInstances: FakeWebSocketServer[] = []

vi.mock('ws', () => ({
  WebSocket: { OPEN: 1 },
  WebSocketServer: vi.fn(() => {
    const s = new FakeWebSocketServer()
    wssInstances.push(s)
    return s
  }),
}))

vi.mock('uuid', () => {
  let n = 0
  return { v4: () => `client-${++n}` }
})

const authenticateWebSocket = vi.fn()
const parseCredentialType = vi.fn((_token: string) => 'remote-control')
const verifyOfficeCredential = vi.fn(() => null)
vi.mock('../../../src/main/http/auth/index', () => ({
  authenticateWebSocket: (...args: unknown[]) => authenticateWebSocket(...args),
  parseCredentialType: (...args: unknown[]) => parseCredentialType(...args),
  verifyOfficeCredential: (...args: unknown[]) => verifyOfficeCredential(...args),
}))

const terminalInput = vi.fn()
const terminalResize = vi.fn()
vi.mock('../../../src/main/services/ai-terminal', () => ({
  terminalInput: (...args: unknown[]) => terminalInput(...args),
  terminalResize: (...args: unknown[]) => terminalResize(...args),
}))

import {
  initWebSocket,
  broadcastToWebSocket,
  shutdownWebSocket,
} from '../../../src/main/http/websocket'

interface FakeClient {
  emitMessage(msg: unknown): void
  sent: unknown[]
  ws: { readyState: number; send: (s: string) => void; close: () => void }
}

/**
 * Simulate a new WS connection and return handles to drive it. Each returned
 * client mirrors the socket the manager wires listeners onto.
 */
function connect(server: FakeWebSocketServer, ip = '1.2.3.4'): FakeClient {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number
    send: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
  }
  socket.readyState = OPEN
  const sent: unknown[] = []
  socket.send = vi.fn((s: string) => {
    sent.push(JSON.parse(s))
  })
  socket.close = vi.fn()

  server.emit('connection', socket, { socket: { remoteAddress: ip } })

  return {
    emitMessage(msg: unknown) {
      socket.emit('message', Buffer.from(JSON.stringify(msg)))
    },
    sent,
    ws: socket as unknown as FakeClient['ws'],
  }
}

function startServer(): FakeWebSocketServer {
  initWebSocket({} as unknown as never)
  return wssInstances[wssInstances.length - 1]
}

describe('websocket handleClientMessage', () => {
  beforeEach(() => {
    wssInstances.length = 0
    authenticateWebSocket.mockReset()
    terminalInput.mockReset()
    terminalResize.mockReset()
    shutdownWebSocket()
  })

  it('rejects subscribe from an unauthenticated client', () => {
    const server = startServer()
    const client = connect(server)

    client.emitMessage({ type: 'subscribe', payload: { conversationId: 'c1' } })

    expect(client.sent).toContainEqual({ type: 'error', error: 'Not authenticated' })
  })

  it('rejects terminal-input from an unauthenticated client and never dispatches', () => {
    const server = startServer()
    const client = connect(server)

    client.emitMessage({ type: 'terminal-input', payload: { sessionId: 's', data: 'x' } })

    expect(client.sent).toContainEqual({ type: 'error', error: 'Not authenticated' })
    expect(terminalInput).not.toHaveBeenCalled()
  })

  it('rejects terminal-resize from an unauthenticated client', () => {
    const server = startServer()
    const client = connect(server)

    client.emitMessage({ type: 'terminal-resize', payload: { sessionId: 's', cols: 80, rows: 24 } })

    expect(client.sent).toContainEqual({ type: 'error', error: 'Not authenticated' })
    expect(terminalResize).not.toHaveBeenCalled()
  })

  it('authenticates with a valid token and confirms success', () => {
    authenticateWebSocket.mockReturnValue(true)
    const server = startServer()
    const client = connect(server)

    client.emitMessage({ type: 'auth', payload: { token: 'good' } })

    expect(client.sent).toContainEqual({ type: 'auth:success' })
  })

  it('rejects terminal-resize with non-integer or negative dimensions', async () => {
    authenticateWebSocket.mockReturnValue(true)
    const server = startServer()
    const client = connect(server)
    client.emitMessage({ type: 'auth', payload: { token: 'good' } })

    client.emitMessage({ type: 'terminal-resize', payload: { sessionId: 's', cols: 80.5, rows: 24 } })
    client.emitMessage({ type: 'terminal-resize', payload: { sessionId: 's', cols: -1, rows: 24 } })
    client.emitMessage({ type: 'terminal-resize', payload: { sessionId: 's', cols: 80, rows: 0 } })

    // Give the dynamic import().then() a chance to settle; it must not fire.
    await Promise.resolve()
    await Promise.resolve()
    expect(terminalResize).not.toHaveBeenCalled()
  })

  it('responds to ping with pong', () => {
    const server = startServer()
    const client = connect(server)

    client.emitMessage({ type: 'ping' })

    expect(client.sent).toContainEqual({ type: 'pong' })
  })
})

describe('broadcastToWebSocket', () => {
  beforeEach(() => {
    wssInstances.length = 0
    authenticateWebSocket.mockReset()
    shutdownWebSocket()
  })

  it('only reaches authenticated clients subscribed to the conversation', () => {
    authenticateWebSocket.mockReturnValue(true)
    const server = startServer()

    const subscribed = connect(server, '1.1.1.1')
    subscribed.emitMessage({ type: 'auth', payload: { token: 'good' } })
    subscribed.emitMessage({ type: 'subscribe', payload: { conversationId: 'conv-A' } })

    const authedOther = connect(server, '2.2.2.2')
    authedOther.emitMessage({ type: 'auth', payload: { token: 'good' } })
    authedOther.emitMessage({ type: 'subscribe', payload: { conversationId: 'conv-B' } })

    const unauth = connect(server, '3.3.3.3')
    // Never authenticates; even a subscribe attempt is rejected.
    unauth.emitMessage({ type: 'subscribe', payload: { conversationId: 'conv-A' } })

    subscribed.sent.length = 0
    authedOther.sent.length = 0
    unauth.sent.length = 0

    broadcastToWebSocket('agent:event', { conversationId: 'conv-A', value: 42 })

    expect(subscribed.sent).toEqual([
      { type: 'event', channel: 'agent:event', data: { conversationId: 'conv-A', value: 42 } },
    ])
    expect(authedOther.sent).toEqual([])
    expect(unauth.sent).toEqual([])
  })

  it('warns and drops when conversationId is missing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    authenticateWebSocket.mockReturnValue(true)
    const server = startServer()

    const client = connect(server)
    client.emitMessage({ type: 'auth', payload: { token: 'good' } })
    client.emitMessage({ type: 'subscribe', payload: { conversationId: 'conv-A' } })
    client.sent.length = 0

    broadcastToWebSocket('agent:event', { value: 1 })

    expect(client.sent).toEqual([])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
