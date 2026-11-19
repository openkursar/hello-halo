/**
 * Server-mode telemetry, and that the desktop is left exactly as it was.
 *
 * In server mode the events are attributed to the deployment (the container
 * hostname) instead of the per-install UUID on disk, the snapshot watermarks in
 * the same record survive that substitution (losing them re-sends
 * already-forwarded runs), the context says `runtimeMode: 'server'`, and the
 * telemetry backend may come from HALO_TELEMETRY_* at deploy time. On the
 * desktop none of that applies: the persisted UUID stays, no `runtimeMode` is
 * sent, and the environment variables are ignored.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { hostname } from 'os'
import { writeFileSync } from 'fs'
import { join } from 'path'
import type { AnalyticsConfig, UserContext } from '../../../../src/main/services/analytics/types'

// The real module imports BrowserWindow from electron, which resolves to the
// native binding (a path string under ELECTRON_RUN_AS_NODE) because vitest does
// not apply the electron mock inside externalized dependencies.
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

const { createTelemetryProvider } = vi.hoisted(() => ({
  createTelemetryProvider: vi.fn(() => ({ name: 'telemetry', initialized: false, init: vi.fn(async () => {}) })),
}))
vi.mock('../../../../src/main/services/analytics/providers/telemetry', () => ({ createTelemetryProvider }))

import { analytics } from '../../../../src/main/services/analytics/analytics.service'

type Internals = {
  config: AnalyticsConfig | null
  loadOrCreateConfig(): AnalyticsConfig
  buildUserContext(): UserContext
  initProviders(): Promise<void>
  providers: unknown[]
}
const internals = analytics as unknown as Internals

function seedConfig(analyticsConfig: AnalyticsConfig): void {
  const configPath = join(globalThis.__HALO_TEST_DIR__, '.halo', 'config.json')
  writeFileSync(configPath, JSON.stringify({ analytics: analyticsConfig }), 'utf-8')
}

afterEach(() => {
  delete process.env.HALO_SERVER_MODE
  delete process.env.HALO_TELEMETRY_ENDPOINT
  delete process.env.HALO_TELEMETRY_API_KEY
  createTelemetryProvider.mockClear()
  internals.providers = []
})

describe('telemetry identity', () => {
  it('uses the hostname as userId in server mode', () => {
    seedConfig({ userId: 'disk-uuid-0001', lastVersion: '0.9.0' })
    process.env.HALO_SERVER_MODE = '1'

    const config = internals.loadOrCreateConfig()

    expect(config.userId).toBe(hostname())
    expect(config.lastVersion).toBe('1.0.0-test')
  })

  it('keeps the snapshot watermarks when overriding userId', () => {
    seedConfig({
      userId: 'disk-uuid-0001',
      lastVersion: '0.9.0',
      lastSnapshotRunId: 'run-42',
      lastSnapshotTs: 1_700_000_000_000,
    })
    process.env.HALO_SERVER_MODE = '1'

    const config = internals.loadOrCreateConfig()

    expect(config.lastSnapshotRunId).toBe('run-42')
    expect(config.lastSnapshotTs).toBe(1_700_000_000_000)
  })

  it('keeps the persisted userId on the desktop', () => {
    seedConfig({ userId: 'disk-uuid-0001', lastVersion: '0.9.0' })

    expect(internals.loadOrCreateConfig().userId).toBe('disk-uuid-0001')
  })
})

describe('runtimeMode in the event context', () => {
  it('is "server" in server mode', () => {
    process.env.HALO_SERVER_MODE = '1'
    internals.config = { userId: 'x', lastVersion: '1.0.0' }
    expect(internals.buildUserContext().runtimeMode).toBe('server')
  })

  it('is absent on the desktop, so desktop events are unchanged', () => {
    internals.config = { userId: 'x', lastVersion: '1.0.0' }
    expect('runtimeMode' in internals.buildUserContext()).toBe(false)
  })
})

describe('telemetry backend from the environment', () => {
  it('is taken from HALO_TELEMETRY_* in server mode', async () => {
    process.env.HALO_SERVER_MODE = '1'
    process.env.HALO_TELEMETRY_ENDPOINT = 'https://telemetry.example.test'
    process.env.HALO_TELEMETRY_API_KEY = 'example-key'
    internals.config = { userId: 'x', lastVersion: '1.0.0' }

    await internals.initProviders()

    expect(createTelemetryProvider).toHaveBeenCalledWith('https://telemetry.example.test', 'example-key', [])
  })

  it('is ignored on the desktop', async () => {
    process.env.HALO_TELEMETRY_ENDPOINT = 'https://telemetry.example.test'
    process.env.HALO_TELEMETRY_API_KEY = 'example-key'
    internals.config = { userId: 'x', lastVersion: '1.0.0' }

    await internals.initProviders()

    expect(createTelemetryProvider).toHaveBeenCalledWith('', '', [])
  })
})
