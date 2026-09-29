/**
 * POST /api/analytics/report accepts both the single report older clients send
 * and the batch newer ones send, and applies the renderer allow-list to every
 * report either way.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'net'

const track = vi.fn()

vi.mock('../../../../src/main/http/routes/_shared', () => ({
  analytics: { track: (...args: unknown[]) => track(...args) },
  RENDERER_ALLOWED_EVENTS: new Set(['home.view', 'home.chip.click']),
  electronApp: { getVersion: () => '0.0.0' },
  getEnabledAuthProviderConfigs: () => [],
}))

const { registerSystemRoutes } = await import('../../../../src/main/http/routes/system.routes')

async function report(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const app = express()
  app.use(express.json())
  registerSystemRoutes(app)
  const server = app.listen(0)
  try {
    const { port } = server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/api/analytics/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: response.status, json: await response.json() }
  } finally {
    server.close()
  }
}

describe('POST /api/analytics/report', () => {
  beforeEach(() => track.mockClear())

  it('keeps accepting a single report', async () => {
    const res = await report({ event: 'home.view', properties: { shell: 'narrow' } })
    expect(res.status).toBe(200)
    expect(track).toHaveBeenCalledWith('home.view', { shell: 'narrow' })
  })

  it('keeps the single-report answers older clients rely on', async () => {
    expect((await report({})).json).toEqual({ success: false, error: 'Missing event name' })
    expect((await report({ event: 'app.run.completed' })).status).toBe(403)
    expect(track).not.toHaveBeenCalled()
  })

  it('tracks every allowed report in a batch and skips the rest', async () => {
    const res = await report({
      events: [
        { event: 'home.view', properties: { shell: 'wide' } },
        { event: 'app.run.completed' },
        { event: 'home.chip.click' },
        { properties: {} },
        'not-a-report',
        { event: 'home.view', properties: ['not', 'an', 'object'] },
      ],
    })

    expect(res.json).toEqual({ success: true, data: { accepted: 2, rejected: 4 } })
    expect(track.mock.calls).toEqual([
      ['home.view', { shell: 'wide' }],
      ['home.chip.click', {}],
    ])
  })

  it('caps how many reports one request can carry', async () => {
    const events = Array.from({ length: 150 }, () => ({ event: 'home.view' }))
    const res = await report({ events })
    expect(res.json).toEqual({ success: true, data: { accepted: 100, rejected: 50 } })
  })
})
