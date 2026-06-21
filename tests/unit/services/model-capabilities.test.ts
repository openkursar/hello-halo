/**
 * Unit tests for ModelCapabilitiesService.resolve().
 *
 * Invariants under test:
 *   - A `[1m]` model-id suffix (the user's explicit 1M context opt-in) raises
 *     the resolved contextWindow to 1M over preset/pattern/default values.
 *     Without this, the default 128K window is injected as
 *     CLAUDE_CODE_AUTO_COMPACT_WINDOW and Math.min-clamps the 1M intrinsic —
 *     the "UI shows 1M but compaction fires at ~99K" bug.
 *   - An explicit per-model contextWindow override still beats the suffix.
 *   - The generic `claude-` pattern covers new model families (fable, mythos)
 *     while `claude-haiku-` keeps its longer-prefix specialization.
 */

import { describe, expect, it } from 'vitest'
import { modelCapabilitiesService } from '../../../src/main/services/model-capabilities.service'

describe('explicit [1m] suffix opt-in', () => {
  it('raises an unknown model from built-in default to 1M', () => {
    const cap = modelCapabilitiesService.resolve('totally-unknown-model[1m]')
    expect(cap.contextWindow).toBe(1_000_000)
  })

  it('raises a pattern-matched model above its 200K preset', () => {
    const cap = modelCapabilitiesService.resolve('claude-sonnet-4-6[1m]')
    expect(cap.contextWindow).toBe(1_000_000)
  })

  it('is case-insensitive ([1M])', () => {
    const cap = modelCapabilitiesService.resolve('claude-opus-4-8[1M]')
    expect(cap.contextWindow).toBe(1_000_000)
  })

  it('does not lower an exact preset that already exceeds 1M semantics', () => {
    const cap = modelCapabilitiesService.resolve('claude-fable-5[1m]')
    expect(cap.contextWindow).toBe(1_000_000)
  })

  it('keeps non-[1m] models on their resolved window', () => {
    expect(modelCapabilitiesService.resolve('deepseek-chat').contextWindow).toBe(128_000)
    expect(modelCapabilitiesService.resolve('totally-unknown-model').contextWindow).toBe(128_000)
  })

  it('an explicit per-model contextWindow override beats the suffix', () => {
    const cap = modelCapabilitiesService.resolve('claude-sonnet-4-6[1m]', {
      'claude-sonnet-4-6[1m]': { contextWindow: 500_000 }
    })
    expect(cap.contextWindow).toBe(500_000)
  })

  it('an override of unrelated fields does not block the raise', () => {
    const cap = modelCapabilitiesService.resolve('claude-sonnet-4-6[1m]', {
      'claude-sonnet-4-6[1m]': { maxOutputTokens: 32_000 }
    })
    expect(cap.contextWindow).toBe(1_000_000)
    expect(cap.maxOutputTokens).toBe(32_000)
  })
})

describe('claude- generic pattern', () => {
  it('covers new model families without dedicated entries', () => {
    const cap = modelCapabilitiesService.resolve('claude-mythos-preview')
    expect(cap.contextWindow).toBe(200_000)
    expect(cap.provider).toBe('anthropic')
    expect(cap.thinking).toBe(true)
  })

  it('claude-haiku- keeps its longer-prefix specialization (thinking: false)', () => {
    const cap = modelCapabilitiesService.resolve('claude-haiku-9-9')
    expect(cap.contextWindow).toBe(200_000)
    expect(cap.thinking).toBe(false)
  })
})

describe('legacy claude-3 patterns', () => {
  // The generic `claude-` pattern advertises 64K output — far above what the
  // claude-3 generation accepts. Longer-prefix entries pin real limits so the
  // value injected as CLAUDE_CODE_MAX_OUTPUT_TOKENS is never rejected.
  it('claude-3 base generation caps output at 4096', () => {
    const cap = modelCapabilitiesService.resolve('claude-3-opus-20240229')
    expect(cap.maxOutputTokens).toBe(4096)
    expect(cap.contextWindow).toBe(200_000)
  })

  it('claude-3.5 caps output at 8192', () => {
    const cap = modelCapabilitiesService.resolve('claude-3-5-sonnet-20241022')
    expect(cap.maxOutputTokens).toBe(8192)
    expect(cap.vision).toBe(true)
  })

  it('claude-3.5 haiku is text-only', () => {
    const cap = modelCapabilitiesService.resolve('claude-3-5-haiku-20241022')
    expect(cap.maxOutputTokens).toBe(8192)
    expect(cap.vision).toBe(false)
  })

  it('claude-3.7 supports 64K output and thinking', () => {
    const cap = modelCapabilitiesService.resolve('claude-3-7-sonnet-20250219')
    expect(cap.maxOutputTokens).toBe(64_000)
    expect(cap.thinking).toBe(true)
  })
})
