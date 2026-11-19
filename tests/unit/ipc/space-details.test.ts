import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

const m = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  getSpace: vi.fn(),
  deleteSpace: vi.fn(),
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => m.handlers.set(channel, handler) },
}))
vi.mock('../../../src/main/foundation/file-dialog', () => ({}))
vi.mock('../../../src/main/foundation/config.service', () => ({}))
vi.mock('../../../src/main/services/space.service', () => ({}))
vi.mock('../../../src/main/controllers/space.controller', () => ({ getSpace: m.getSpace, deleteSpace: m.deleteSpace }))
vi.mock('../../../src/main/http/routes/_shared', () => ({
  spaceController: { getSpace: m.getSpace, deleteSpace: m.deleteSpace },
  conversationController: {},
}))

import { registerSpaceHandlers } from '../../../src/main/ipc/space'
import { registerSpaceRoutes } from '../../../src/main/http/routes/space.routes'

registerSpaceHandlers()

async function http(method: 'GET' | 'DELETE' | 'POST', path: string): Promise<unknown> {
  const app = express()
  registerSpaceRoutes(app)
  const server = await new Promise<Server>(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, { method })
    expect(response.status).toBe(200)
    return response.json()
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

beforeEach(() => {
  m.getSpace.mockReset().mockResolvedValue({ success: true, data: { id: 'space-1', path: '/owned/project' } })
  m.deleteSpace.mockReset().mockResolvedValue({ success: true })
})

describe('space details and deletion transport', () => {
  it('forwards the optional IPC deletion-impact request and awaits the controller', async () => {
    const options = { includeDeletionImpact: true }
    expect(await m.handlers.get('space:get')!({}, 'space-1', options)).toEqual({
      success: true, data: { id: 'space-1', path: '/owned/project' },
    })
    expect(m.getSpace).toHaveBeenCalledWith('space-1', options)

    await m.handlers.get('space:get')!({}, 'space-1')
    expect(m.getSpace).toHaveBeenLastCalledWith('space-1', undefined)
  })

  it.each([
    ['', false],
    ['?includeDeletionImpact=false', false],
    ['?includeDeletionImpact=1', false],
    ['?includeDeletionImpact=true', true],
  ])('HTTP forwards explicit deletion-impact opt-in only: %s', async (query, includeDeletionImpact) => {
    expect(await http('GET', `/api/spaces/space-1${query}`)).toEqual({
      success: true, data: { id: 'space-1', path: '/owned/project' },
    })
    expect(m.getSpace).toHaveBeenCalledTimes(1)
    expect(m.getSpace).toHaveBeenCalledWith('space-1', { includeDeletionImpact })
  })

  it('awaits ordinary details without requesting impact when a remote user opens the folder', async () => {
    expect(await http('POST', '/api/spaces/space-1/open')).toEqual({ success: true, data: { path: '/owned/project' } })
    expect(m.getSpace).toHaveBeenCalledTimes(1)
    expect(m.getSpace).toHaveBeenCalledWith('space-1')
  })

  it('preserves the deletion error on both IPC and HTTP', async () => {
    const failure = { success: false, error: 'Could not preserve digital human history' }
    m.deleteSpace.mockResolvedValue(failure)

    expect(await m.handlers.get('space:delete')!({}, 'space-1')).toEqual(failure)
    expect(await http('DELETE', '/api/spaces/space-1')).toEqual(failure)
    expect(m.deleteSpace).toHaveBeenNthCalledWith(1, 'space-1')
    expect(m.deleteSpace).toHaveBeenNthCalledWith(2, 'space-1')
  })
})
