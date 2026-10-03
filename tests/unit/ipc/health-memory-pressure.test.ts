/**
 * Memory-pressure level changes are forwarded by the transport layer to the
 * window and remote clients, once per change, and re-registering does not
 * double the forwarding.
 */

import { describe, it, expect, vi } from 'vitest'

const sent = vi.hoisted(() => ({ ipc: [] as unknown[], ws: [] as unknown[] }))
vi.mock('../../../src/main/foundation/window.service', () => ({ sendToRenderer: (ch: string, p: unknown) => sent.ipc.push([ch, p]) }))
vi.mock('../../../src/main/http/websocket', () => ({ broadcastToAll: (ch: string, p: unknown) => sent.ws.push([ch, p]) }))
vi.mock('../../../src/main/services/health', () => ({}))

import { forwardMemoryPressure } from '../../../src/main/ipc/health'
import { evaluateMemoryPressure } from '../../../src/main/platform/background/memory-pressure'

describe('forwardMemoryPressure', () => {
  it('sends each level change to IPC and WebSocket exactly once', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    forwardMemoryPressure()
    forwardMemoryPressure()
    evaluateMemoryPressure({ availableRatio: 0.05, availableSource: 'kernel', rendererMb: 100 })
    expect(sent.ipc).toEqual([['app:memory-pressure', { level: 'critical' }]])
    expect(sent.ws).toEqual([['app:memory-pressure', { level: 'critical' }]])
  })
})
