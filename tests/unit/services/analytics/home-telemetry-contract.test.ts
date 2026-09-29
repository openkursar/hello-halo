/**
 * The home telemetry contract must reach the backend intact: every event
 * passes the renderer gate, and every declared property survives the
 * provider's sanitize pass. A property dropped here is dropped silently in
 * production, so this is the only place that catches it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../../../../src/main/services/proxy-fetch', () => ({
  proxyFetch: vi.fn(),
}))

import { proxyFetch } from '../../../../src/main/services/proxy-fetch'
import { TelemetryProvider } from '../../../../src/main/services/analytics/providers/telemetry'
import { RENDERER_ALLOWED_EVENTS } from '../../../../src/main/services/analytics/types'
import {
  HOME_EVENT_NAMES,
  homeEventWhitelist,
} from '../../../../src/shared/analytics/home-telemetry'

const mockFetch = proxyFetch as ReturnType<typeof vi.fn>

const context = {
  userId: 'user-001',
  appVersion: '1.0.0',
  platform: 'darwin' as NodeJS.Platform,
  arch: 'arm64',
  electronVersion: '29.0.0',
}

describe('home telemetry contract', () => {
  let provider: TelemetryProvider

  beforeEach(async () => {
    vi.useFakeTimers()
    mockFetch.mockResolvedValue({ ok: true, text: async () => '' })
    provider = new TelemetryProvider({ endpoint: 'https://telemetry.test.local', apiKey: 'k' })
    await provider.init('user-001')
  })

  afterEach(async () => {
    await provider.destroy()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('admits every contract event at the renderer gate', () => {
    const rejected = HOME_EVENT_NAMES.filter((event) => !RENDERER_ALLOWED_EVENTS.has(event))
    expect(rejected).toEqual([])
  })

  it('keeps every declared property of every contract event', async () => {
    for (const event of HOME_EVENT_NAMES) {
      const properties = Object.fromEntries(homeEventWhitelist(event).map((key) => [key, 'x']))
      await provider.track({ name: event, properties }, context)
    }
    await provider.destroy()

    const sent = mockFetch.mock.calls.flatMap(([, options]) => JSON.parse(options.body).events)
    expect(sent).toHaveLength(HOME_EVENT_NAMES.length)
    for (const { name, properties } of sent) {
      expect(Object.keys(properties).sort(), name).toEqual(homeEventWhitelist(name).sort())
    }
  })

  it('drops keys outside the contract', async () => {
    await provider.track(
      { name: 'home.chip.click', properties: { chip: 'generate_code', shell: 'wide', spaceName: 'secret' } },
      context
    )
    await provider.destroy()

    const [, options] = mockFetch.mock.calls[0]
    expect(JSON.parse(options.body).events[0].properties).toEqual({ chip: 'generate_code', shell: 'wide' })
  })
})
