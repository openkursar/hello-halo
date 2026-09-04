/**
 * Unit tests for sdk-config.resolveSdkRuntimeLimits — the pure resolver that
 * turns Halo's resolved model capabilities into CC subprocess env values.
 *
 * Behavior split (see shared/constants/model-runtime-limits.ts):
 *   - maxOutputTokens: hard floor = 1 (only catches 0/negative/NaN). Below the
 *     recommended floor (20_000) we WARN but pass the user's value through.
 *     The UI shows the same warning so going low is an explicit choice, not a
 *     silent override.
 *   - contextWindow: hard floor (40_000). Lower makes auto-compact fire every
 *     turn — a correctness failure, so still clamped silently.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// Newly reachable via ai-sources/manager.ts or mcp-manager.ts pulling in
// analytics.service.ts (which statically imports providers/baidu.ts's
// `BrowserWindow` from 'electron') — mock it out like every other test that
// touches this transitive chain, so this file's own module graph controls
// what it needs rather than the real telemetry provider stack.
vi.mock('../../../../src/main/services/analytics/analytics.service', () => ({
  analytics: { track: vi.fn(), trackErrorSurface: vi.fn() }
}))

import { resolveSdkRuntimeLimits } from '../../../../src/main/services/agent/sdk-config'

describe('resolveSdkRuntimeLimits', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('returns empty object when capabilities are undefined', () => {
    expect(resolveSdkRuntimeLimits(undefined)).toEqual({})
  })

  it('passes through values inside the safe range', () => {
    expect(
      resolveSdkRuntimeLimits({ maxOutputTokens: 64_000, contextWindow: 200_000 })
    ).toEqual({ maxOutputTokens: 64_000, autoCompactWindow: 200_000 })
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('passes low maxOutputTokens through and logs a WARN (no silent rewrite)', () => {
    // 8192 stays as 8192. The user explicitly chose this; the UI surfaces the
    // same warning so the consequence is visible.
    expect(
      resolveSdkRuntimeLimits({ maxOutputTokens: 8_192, contextWindow: 200_000 })
    ).toEqual({ maxOutputTokens: 8_192, autoCompactWindow: 200_000 })
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toContain('below recommended')
  })

  it('does NOT warn for values at or above the recommended floor', () => {
    resolveSdkRuntimeLimits({ maxOutputTokens: 20_000, contextWindow: 200_000 })
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('clamps contextWindow up to CONTEXT_WINDOW_HARD_MIN to keep autoCompactThreshold positive', () => {
    // A 32K window would make autoCompactThreshold negative once the
    // 20K summary reserve + 13K compact buffer is subtracted.
    expect(
      resolveSdkRuntimeLimits({ maxOutputTokens: 64_000, contextWindow: 32_768 })
    ).toMatchObject({ autoCompactWindow: 40_000 })
  })

  it('caps maxOutputTokens at MAX_OUTPUT_TOKENS_HARD_CAP (1M)', () => {
    expect(
      resolveSdkRuntimeLimits({ maxOutputTokens: 5_000_000, contextWindow: 200_000 })
    ).toMatchObject({ maxOutputTokens: 1_000_000 })
  })

  it('caps contextWindow at CONTEXT_WINDOW_HARD_CAP (2M)', () => {
    expect(
      resolveSdkRuntimeLimits({ maxOutputTokens: 64_000, contextWindow: 10_000_000 })
    ).toMatchObject({ autoCompactWindow: 2_000_000 })
  })

  it('rounds fractional inputs to integers', () => {
    expect(
      resolveSdkRuntimeLimits({ maxOutputTokens: 64_000.7, contextWindow: 200_000.3 })
    ).toEqual({ maxOutputTokens: 64_001, autoCompactWindow: 200_000 })
  })

  it('omits maxOutputTokens when the value is not a positive finite number', () => {
    expect(
      resolveSdkRuntimeLimits({ maxOutputTokens: 0, contextWindow: 200_000 })
    ).toEqual({ autoCompactWindow: 200_000 })
    expect(
      resolveSdkRuntimeLimits({ maxOutputTokens: Number.NaN, contextWindow: 200_000 })
    ).toEqual({ autoCompactWindow: 200_000 })
  })

  it('omits autoCompactWindow when the value is not a positive finite number', () => {
    expect(
      resolveSdkRuntimeLimits({ maxOutputTokens: 64_000, contextWindow: 0 })
    ).toEqual({ maxOutputTokens: 64_000 })
    expect(
      resolveSdkRuntimeLimits({ maxOutputTokens: 64_000, contextWindow: Number.NaN })
    ).toEqual({ maxOutputTokens: 64_000 })
  })

  it('matches Claude Sonnet 4.6 preset (200K context, 64K output)', () => {
    expect(
      resolveSdkRuntimeLimits({ maxOutputTokens: 64_000, contextWindow: 200_000 })
    ).toEqual({ maxOutputTokens: 64_000, autoCompactWindow: 200_000 })
  })

  it('matches DeepSeek-Chat preset (131K context) without forcing a too-low cap on output', () => {
    expect(
      resolveSdkRuntimeLimits({ maxOutputTokens: 64_000, contextWindow: 131_072 })
    ).toEqual({ maxOutputTokens: 64_000, autoCompactWindow: 131_072 })
  })
})
