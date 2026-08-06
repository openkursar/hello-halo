/**
 * Engine resolution at startup.
 *
 * `initSdk()` is awaited before the main window is created, so anything it
 * throws takes down the whole bootstrap — no window, no IPC handlers, and no
 * way for the user to fix the setting that caused it. These tests pin the
 * contract that replaced that behavior: pick a runnable engine, record the
 * degradation, and never reject.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { EngineAvailability } from '../../../../src/main/services/agent/engine-availability'

let configuredEngine: unknown = 'anthropic'
let availability: EngineAvailability[] = []

function engines(overrides: Partial<Record<'anthropic' | 'halo' | 'codex', boolean>>): EngineAvailability[] {
  return (['anthropic', 'halo', 'codex'] as const).map(engineId => ({
    engineId,
    available: overrides[engineId] ?? false,
    version: overrides[engineId] ? '1.0.0' : '',
    fingerprint: overrides[engineId] ? 'abcdef123456' : '',
  }))
}

vi.mock('../../../../src/main/foundation/config.service', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, getConfig: () => ({ agent: { sdkEngine: configuredEngine } }) }
})

vi.mock('../../../../src/main/services/agent/engine-availability', () => ({
  getEngineAvailability: async () => availability,
}))

// The CC SDK is the fallback target in every degraded case; a stub keeps the
// test off the real 600KB module.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: () => undefined,
  createSdkMcpServer: () => undefined,
  query: () => undefined,
}))

async function initFresh() {
  vi.resetModules()
  const sdk = await import('../../../../src/main/services/agent/resolved-sdk')
  await sdk.initSdk()
  return sdk
}

describe('startup engine resolution', () => {
  beforeEach(() => {
    configuredEngine = 'anthropic'
    availability = engines({ anthropic: true })
  })

  afterEach(() => {
    vi.resetModules()
  })

  it('loads the configured engine when this build carries it', async () => {
    const sdk = await initFresh()

    expect(sdk.isInitialized()).toBe(true)
    expect(sdk.getActiveEngine()).toBe('anthropic')
    expect(sdk.getDegradedFromEngine()).toBeNull()
  })

  it('degrades to an available engine when the configured one did not ship', async () => {
    configuredEngine = 'halo'
    availability = engines({ anthropic: true })

    const sdk = await initFresh()

    expect(sdk.isInitialized()).toBe(true)
    expect(sdk.getActiveEngine()).toBe('anthropic')
    expect(sdk.getDegradedFromEngine()).toBe('halo')
  })

  it('resolves without throwing when no engine is available', async () => {
    configuredEngine = 'halo'
    availability = engines({})

    const sdk = await initFresh()

    expect(sdk.isInitialized()).toBe(false)
    expect(sdk.getActiveEngine()).toBeNull()
  })

  it('falls back to anthropic for an unrecognised configured engine', async () => {
    configuredEngine = 'not-an-engine'
    availability = engines({ anthropic: true })

    const sdk = await initFresh()

    expect(sdk.getActiveEngine()).toBe('anthropic')
    // The stored value never named a real engine, so there is nothing to report
    // as degraded — it was normalised, not downgraded.
    expect(sdk.getDegradedFromEngine()).toBeNull()
  })

  it('leaves the stored engine setting untouched when degrading', async () => {
    configuredEngine = 'halo'
    availability = engines({ anthropic: true })

    const sdk = await initFresh()

    expect(sdk.getActiveEngine()).toBe('anthropic')
    expect(configuredEngine).toBe('halo')
  })
})
