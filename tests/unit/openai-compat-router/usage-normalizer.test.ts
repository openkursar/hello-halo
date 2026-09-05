/**
 * Tests for normalizeOpenAIInputTokens — the self-verifying OpenAI -> Anthropic
 * input_tokens normalization that fixes the GLM Coding Plan double-count
 * without assuming every provider that sends cache_read_input_tokens uses the
 * same (OpenAI-inclusive) convention.
 *
 * Classification is checked against the response's own total_tokens, never
 * against a provider name or allowlist:
 *   1. total_tokens === promptTokens + completionTokens            -> subtract
 *   2. total_tokens === promptTokens + completionTokens + cacheRead -> unchanged
 *   3. neither identity holds, or total_tokens is missing           -> unchanged (safe default)
 */

import { describe, expect, it, vi } from 'vitest'
import { normalizeOpenAIInputTokens } from '../../../src/main/openai-compat-router/utils/usage-normalizer'

describe('normalizeOpenAIInputTokens', () => {
  describe('branch 1: OpenAI-inclusive prompt_tokens (total_tokens = prompt + completion)', () => {
    it('subtracts cache_read_input_tokens — real numbers from the production incident', () => {
      expect(
        normalizeOpenAIInputTokens({
          promptTokens: 131186,
          completionTokens: 79,
          totalTokens: 131265, // 131186 + 79
          cacheReadTokens: 130304
        })
      ).toBe(882)
    })

    it('matches the other two real samples from the incident report', () => {
      expect(
        normalizeOpenAIInputTokens({
          promptTokens: 134982,
          completionTokens: 30, // total_tokens picked to satisfy the branch-1 identity
          totalTokens: 135012,
          cacheReadTokens: 121984
        })
      ).toBe(12998)
      expect(
        normalizeOpenAIInputTokens({
          promptTokens: 135007,
          completionTokens: 50,
          totalTokens: 135057,
          cacheReadTokens: 134080
        })
      ).toBe(927)
    })

    it('returns 0 when the entire prompt was cached', () => {
      expect(
        normalizeOpenAIInputTokens({
          promptTokens: 500,
          completionTokens: 10,
          totalTokens: 510,
          cacheReadTokens: 500
        })
      ).toBe(0)
    })
  })

  describe('branch 2: Anthropic-exclusive prompt_tokens (total_tokens = prompt + completion + cacheRead)', () => {
    it('leaves promptTokens unchanged — provider already reports the exclusive increment', () => {
      // Same real-world total context (882 + 130304 = 131186), but this time
      // the provider's prompt_tokens is already the exclusive increment and
      // total_tokens accounts for cache_read_input_tokens separately.
      expect(
        normalizeOpenAIInputTokens({
          promptTokens: 882,
          completionTokens: 79,
          totalTokens: 131265, // 882 + 79 + 130304
          cacheReadTokens: 130304
        })
      ).toBe(882)
    })
  })

  describe('branch 3: unclassifiable — safe no-op', () => {
    it('leaves promptTokens unchanged when total_tokens is missing entirely', () => {
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
      expect(
        normalizeOpenAIInputTokens({
          promptTokens: 131186,
          completionTokens: 79,
          totalTokens: undefined,
          cacheReadTokens: 130304,
          providerLabel: 'unknown-provider'
        })
      ).toBe(131186)
      expect(debugSpy).toHaveBeenCalledOnce()
      expect(debugSpy.mock.calls[0][0]).toContain('unknown-provider')
      debugSpy.mockRestore()
    })

    it('leaves promptTokens unchanged when total_tokens matches neither identity', () => {
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
      expect(
        normalizeOpenAIInputTokens({
          promptTokens: 131186,
          completionTokens: 79,
          totalTokens: 999999, // matches neither prompt+completion nor prompt+completion+cacheRead
          cacheReadTokens: 130304
        })
      ).toBe(131186)
      expect(debugSpy).toHaveBeenCalledOnce()
      debugSpy.mockRestore()
    })

    it('falls back to branch 3 (never subtracts into a negative) when cacheReadTokens exceeds promptTokens, even if total_tokens numerically satisfies the branch-1 identity', () => {
      // Self-contradictory payload: cache_read_input_tokens can't exceed the
      // prompt it was read from, so this usage doesn't self-confirm the
      // OpenAI-inclusive convention even though prompt+completion === total.
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
      expect(
        normalizeOpenAIInputTokens({
          promptTokens: 100,
          completionTokens: 20,
          totalTokens: 120, // === 100 + 20, would satisfy branch 1 if cacheReadTokens were valid
          cacheReadTokens: 150
        })
      ).toBe(100)
      expect(debugSpy).toHaveBeenCalledOnce()
      debugSpy.mockRestore()
    })
  })

  describe('no-op paths (no classification needed)', () => {
    it('is a no-op when cacheReadTokens is undefined — the common case for the overwhelming majority of providers', () => {
      expect(
        normalizeOpenAIInputTokens({
          promptTokens: 1000,
          completionTokens: 20,
          totalTokens: 1020,
          cacheReadTokens: undefined
        })
      ).toBe(1000)
    })

    it('is a no-op when cacheReadTokens is 0', () => {
      expect(
        normalizeOpenAIInputTokens({
          promptTokens: 1000,
          completionTokens: 20,
          totalTokens: 1020,
          cacheReadTokens: 0
        })
      ).toBe(1000)
    })

    it('passes promptTokens through unchanged (including undefined) when promptTokens itself is undefined', () => {
      expect(
        normalizeOpenAIInputTokens({
          promptTokens: undefined,
          completionTokens: 20,
          totalTokens: 1020,
          cacheReadTokens: 500
        })
      ).toBeUndefined()
    })
  })
})
