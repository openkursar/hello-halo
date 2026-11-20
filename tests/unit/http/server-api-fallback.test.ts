/**
 * An unmatched /api path must answer JSON, not fall through to the web app's
 * HTML. A web client that receives HTML for an API call can only report an
 * opaque parse error.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Server } from 'http'
import type { AddressInfo } from 'net'
import type { Express } from 'express'

const env = vi.hoisted(() => ({ servers: [] as Server[] }))
// Exercise the real server middleware and auth on an isolated loopback listener.
vi.mock('http', async original => {
  const real = await original<typeof import('http')>()
  return {
    ...real,
    createServer: (...args: Parameters<typeof real.createServer>) => {
      const server = real.createServer(...args)
      const listen = server.listen.bind(server)
      server.listen = ((_port: number, _host: string, callback: () => void) => listen(0, '127.0.0.1', callback)) as typeof server.listen
      env.servers.push(server)
      return server
    },
  }
})
vi.mock('../../../src/main/http/websocket', () => ({ initWebSocket: vi.fn(), shutdownWebSocket: vi.fn(), getClientCount: () => 0 }))
vi.mock('../../../src/main/apps/team', () => ({ getTeamStore: () => null }))
vi.mock('../../../src/main/http/identity', () => ({ getLocalIdentity: () => null }))
vi.mock('../../../src/main/foundation/window.service', () => ({ getMainWindow: () => null }))
vi.mock('../../../src/main/http/routes', () => ({
  registerApiRoutes(app: Express) {
    app.get('/api/example', (_req, res) => res.json({ success: true, data: 'example' }))
  },
}))

import { startHttpServer, stopHttpServer } from '../../../src/main/http/server'

let baseUrl: string
let token: string

beforeAll(async () => {
  ;({ token } = await startHttpServer(0))
  const address = env.servers[0].address() as AddressInfo
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  stopHttpServer()
  await Promise.all(env.servers.map(server => new Promise<void>(resolve => {
    server.closeAllConnections()
    server.close(() => resolve())
  })))
})

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

const authorized = () => ({ Authorization: `Bearer ${token}` })

describe('API fallback', () => {
  it.each(['GET', 'POST', 'DELETE'])('answers an unknown %s API path with a JSON 404', async method => {
    const response = await fetch(`${baseUrl}/api/not-a-route/nested?x=1`, { method, headers: authorized() })
    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toEqual({ success: false, code: 'API_NOT_FOUND', error: 'API endpoint not found' })
    // The query string is not logged.
    expect(console.warn).toHaveBeenCalledWith(`[HTTP] Unmatched API request: ${method} /api/not-a-route/nested`)
  })

  it('leaves registered routes unchanged', async () => {
    const response = await fetch(`${baseUrl}/api/example`, { headers: authorized() })
    expect(await response.json()).toEqual({ success: true, data: 'example' })
  })

  it('still requires authentication before reporting a path as unknown', async () => {
    const response = await fetch(`${baseUrl}/api/not-a-route`)
    expect(response.status).toBe(401)
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('Unmatched API request'))
  })

  it('does not answer page navigation', async () => {
    const response = await fetch(`${baseUrl}/`)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('Unmatched API request'))
  })
})
