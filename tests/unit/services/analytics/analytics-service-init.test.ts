/**
 * Regression test: AnalyticsService.init() must not throw in development mode.
 *
 * `init()`'s dev-mode skip branch reads the provider config to decide whether
 * a local telemetry endpoint override (`.env.local`) is present. It once
 * referenced a bare `PROVIDER_CONFIG` identifier that was never declared at
 * module scope — only inside `initProviders()`, a different function — so
 * every dev-mode launch (and any e2e run, which boots in dev mode) hit a
 * ReferenceError the instant `init()` was called. Production never executed
 * this branch (`is.dev` is false), so the bug shipped silently.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

import { analytics } from '../../../../src/main/services/analytics/analytics.service'

describe('AnalyticsService.init() in development mode', () => {
  it('resolves without throwing when no telemetry endpoint is configured', async () => {
    // product.json is absent in the test environment, so getTelemetryConfig()
    // returns undefined and the dev-skip condition's `.telemetry.endpoint`
    // access is exactly the expression that used to throw.
    await expect(analytics.init()).resolves.toBeUndefined()
    expect(analytics.initialized).toBe(false)
  })
})
