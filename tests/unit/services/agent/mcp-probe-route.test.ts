/**
 * The MCP connection check reaches a remote server on the app's route
 * (`proxyFetch`), as a session's connection would — not on a bare fetch that
 * ignores the proxy settings.
 */

import { describe, expect, it, vi } from 'vitest'

const proxyFetch = vi.hoisted(() => vi.fn(async (_url: string | URL, _init?: RequestInit): Promise<Response> => {
  throw new Error('route reached')
}))
vi.mock('../../../../src/main/services/proxy-fetch', () => ({ proxyFetch }))
vi.mock('../../../../src/main/services/agent/app-bridge', () => ({ getAppManager: () => null }))
vi.mock('../../../../src/main/services/agent/mcp-auth-state', () => ({ purgeStaleMcpOAuth: vi.fn() }))
vi.mock('../../../../src/main/services/agent/mcp-manager', () => ({
  updateServerStatus: vi.fn(),
  removeServerStatus: vi.fn(),
}))

import { probeServerConfig } from '../../../../src/main/services/agent/mcp-probe'

describe('MCP connection check route', () => {
  it.each(['http', 'sse'] as const)('sends a remote %s server through the app route', async type => {
    proxyFetch.mockClear()

    const result = await probeServerConfig({ type, url: 'https://mcp.example.com/mcp', headers: { 'X-Test': '1' } }, 2_000)

    expect(result.status).toBe('failed')
    expect(proxyFetch).toHaveBeenCalled()
    expect(String(proxyFetch.mock.calls[0][0])).toBe('https://mcp.example.com/mcp')
  })
})
