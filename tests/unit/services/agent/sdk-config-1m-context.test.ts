/**
 * applyCC1mContextUnlock: decorates only the SDK-facing model id; the wire
 * id encoded into the API key stays clean. Without the suffix, CC clamps
 * unknown-model windows to its 200K default and the user's configured
 * contextWindow is silently truncated.
 */

import { describe, expect, it, vi } from 'vitest'

// Newly reachable via ai-sources/manager.ts or mcp-manager.ts pulling in
// analytics.service.ts (which statically imports providers/baidu.ts's
// `BrowserWindow` from 'electron') — mock it out like every other test that
// touches this transitive chain, so this file's own module graph controls
// what it needs rather than the real telemetry provider stack.
vi.mock('../../../../src/main/services/analytics/analytics.service', () => ({
  analytics: { track: vi.fn(), trackErrorSurface: vi.fn() }
}))

import { applyCC1mContextUnlock } from '../../../../src/main/services/agent/sdk-config'

describe('applyCC1mContextUnlock', () => {
  it('appends [1m] when contextWindow exceeds CC default (200K)', () => {
    expect(
      applyCC1mContextUnlock('deepseek-v4-flash', {
        maxOutputTokens: 64_000,
        contextWindow: 500_000,
      })
    ).toBe('deepseek-v4-flash[1m]')
  })

  it('does not append when contextWindow equals CC default (200K)', () => {
    // Exactly 200K is the CC default — appending would be a no-op for
    // intrinsic but still expand the unaudited [1m] surface unnecessarily.
    expect(
      applyCC1mContextUnlock('claude-sonnet-4', {
        maxOutputTokens: 64_000,
        contextWindow: 200_000,
      })
    ).toBe('claude-sonnet-4')
  })

  it('does not append when contextWindow is below CC default', () => {
    expect(
      applyCC1mContextUnlock('local-llama-3', {
        maxOutputTokens: 4_096,
        contextWindow: 32_768,
      })
    ).toBe('local-llama-3')
  })

  it('is idempotent when the model already ends with [1m]', () => {
    // Legacy workflow: user typed `[1m]` directly into their model id for
    // Anthropic direct 1M beta. Don't double-append.
    expect(
      applyCC1mContextUnlock('claude-sonnet-4[1m]', {
        maxOutputTokens: 64_000,
        contextWindow: 1_000_000,
      })
    ).toBe('claude-sonnet-4[1m]')
  })

  it('is idempotent for case variants like [1M]', () => {
    expect(
      applyCC1mContextUnlock('claude-sonnet-4[1M]', {
        maxOutputTokens: 64_000,
        contextWindow: 1_000_000,
      })
    ).toBe('claude-sonnet-4[1M]')
  })

  it('does not append when capabilities are undefined (legacy callers)', () => {
    // api-validator and other callers build credentials without resolved
    // capabilities; behavior must match today exactly — no decoration.
    expect(applyCC1mContextUnlock('deepseek-v4-flash', undefined)).toBe('deepseek-v4-flash')
  })

  it('does not append when contextWindow is NaN or non-finite', () => {
    expect(
      applyCC1mContextUnlock('deepseek-v4-flash', {
        maxOutputTokens: 64_000,
        contextWindow: Number.NaN,
      })
    ).toBe('deepseek-v4-flash')
    expect(
      applyCC1mContextUnlock('deepseek-v4-flash', {
        maxOutputTokens: 64_000,
        contextWindow: Number.POSITIVE_INFINITY,
      })
    ).toBe('deepseek-v4-flash')
  })

  it('returns empty input unchanged (defensive against missing model id)', () => {
    expect(
      applyCC1mContextUnlock('', {
        maxOutputTokens: 64_000,
        contextWindow: 500_000,
      })
    ).toBe('')
  })

  it('handles edge value 200_001 — strictly greater than CC default', () => {
    // The boundary is strict `>`, not `>=`, so the first value above the
    // default trips the unlock. Documents the exact contract.
    expect(
      applyCC1mContextUnlock('custom-large', {
        maxOutputTokens: 64_000,
        contextWindow: 200_001,
      })
    ).toBe('custom-large[1m]')
  })

  it('matches DeepSeek-Chat preset (131K) — no unlock needed', () => {
    // Real-world preset from model-capabilities.json; CC's default already
    // covers it, so no [1m] decoration.
    expect(
      applyCC1mContextUnlock('deepseek-chat', {
        maxOutputTokens: 64_000,
        contextWindow: 131_072,
      })
    ).toBe('deepseek-chat')
  })

  it('matches a 1M custom model — unlock fires', () => {
    // User configures a third-party 1M context model. Without the unlock,
    // CC would clamp to 200K and the user's 1M setting would be invisible.
    expect(
      applyCC1mContextUnlock('zai-org/GLM-4.7-1M', {
        maxOutputTokens: 64_000,
        contextWindow: 1_000_000,
      })
    ).toBe('zai-org/GLM-4.7-1M[1m]')
  })
})
