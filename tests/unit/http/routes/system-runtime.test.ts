/**
 * GET /api/system/runtime tells a web client whether its backend is a headless
 * server, which decides whether node-level settings are shown there.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'net'

vi.mock('../../../../src/main/http/routes/_shared', () => ({
  analytics: { track: vi.fn() },
  RENDERER_ALLOWED_EVENTS: new Set<string>(),
  electronApp: { getVersion: () => '0.0.0' },
  getEnabledAuthProviderConfigs: () => [],
}))

const { registerSystemRoutes } = await import('../../../../src/main/http/routes/system.routes')

async function readRuntime(): Promise<unknown> {
  const app = express()
  registerSystemRoutes(app)
  const server = app.listen(0)
  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/api/system/runtime`)
    return await response.json()
  } finally {
    server.close()
  }
}

describe('GET /api/system/runtime', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('reports a headless server', async () => {
    vi.stubEnv('HALO_SERVER_MODE', '1')
    expect(await readRuntime()).toEqual({ success: true, data: { serverMode: true } })
  })

  it('reports a desktop backend when the flag is absent', async () => {
    vi.stubEnv('HALO_SERVER_MODE', '')
    expect(await readRuntime()).toEqual({ success: true, data: { serverMode: false } })
  })
})
