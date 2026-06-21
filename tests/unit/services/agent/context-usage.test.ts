/**
 * Unit tests for context-usage — the engine-agnostic reproduction of
 * claude-code's `/context` headline number.
 *
 * Invariants under test:
 *   - Synthetic assistant messages (interrupt/cancel/reject, or model
 *     '<synthetic>') are excluded so they never overwrite the last real usage
 *     (the root cause of the input=2/cache=0 misreport).
 *   - Current context size = input + cache_creation + cache_read, EXCLUDING
 *     output_tokens (matches analyzeContextUsage's totalFromAPI).
 *   - Context window mirrors getContextWindowForModel: [1m] → 1M, known table
 *     entry → its window, unknown → 200K default.
 */

import { describe, expect, it } from 'vitest'
import {
  isSyntheticAssistantMessage,
  extractRealAssistantUsage,
  computeContextUsed,
  resolveContextWindow,
  buildTokenUsage
} from '../../../../src/main/services/agent/context-usage'

const realAssistant = (usage: Record<string, number>, model = 'claude-opus-4-6') => ({
  type: 'assistant',
  message: { model, content: [{ type: 'text', text: 'hello' }], usage }
})

describe('isSyntheticAssistantMessage', () => {
  it('flags the synthetic model id', () => {
    expect(isSyntheticAssistantMessage({ message: { model: '<synthetic>', content: [] } })).toBe(true)
  })

  it('flags interrupt/cancel/reject text in the first block', () => {
    for (const text of [
      '[Request interrupted by user]',
      '[Request interrupted by user for tool use]',
      'No response requested.'
    ]) {
      expect(
        isSyntheticAssistantMessage({ message: { model: 'claude', content: [{ type: 'text', text }] } })
      ).toBe(true)
    }
  })

  it('does not flag a normal assistant message', () => {
    expect(isSyntheticAssistantMessage(realAssistant({ input_tokens: 10 }))).toBe(false)
  })
})

describe('extractRealAssistantUsage', () => {
  it('returns mapped usage for a real message', () => {
    expect(
      extractRealAssistantUsage(
        realAssistant({
          input_tokens: 600,
          output_tokens: 400,
          cache_read_input_tokens: 50_750,
          cache_creation_input_tokens: 0
        })
      )
    ).toEqual({
      inputTokens: 600,
      outputTokens: 400,
      cacheReadTokens: 50_750,
      cacheCreationTokens: 0
    })
  })

  it('returns null for synthetic messages so the last real value is kept', () => {
    expect(
      extractRealAssistantUsage({
        type: 'assistant',
        message: { model: '<synthetic>', content: [], usage: { input_tokens: 2, output_tokens: 167 } }
      })
    ).toBeNull()
  })

  it('returns null when usage is absent', () => {
    expect(extractRealAssistantUsage({ message: { model: 'claude', content: [] } })).toBeNull()
  })

  it('skips all-zero placeholder records so they never zero out context size', () => {
    expect(
      extractRealAssistantUsage(realAssistant({ input_tokens: 0, output_tokens: 0 }))
    ).toBeNull()
    // ...but a cache-only response (input 0, big cache_read) is real and kept.
    expect(
      extractRealAssistantUsage(
        realAssistant({ input_tokens: 2, output_tokens: 164, cache_read_input_tokens: 202_761 })
      )
    ).toEqual({ inputTokens: 2, outputTokens: 164, cacheReadTokens: 202_761, cacheCreationTokens: 0 })
  })
})

describe('computeContextUsed', () => {
  it('sums input + cache_creation + cache_read, excluding output', () => {
    expect(
      computeContextUsed({
        inputTokens: 2_000,
        outputTokens: 300,
        cacheReadTokens: 41_200,
        cacheCreationTokens: 0
      })
    ).toBe(43_200)
  })
})

describe('resolveContextWindow', () => {
  it('returns 1M for a [1m]-suffixed model', () => {
    expect(resolveContextWindow('claude-opus-4-6[1m]')).toBe(1_000_000)
  })

  it('falls back to 200K for an unknown model', () => {
    expect(resolveContextWindow('totally-unknown-model-xyz')).toBe(200_000)
  })
})

describe('buildTokenUsage', () => {
  it('uses the last real usage + cost + resolved window, no cumulative mixing', () => {
    const usage = {
      inputTokens: 600,
      outputTokens: 400,
      cacheReadTokens: 50_750,
      cacheCreationTokens: 0
    }
    const result = buildTokenUsage({ total_cost_usd: 2.86 }, usage, 'totally-unknown-model-xyz')
    expect(result).toEqual({
      ...usage,
      totalCostUsd: 2.86,
      contextWindow: 200_000
    })
    // Numerator the UI renders = 600 + 0 + 50_750 = 51_350 (NOT inflated by output).
    expect(computeContextUsed(result!)).toBe(51_350)
  })

  it('falls back to the result frame usage when no per-call usage was captured', () => {
    const result = buildTokenUsage(
      { total_cost_usd: 0.5, usage: { input_tokens: 22_700, output_tokens: 50, cache_read_input_tokens: 0 } },
      null,
      'totally-unknown-model-xyz'
    )
    expect(result).toEqual({
      inputTokens: 22_700,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: 0.5,
      contextWindow: 200_000
    })
  })

  it('returns null when neither per-call nor result usage exists', () => {
    expect(buildTokenUsage({ total_cost_usd: 1 }, null, 'claude')).toBeNull()
    expect(buildTokenUsage({ total_cost_usd: 1, usage: { input_tokens: 0, output_tokens: 0 } }, null, 'claude')).toBeNull()
  })
})
