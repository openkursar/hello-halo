/**
 * Unit tests for effort → engine thinking options.
 *
 * Two failure modes these guard against, both silent at compile time because
 * the SDK option bags are untyped records:
 *   - a level outside an engine's own enum reaching that engine
 *   - the default level drifting, which changes cost and latency for every
 *     user who never opened Model Config
 */

import { describe, it, expect } from 'vitest'
import {
  applyReasoningEffort,
  applySessionReasoningEffort,
  resolveAnthropicEffort,
  resolveCodexReasoningEffort,
  resolveRequestEffort,
  resolveThinkingBudget,
} from '../../../../src/main/services/agent/reasoning-effort'
import {
  MIN_ANSWER_TOKENS,
  REASONING_EFFORT_LEVELS,
} from '../../../../src/shared/constants/reasoning-effort'

/** `EffortLevel` in @anthropic-ai/claude-agent-sdk. */
const ANTHROPIC_ENUM = ['low', 'medium', 'high', 'max']
/** `ModelReasoningEffort` in @openai/codex-sdk. */
const CODEX_ENUM = ['minimal', 'low', 'medium', 'high', 'xhigh']

const caps = (maxOutputTokens: number, reasoningEffort?: string) =>
  ({ maxOutputTokens, contextWindow: 200_000, reasoningEffort })

describe('resolveRequestEffort', () => {
  it('reports off while the Deep Thinking toggle is off', () => {
    expect(resolveRequestEffort(false, 'max')).toBe('off')
    expect(resolveRequestEffort(undefined, 'max')).toBe('off')
  })

  it('uses the configured level when the toggle is on', () => {
    expect(resolveRequestEffort(true, 'low')).toBe('low')
  })

  it('defaults to the budget Halo used before the ladder existed', () => {
    expect(resolveThinkingBudget(resolveRequestEffort(true, undefined), undefined)).toBe(10_240)
  })
})

describe('resolveThinkingBudget', () => {
  it('scales with the level', () => {
    expect(resolveThinkingBudget('low', 64_000)).toBeLessThan(
      resolveThinkingBudget('max', 64_000)!
    )
  })

  it('returns null when the model should not think', () => {
    expect(resolveThinkingBudget('off', 64_000)).toBeNull()
  })

  it('leaves room for the answer inside the shared output limit', () => {
    expect(resolveThinkingBudget('max', 8_192)).toBe(8_192 - MIN_ANSWER_TOKENS)
  })

  it('disables thinking when the output limit leaves no room for it', () => {
    expect(resolveThinkingBudget('max', 4_096)).toBeNull()
  })

  it('falls back to the default level for a passthrough value', () => {
    expect(resolveThinkingBudget('ultra', 64_000)).toBe(resolveThinkingBudget('high', 64_000))
  })
})

describe('resolveAnthropicEffort', () => {
  it('never emits a value outside the SDK enum', () => {
    for (const level of REASONING_EFFORT_LEVELS) {
      const value = resolveAnthropicEffort(level)
      if (value !== undefined) expect(ANTHROPIC_ENUM).toContain(value)
    }
    expect(ANTHROPIC_ENUM).toContain(resolveAnthropicEffort('ultra'))
  })

  it('steps Codex-only levels onto the nearest Anthropic one', () => {
    expect(resolveAnthropicEffort('minimal')).toBe('low')
    expect(resolveAnthropicEffort('xhigh')).toBe('high')
  })

  it('omits the option when the model should not think', () => {
    expect(resolveAnthropicEffort('off')).toBeUndefined()
  })
})

describe('resolveCodexReasoningEffort', () => {
  it('never emits a value outside the Codex enum', () => {
    for (const level of REASONING_EFFORT_LEVELS) {
      expect(CODEX_ENUM).toContain(resolveCodexReasoningEffort(level))
    }
    expect(CODEX_ENUM).toContain(resolveCodexReasoningEffort('ultra'))
  })

  it('steps max down, since Codex has no such level', () => {
    expect(resolveCodexReasoningEffort('max')).toBe('xhigh')
  })

  it('substitutes the cheapest level, since Codex cannot stop reasoning', () => {
    expect(resolveCodexReasoningEffort('off')).toBe('low')
  })
})

describe('applyReasoningEffort', () => {
  it('writes the SDK option names alongside Halo\'s own level', () => {
    const sdkOptions: Record<string, any> = {}
    const budget = applyReasoningEffort(sdkOptions, true, caps(64_000, 'xhigh'))

    expect(sdkOptions.reasoningEffort).toBe('xhigh')
    expect(sdkOptions.effort).toBe('high')
    expect(sdkOptions.maxThinkingTokens).toBe(budget)
  })

  it('leaves the thinking options unset when the toggle is off', () => {
    const sdkOptions: Record<string, any> = {}
    expect(applyReasoningEffort(sdkOptions, false, caps(64_000))).toBeNull()

    expect(sdkOptions.reasoningEffort).toBe('off')
    expect(sdkOptions.effort).toBeUndefined()
    expect(sdkOptions.maxThinkingTokens).toBeUndefined()
  })
})

describe('applySessionReasoningEffort', () => {
  it('carries the depth a warmed session can no longer acquire later', () => {
    const sdkOptions: Record<string, any> = {}
    applySessionReasoningEffort(sdkOptions, caps(64_000, 'xhigh'))

    expect(sdkOptions.reasoningEffort).toBe('xhigh')
    expect(sdkOptions.effort).toBe('high')
  })

  it('leaves the budget to the per-turn setter', () => {
    const sdkOptions: Record<string, any> = {}
    applySessionReasoningEffort(sdkOptions, caps(64_000, 'max'))

    expect(sdkOptions.maxThinkingTokens).toBeUndefined()
  })

  it('falls back to the default level when the model configures none', () => {
    const sdkOptions: Record<string, any> = {}
    applySessionReasoningEffort(sdkOptions, caps(64_000))

    expect(sdkOptions.effort).toBe('high')
  })
})
