/**
 * Tests for wire-usage normalization.
 *
 * Contract under test: the internal usage is always Anthropic-shaped, so
 * `input + cacheRead + cacheCreation` must equal what the upstream actually
 * charged for the prompt — never more (OpenAI's inclusive `prompt_tokens`
 * double-counting cache hits) and never less. Exactly one cache-hit field is
 * ever consumed, so standard and Anthropic-named spellings can never be summed.
 */

import { describe, expect, it } from 'vitest'

import {
  createEmptyUsage,
  normalizeAnthropicUsage,
  normalizeOpenAIUsage
} from '../../../src/main/openai-compat-router/converters/response/usage'

/** Prompt total the upstream charged for, in the internal (Anthropic) shape. */
function promptTotal(usage: { inputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens
}

describe('normalizeOpenAIUsage', () => {
  it('returns null when the upstream reported no usage', () => {
    expect(normalizeOpenAIUsage(undefined)).toBeNull()
    expect(normalizeOpenAIUsage(null)).toBeNull()
  })

  it('splits an inclusive prompt_tokens into increment + cache hit', () => {
    const usage = normalizeOpenAIUsage({
      prompt_tokens: 131186,
      completion_tokens: 79,
      prompt_tokens_details: { cached_tokens: 130304 }
    })!

    expect(usage.inputTokens).toBe(882)
    expect(usage.cacheReadTokens).toBe(130304)
    expect(usage.outputTokens).toBe(79)
    // The whole point: the prompt is counted once, not 131186 + 130304.
    expect(promptTotal(usage)).toBe(131186)
  })

  it('accepts the Anthropic-named cache field inside an OpenAI body', () => {
    const usage = normalizeOpenAIUsage({
      prompt_tokens: 131186,
      completion_tokens: 79,
      cache_read_input_tokens: 130304
    })!

    expect(usage.inputTokens).toBe(882)
    expect(usage.cacheReadTokens).toBe(130304)
    expect(promptTotal(usage)).toBe(131186)
  })

  it('prefers the OpenAI standard field and never sums the two spellings', () => {
    const usage = normalizeOpenAIUsage({
      prompt_tokens: 1000,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 600 },
      cache_read_input_tokens: 900
    })!

    expect(usage.cacheReadTokens).toBe(600)
    expect(usage.inputTokens).toBe(400)
    expect(promptTotal(usage)).toBe(1000)
  })

  it('treats a prompt total smaller than the cache hit as already exclusive', () => {
    // Observed on the halo-cloud gateway: an OpenAI body carrying Anthropic
    // semantics. Subtracting here would drive the increment negative.
    const usage = normalizeOpenAIUsage({
      prompt_tokens: 772,
      completion_tokens: 28,
      cache_read_input_tokens: 139648
    })!

    expect(usage.inputTokens).toBe(772)
    expect(usage.cacheReadTokens).toBe(139648)
    expect(promptTotal(usage)).toBe(140420)
  })

  it('reads the Responses API field spellings', () => {
    const usage = normalizeOpenAIUsage({
      input_tokens: 5000,
      output_tokens: 120,
      input_tokens_details: { cached_tokens: 4096 }
    })!

    expect(usage.inputTokens).toBe(904)
    expect(usage.cacheReadTokens).toBe(4096)
    expect(usage.outputTokens).toBe(120)
  })

  it('keeps a fully cache-hit prompt at zero increment', () => {
    const usage = normalizeOpenAIUsage({
      prompt_tokens: 4096,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 4096 }
    })!

    expect(usage.inputTokens).toBe(0)
    expect(promptTotal(usage)).toBe(4096)
  })

  it('passes cache creation through untouched — OpenAI has no counterpart', () => {
    const usage = normalizeOpenAIUsage({
      prompt_tokens: 1000,
      completion_tokens: 10,
      cache_read_input_tokens: 600,
      cache_creation_input_tokens: 250
    })!

    expect(usage.cacheCreationTokens).toBe(250)
    expect(usage.inputTokens).toBe(400)
  })

  it('collapses missing, negative and non-finite counts to zero', () => {
    const usage = normalizeOpenAIUsage({
      prompt_tokens: Number.NaN,
      completion_tokens: -5,
      cache_read_input_tokens: Number.POSITIVE_INFINITY
    })!

    expect(usage).toEqual(createEmptyUsage())
  })

  it('handles a plain OpenAI body with no cache reporting at all', () => {
    const usage = normalizeOpenAIUsage({ prompt_tokens: 2048, completion_tokens: 64 })!

    expect(usage.inputTokens).toBe(2048)
    expect(usage.cacheReadTokens).toBe(0)
    expect(usage.cacheCreationTokens).toBe(0)
  })
})

describe('normalizeAnthropicUsage', () => {
  it('returns null when the upstream reported no usage', () => {
    expect(normalizeAnthropicUsage(undefined)).toBeNull()
  })

  it('takes input_tokens as an increment — no cache subtraction', () => {
    const usage = normalizeAnthropicUsage({
      input_tokens: 882,
      output_tokens: 79,
      cache_read_input_tokens: 130304,
      cache_creation_input_tokens: 1024
    })!

    expect(usage.inputTokens).toBe(882)
    expect(usage.cacheReadTokens).toBe(130304)
    expect(usage.cacheCreationTokens).toBe(1024)
    expect(promptTotal(usage)).toBe(132210)
  })
})
