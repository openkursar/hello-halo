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
  parseCredentialType: (token: string) => parseCredentialType(token),
  verifyOfficeCredential: (_token: string) => verifyOfficeCredential(),
}))

const terminalInput = vi.fn()
const terminalResize = vi.fn()
vi.mock('../../../src/main/services/ai-terminal', () => ({
  terminalInput: (...args: unknown[]) => terminalInput(...args),
  terminalResize: (...args: unknown[]) => terminalResize(...args),
}))

interface LiveLink {
  viewerId: string
  frame: (frame: Record<string, unknown>) => boolean
  stopped: (stopped: Record<string, unknown>) => void
}
const browserLiveAttach = vi.fn((_viewId: string, _link: LiveLink) => true)
const browserLiveDetach = vi.fn()
const browserLiveAck = vi.fn()
const browserLiveRequestDetail = vi.fn()
const browserLiveInput = vi.fn()
const isLiveConversationPage = vi.fn((_viewId: string) => true)
vi.mock('../../../src/main/services/ai-browser', () => ({
  isLiveConversationPage: (viewId: string) => isLiveConversationPage(viewId),
}))
vi.mock('../../../src/main/services/browser-live', () => ({
  browserLiveAttach: (viewId: string, link: LiveLink) => browserLiveAttach(viewId, link),
  browserLiveDetach: (...args: unknown[]) => browserLiveDetach(...args),
  browserLiveAck: (...args: unknown[]) => browserLiveAck(...args),
  browserLiveRequestDetail: (...args: unknown[]) => browserLiveRequestDetail(...args),
  browserLiveInput: (...args: unknown[]) => browserLiveInput(...args),
  browserLiveViewerDisconnected: vi.fn(),
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
    send: (data: string) => void
    close: () => void
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

    expect(client.sent).toContainEqual({ type: 'auth:success', payload: { browserLive: true, browserCredentials: false } })
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

describe('browser live view control', () => {
  beforeEach(() => {
    wssInstances.length = 0
    authenticateWebSocket.mockReset()
    browserLiveAttach.mockReset()
    browserLiveAttach.mockReturnValue(true)
    browserLiveDetach.mockReset()
    browserLiveAck.mockReset()
    browserLiveRequestDetail.mockReset()
    browserLiveInput.mockReset()
    shutdownWebSocket()
  })

  /** The attach/ack/detail handlers all run behind a dynamic import. */
  const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

  it('refuses to start a stream for an unauthenticated client', async () => {
    const server = startServer()
    const client = connect(server)

    client.emitMessage({ type: 'browser-live-attach', payload: { viewId: 'view-1' } })

    await settle()
    expect(client.sent).toContainEqual({ type: 'error', error: 'Not authenticated' })
    expect(browserLiveAttach).not.toHaveBeenCalled()
  })

  it('sends frames only to the client that asked to watch', async () => {
    authenticateWebSocket.mockReturnValue(true)
    const server = startServer()

    const watcher = connect(server, '1.1.1.1')
    watcher.emitMessage({ type: 'auth', payload: { token: 'good' } })
    const bystander = connect(server, '2.2.2.2')
    bystander.emitMessage({ type: 'auth', payload: { token: 'good' } })

    watcher.emitMessage({ type: 'browser-live-attach', payload: { viewId: 'view-1' } })
    await settle()

    const [viewId, link] = browserLiveAttach.mock.calls[0]
    expect(viewId).toBe('view-1')
    watcher.sent.length = 0
    bystander.sent.length = 0

    expect(link.frame({ viewId: 'view-1', seq: 1, image: 'data:,', width: 8, height: 8 })).toBe(true)
    link.stopped({ viewId: 'view-1', reason: 'gone' })

    expect(watcher.sent).toEqual([
      { type: 'event', channel: 'browser:live-frame', data: { viewId: 'view-1', seq: 1, image: 'data:,', width: 8, height: 8 } },
      { type: 'event', channel: 'browser:live-stopped', data: { viewId: 'view-1', reason: 'gone' } },
    ])
    expect(bystander.sent).toEqual([])
  })

  it('reports a dead link so the stream stops paying for a closed socket', async () => {
    authenticateWebSocket.mockReturnValue(true)
    const server = startServer()
    const client = connect(server)
    client.emitMessage({ type: 'auth', payload: { token: 'good' } })
    client.emitMessage({ type: 'browser-live-attach', payload: { viewId: 'view-1' } })
    await settle()

    const link = browserLiveAttach.mock.calls[0][1]
    client.ws.readyState = 3

    expect(link.frame({ viewId: 'view-1', seq: 2, image: 'data:,', width: 8, height: 8 })).toBe(false)
  })

  it('tells a client its page is already gone instead of leaving it waiting', async () => {
    authenticateWebSocket.mockReturnValue(true)
    browserLiveAttach.mockReturnValue(false)
    const server = startServer()
    const client = connect(server)
    client.emitMessage({ type: 'auth', payload: { token: 'good' } })
    client.sent.length = 0

    client.emitMessage({ type: 'browser-live-attach', payload: { viewId: 'view-1' } })
    await settle()

    expect(client.sent).toEqual([
      { type: 'event', channel: 'browser:live-stopped', data: { viewId: 'view-1', reason: 'gone' } },
    ])
  })

  it('ignores a malformed acknowledgement and forwards a valid one', async () => {
    authenticateWebSocket.mockReturnValue(true)
    const server = startServer()
    const client = connect(server)
    client.emitMessage({ type: 'auth', payload: { token: 'good' } })

    client.emitMessage({ type: 'browser-live-attach', payload: { viewId: 'view-1' } })
    await settle()
    client.emitMessage({ type: 'browser-live-ack', payload: { viewId: 'view-1', seq: 'soon' } })
    client.emitMessage({ type: 'browser-live-ack', payload: { viewId: 'view-1' } })
    await settle()
    expect(browserLiveAck).not.toHaveBeenCalled()

    client.emitMessage({ type: 'browser-live-ack', payload: { viewId: 'view-1', seq: 7 } })
    await settle()
    expect(browserLiveAck.mock.calls).toEqual([['view-1', expect.any(String), 7]])

    client.emitMessage({ type: 'browser-live-detail', payload: { viewId: 'view-1' } })
    await settle()
    // Both messages must arrive as the same viewer, or the stream cannot pace it.
    expect(browserLiveRequestDetail).toHaveBeenCalledWith('view-1', browserLiveAck.mock.calls[0][1], 'screen')

    client.emitMessage({ type: 'browser-live-detail', payload: { viewId: 'view-1', scope: 'page' } })
    await settle()
    client.emitMessage({ type: 'browser-live-detail', payload: { viewId: 'view-1', scope: 'everything' } })
    await settle()
    expect(browserLiveRequestDetail.mock.calls.slice(1).map(call => call[2])).toEqual(['page', 'screen'])
  })

  it('advertises live viewing to the remote owner and handles its input', async () => {
    authenticateWebSocket.mockReturnValue(true)
    const server = startServer()
    const client = connect(server)
    client.emitMessage({ type: 'auth', payload: { token: 'good' } })

    client.emitMessage({ type: 'browser-live-attach', payload: { viewId: 'view-1' } })
    await settle()
    const [viewId, link] = browserLiveAttach.mock.calls[0]
    expect(client.sent).toEqual([{ type: 'auth:success', payload: { browserLive: true, browserCredentials: false } }])

    const input = { kind: 'text', text: 'x' }
    client.emitMessage({ type: 'browser-live-input', payload: { viewId, input } })
    await settle()
    expect(browserLiveInput).toHaveBeenCalledWith(viewId, link.viewerId, input)
  })

  it.each(['detach', 'disconnect'])('does not start a pending capture after %s', async (action) => {
    authenticateWebSocket.mockReturnValue(true)
    const client = connect(startServer())
    client.emitMessage({ type: 'auth', payload: { token: 'good' } })
    client.emitMessage({ type: 'browser-live-attach', payload: { viewId: 'view-1' } })
    if (action === 'detach') client.emitMessage({ type: 'browser-live-detach', payload: { viewId: 'view-1' } })
    else client.ws.readyState = 3
    await settle()
    expect(browserLiveAttach).not.toHaveBeenCalled()
  })

  it('detaches an owner attachment and drops queued input on office reauthentication', async () => {
    authenticateWebSocket.mockReturnValue(true)
    const client = connect(startServer())
    client.emitMessage({ type: 'auth', payload: { token: 'good' } })
    client.emitMessage({ type: 'browser-live-attach', payload: { viewId: 'view-1' } })
    await settle()
    const [viewId, link] = browserLiveAttach.mock.calls[0]
    client.emitMessage({ type: 'browser-live-input', payload: { viewId, input: { kind: 'text', text: 'x' } } })
    parseCredentialType.mockReturnValueOnce('office-member')
    verifyOfficeCredential.mockReturnValueOnce({ officeId: 'office-1', scope: 'member' } as never)
    client.emitMessage({ type: 'auth', payload: { token: 'office-token' } })
    await settle()
    expect(browserLiveDetach).toHaveBeenCalledWith(viewId, link.viewerId)
    expect(link.frame({ viewId, seq: 1 })).toBe(false)
    expect(browserLiveInput).not.toHaveBeenCalled()
  })

  it('lets only the owner watch or operate a page; an office session gets neither', async () => {
    authenticateWebSocket.mockReturnValue(true)
    const server = startServer()
    const stranger = connect(server, '3.3.3.3')
    stranger.emitMessage({ type: 'browser-live-input', payload: { viewId: 'view-1', input: { kind: 'text', text: 'x' } } })

    parseCredentialType.mockReturnValueOnce('office-member')
    verifyOfficeCredential.mockReturnValueOnce({ officeId: 'office-1', scope: 'member' } as never)
    const peer = connect(server, '4.4.4.4')
    peer.emitMessage({ type: 'auth', payload: { token: 'office-token' } })
    expect(peer.sent).toContainEqual({ type: 'auth:success' })
    peer.sent.length = 0
    peer.emitMessage({ type: 'browser-live-attach', payload: { viewId: 'view-1' } })
    peer.emitMessage({ type: 'browser-live-ack', payload: { viewId: 'view-1', seq: 1 } })
    peer.emitMessage({ type: 'browser-live-detail', payload: { viewId: 'view-1' } })
    peer.emitMessage({ type: 'browser-live-input', payload: { viewId: 'view-1', input: { kind: 'text', text: 'x' } } })
    await settle()
    expect(peer.sent).toEqual([
      { type: 'event', channel: 'browser:live-stopped', data: { viewId: 'view-1', reason: 'unavailable' } },
    ])
    expect(browserLiveAttach).not.toHaveBeenCalled()
    expect(browserLiveAck).not.toHaveBeenCalled()
    expect(browserLiveRequestDetail).not.toHaveBeenCalled()
    expect(browserLiveInput).not.toHaveBeenCalled()

    const owner = connect(server, '1.1.1.1')
    owner.emitMessage({ type: 'auth', payload: { token: 'good' } })
    owner.emitMessage({ type: 'browser-live-attach', payload: { viewId: 'view-1' } })
    await settle()
    owner.emitMessage({ type: 'browser-live-input', payload: { viewId: 'view-1', input: { kind: 'text', text: 'x' } } })
    await settle()
    expect(browserLiveInput.mock.calls).toEqual([['view-1', expect.any(String), { kind: 'text', text: 'x' }]])
  })
})
