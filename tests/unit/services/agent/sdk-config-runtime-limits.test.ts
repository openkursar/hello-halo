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
import type { MockInstance } from 'vitest'

// Newly reachable via ai-sources/manager.ts or mcp-manager.ts pulling in
// analytics.service.ts (which statically imports providers/baidu.ts's
// `BrowserWindow` from 'electron') — mock it out like every other test that
// touches this transitive chain, so this file's own module graph controls
// what it needs rather than the real telemetry provider stack.
vi.mock('../../../../src/main/services/analytics/analytics.service', () => ({
  analytics: { track: vi.fn(), trackErrorSurface: vi.fn() }
}))

import { resolveSdkRuntimeLimits } from '../../../../src/main/services/agent/sdk-config'
import { resolveGroupCredentials } from '../../../../src/main/services/agent/group-credentials'
import { getApiCredentials } from '../../../../src/main/services/agent/helpers'
import type { AIGroup, AISource } from '../../../../src/shared/types/ai-sources'
import type { ModelCapabilityOverride } from '../../../../src/shared/types/model-capabilities'

const state = vi.hoisted(() => ({ source: undefined as AISource | undefined }))

vi.mock('../../../../src/main/services/ai-sources', () => ({
  getAISourceManager: () => ({
    ensureInitialized: async () => {},
    getCurrentSourceConfig: () => state.source,
    getSourceConfig: () => state.source,
    ensureValidToken: async () => ({ success: true }),
    getBackendConfigForSource: () => ({
      sourceId: state.source!.id, model: state.source!.model,
      url: 'https://example.invalid/v1/messages', key: 'test-key', apiType: 'anthropic',
    }),
  }),
}))

describe('resolveSdkRuntimeLimits', () => {
  let warnSpy: MockInstance<Parameters<typeof console.warn>, void>

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

  it.each([true, false])('keeps the known output cap of a mixed group (known first: %s)', knownFirst => {
    const sources = ['known', 'unknown'].map(id => ({
      id, name: id, provider: 'custom', authType: 'api-key', apiKey: 'fixture',
      apiUrl: 'https://example.invalid', model: 'model', availableModels: [], createdAt: '', updatedAt: '',
    } satisfies AISource))
    const members = sources.map(source => ({ sourceId: source.id, modelId: source.model }))
    const group: AIGroup = {
      id: 'group', name: 'Mixed', strategy: 'priority', createdAt: '', updatedAt: '',
      members: knownFirst ? members : members.reverse(),
    }
    const credentials = resolveGroupCredentials(group, {
      readSource: id => sources.find(source => source.id === id) ?? null,
      capabilitiesOf: source => ({
        contextWindow: 200_000,
        maxOutputTokens: source.id === 'known' ? 8_192 : 64_000,
      }),
      credentialsGeneration: () => 1,
    })
    expect(resolveSdkRuntimeLimits(credentials.capabilities)).toEqual({
      maxOutputTokens: 8_192, autoCompactWindow: 200_000,
    })
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it.each<{
    name: string
    model: string
    override?: ModelCapabilityOverride
    catalog?: { contextWindow: number; maxOutputTokens: number }
    output: number
    context: number
  }>([
    { name: 'unknown model defaults', model: 'unknown-future-model', output: 64_000, context: 200_000 },
    { name: 'legacy model limits', model: 'gpt-4o', output: 16_384, context: 128_000 },
    { name: 'lower user override', model: 'unknown-future-model', override: { maxOutputTokens: 8_192, contextWindow: 100_000 }, output: 8_192, context: 100_000 },
    { name: 'higher user override', model: 'gpt-4o', override: { maxOutputTokens: 96_000, contextWindow: 500_000 }, output: 96_000, context: 500_000 },
    { name: 'lower catalog limits', model: 'unknown-future-model', catalog: { maxOutputTokens: 8_192, contextWindow: 128_000 }, output: 8_192, context: 128_000 },
  ])('carries $name from source resolution into runtime limits', async ({ model, override, catalog, output, context }) => {
    state.source = {
      id: 'test-source', name: 'Test source', provider: 'custom', authType: 'api-key',
      apiUrl: 'https://example.invalid/v1/messages', apiKey: 'test-key', model,
      createdAt: '2026-01-01', updatedAt: '2026-01-01',
      ...(override ? { modelOverrides: { [model]: override } } : {}),
      availableModels: catalog ? [{ id: model, name: model, capabilities: catalog }] : [],
    }
    const credentials = await getApiCredentials()
    expect(credentials.capabilities).toMatchObject({ maxOutputTokens: output, contextWindow: context })
    expect(resolveSdkRuntimeLimits(credentials.capabilities)).toEqual({ maxOutputTokens: output, autoCompactWindow: context })
    expect(warnSpy).toHaveBeenCalledTimes(output < 20_000 ? 1 : 0)
  })
})
