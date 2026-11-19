/**
 * The AI's request to show something goes to the desktop window and every
 * remote client, and main is told how many it reached so it waits for exactly
 * those answers. A client's answer comes back over IPC (or HTTP for remote).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const send = vi.fn()
const env = vi.hoisted(() => ({ window: true as boolean, remoteClients: 0, wsThrows: false }))
let forward: ((request: Record<string, unknown>) => void) | null = null
const expectReplies = vi.fn()
const receive = vi.fn((_reply: unknown) => true)
const unsubscribe = vi.fn()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  },
}))
vi.mock('../../../src/main/foundation/window.service', () => ({
  getMainWindow: () => (env.window ? { isDestroyed: () => false, webContents: { send } } : null),
}))
vi.mock('../../../src/main/http/websocket', () => ({
  broadcastToAll: () => {
    if (env.wsThrows) throw new Error('WS not initialized')
    return env.remoteClients
  },
}))
vi.mock('../../../src/main/services/canvas-show', () => ({
  onCanvasShowRequest: (handler: typeof forward) => { forward = handler; return unsubscribe },
  expectCanvasShowReplies: (...a: unknown[]) => expectReplies(...a),
  receiveCanvasShowReply: (reply: unknown) => receive(reply),
}))

const { registerCanvasShowHandlers, cleanupCanvasShowHandlers } = await import('../../../src/main/ipc/canvas-show')

const request = { requestId: 'r1', spaceId: 's1', conversationId: 'c1', target: { kind: 'file', path: '/w/a.md' }, bringForward: true }

beforeEach(() => {
  Object.assign(env, { window: true, remoteClients: 0, wsThrows: false })
  send.mockClear()
  expectReplies.mockClear()
  receive.mockClear()
  cleanupCanvasShowHandlers()
  registerCanvasShowHandlers()
})

describe('forwarding a show request', () => {
  it('sends it to the window and the remote clients, and expects an answer from each', () => {
    env.remoteClients = 2
    forward!(request)
    expect(send).toHaveBeenCalledWith('canvas:show-request', request)
    expect(expectReplies).toHaveBeenCalledWith('r1', 3)
  })

  it('expects no answer when no window and no remote client exists', () => {
    env.window = false
    env.wsThrows = true
    forward!(request)
    expect(send).not.toHaveBeenCalled()
    expect(expectReplies).toHaveBeenCalledWith('r1', 0)
  })
})

describe('receiving an answer', () => {
  it('hands it to the service and says whether it was understood', async () => {
    expect(await handlers.get('canvas:show-reply')!({}, { requestId: 'r1', outcome: 'shown' })).toEqual({ success: true })
    expect(receive).toHaveBeenCalledWith({ requestId: 'r1', outcome: 'shown' })
    receive.mockReturnValueOnce(false)
    expect(await handlers.get('canvas:show-reply')!({}, 'junk')).toEqual({ success: false })
  })

  it('stops listening when cleaned up', () => {
    cleanupCanvasShowHandlers()
    expect(handlers.has('canvas:show-reply')).toBe(false)
    expect(unsubscribe).toHaveBeenCalled()
  })
})
