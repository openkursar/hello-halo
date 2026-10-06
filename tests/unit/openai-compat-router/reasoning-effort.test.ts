/**
 * Unit tests for reasoning effort resolution on the OpenAI-compatible wire.
 *
 * Guards three properties:
 *   - a level Halo inferred never becomes a value the upstream would reject
 *   - a level the user declared reaches the upstream untouched
 *   - the profile table is keyed on models Halo actually ships, so an entry
 *     cannot silently apply to nothing
 */

import { describe, it, expect } from 'vitest'
import {
  resolveReasoning,
  resolveReasoningEffortValue,
  isThinkingEffort,
} from '../../../src/main/openai-compat-router/converters/reasoning-effort'
import { reasoningEffortProfileById } from '../../../src/shared/constants/reasoning-effort-profiles'
import {
  clampReasoningEffort,
  inferReasoningEffortFromBudget,
  REASONING_EFFORT_THINKING_BUDGET,
} from '../../../src/shared/constants/reasoning-effort'
import presetData from '../../../src/shared/data/model-capabilities.json'

const enabled = (budget: number) => ({ type: 'enabled', budget_tokens: budget })
const adaptive = { type: 'adaptive' }
const disabled = { type: 'disabled' }

const shippedModelIds = [
  ...Object.keys(presetData.models),
  ...Object.keys(presetData.patterns ?? {}),
]

describe('inferReasoningEffortFromBudget', () => {
  it('round-trips every level budget', () => {
    for (const [level, budget] of Object.entries(REASONING_EFFORT_THINKING_BUDGET)) {
      expect(inferReasoningEffortFromBudget(budget)).toBe(level)
    }
  })

  it('treats a missing budget as thinking off', () => {
    expect(inferReasoningEffortFromBudget(null)).toBe('off')
    expect(inferReasoningEffortFromBudget(0)).toBe('off')
  })
})

describe('clampReasoningEffort', () => {
  it('steps down to the highest supported level', () => {
    expect(clampReasoningEffort('max', ['low', 'medium', 'high'])).toBe('high')
    expect(clampReasoningEffort('xhigh', ['low', 'high', 'max'])).toBe('high')
  })

  it('steps up when every supported level ranks higher', () => {
    expect(clampReasoningEffort('minimal', ['high', 'max'])).toBe('high')
  })
})

describe('reasoningEffortProfileById', () => {
  it('keeps every disable value reachable from a model Halo ships', () => {
    const reachable = shippedModelIds.filter(id => reasoningEffortProfileById(id).disableValue)
    expect(reachable.length).toBeGreaterThan(0)
  })

  it('matches proxy-prefixed wire ids', () => {
    expect(reasoningEffortProfileById('Pro/zai-org/GLM-5.3').disableValue)
      .toBe(reasoningEffortProfileById('glm-5.3').disableValue)
  })

  it('places no restriction on an unknown model', () => {
    expect(reasoningEffortProfileById('some-proxy-model')).toEqual({})
    expect(reasoningEffortProfileById(undefined)).toEqual({})
  })

  it('marks GLM-5/5.1/5-Turbo/4.7/4.6 as switched by thinking.type, not reasoning_effort', () => {
    // docs.bigmodel.cn: the field is documented from GLM-5.2 onward only.
    for (const id of ['glm-5', 'glm-5.1', 'glm-5-turbo', 'glm-4.7', 'glm-4.6', 'glm-4.5']) {
      expect(reasoningEffortProfileById(id).levels, id).toEqual([])
      expect(reasoningEffortProfileById(id).disableValue, id).toBeUndefined()
      expect(reasoningEffortProfileById(id).thinkingToggle, id).toBe(true)
    }
  })

  it('matches a Claude version exactly, so a newer minor never inherits an older rule', () => {
    expect(reasoningEffortProfileById('claude-opus-5').anthropic?.disableType).toBeUndefined()
    expect(reasoningEffortProfileById('claude-opus-5').disableValue).toBeUndefined()
    // Opus 5.5 cannot stop thinking; it must not read as Opus 5.
    expect(reasoningEffortProfileById('claude-opus-5-5').disableValue).toBe('low')
    expect(reasoningEffortProfileById('claude-sonnet-5-5').anthropic?.disableType).toBe('between_tools')
    expect(reasoningEffortProfileById('claude-opus-4-20250514').anthropic?.mode).toBe('budget')
    expect(reasoningEffortProfileById('claude-opus-4-6').anthropic?.mode).toBe('adaptive')
  })

  it('resolves dated, platform-prefixed and dotted Claude ids', () => {
    const opus46 = reasoningEffortProfileById('claude-opus-4-6')
    for (const id of ['anthropic/claude-opus-4.6', 'anthropic.claude-opus-4-6-v1:0', 'claude-opus-4-6@20260101']) {
      expect(reasoningEffortProfileById(id), id).toBe(opus46)
    }
    expect(reasoningEffortProfileById('claude-opus-5-5[1m]').disableValue).toBe('low')
  })

  it('holds OpenAI models to the ladder their model page documents', () => {
    const cases: Array<[string, string, string]> = [
      // [model, effort for a picked max, value for a picked off]
      ['gpt-6.1-sol', 'max', 'low'],
      ['gpt-6-astra', 'max', 'low'],
      ['gpt-6-sol', 'max', 'none'],
      ['openai/gpt-5.6-terra', 'max', 'none'],
      ['gpt-5.5', 'xhigh', 'none'],
      ['gpt-5.5-2026-04-23', 'xhigh', 'none'],
      ['gpt-5.4-mini', 'xhigh', 'none'],
      ['gpt-5.5-pro', 'xhigh', 'medium'],
      ['gpt-5-pro', 'high', 'high'],
      ['gpt-5.3-codex', 'xhigh', 'low'],
      ['gpt-5.1', 'high', 'none'],
      ['gpt-5-2025-08-07', 'high', 'minimal'],
      ['gpt-5-mini', 'high', 'minimal'],
      ['o3', 'high', 'low'],
      ['openai/o4-mini', 'high', 'low'],
    ]
    for (const [model, max, off] of cases) {
      expect(resolveReasoningEffortValue(adaptive, undefined, model, 'max'), model).toBe(max)
      expect(resolveReasoningEffortValue(adaptive, undefined, model, 'off'), model).toBe(off)
    }
  })

  it('keeps short o-series patterns out of unrelated ids', () => {
    for (const id of ['gpt-4o3', 'foo-o3-bar', 'o30-model', 'qwen3-o1x']) {
      expect(reasoningEffortProfileById(id), id).toEqual({})
    }
  })

  it('does not let a version pattern absorb a later two-digit version', () => {
    expect(reasoningEffortProfileById('gpt-5.10')).not.toBe(reasoningEffortProfileById('gpt-5.1'))
  })

  it('gives a Claude model newer than the table the current generation\'s controls', () => {
    const future = reasoningEffortProfileById('claude-opus-5-6')
    expect(future.anthropic).toEqual({ mode: 'adaptive', effort: true })
    // Whether it can stop thinking is unknown, so off runs at the lowest level.
    expect(future.disableValue).toBe('low')
  })

  it('gives GLM-5.2 the two effort tiers its API does not silently alias', () => {
    expect(reasoningEffortProfileById('glm-5.2').levels).toEqual(['high', 'max'])
    expect(reasoningEffortProfileById('glm-5.2').disableValue).toBe('none')
  })
})

describe('resolveReasoningEffortValue', () => {
  it('caps a Halo-inferred level at what any upstream accepts', () => {
    expect(resolveReasoningEffortValue(enabled(32_000), undefined, 'some-proxy-model'))
      .toBe('high')
  })

  it('forwards a declared level without clamping it', () => {
    expect(resolveReasoningEffortValue(enabled(10_240), 'max', 'some-proxy-model'))
      .toBe('max')
  })

  it('forwards a value outside the ladder so new provider levels work unshipped', () => {
    expect(resolveReasoningEffortValue(enabled(10_240), 'ultra', 'some-proxy-model'))
      .toBe('ultra')
  })

  it('omits the field when thinking is off', () => {
    expect(resolveReasoningEffortValue(disabled, undefined, 'gpt-4o')).toBeUndefined()
    expect(resolveReasoningEffortValue(undefined, undefined, 'gpt-4o')).toBeUndefined()
  })

  it('switches GLM-5/5.1/4.7 off through thinking.type — reasoning_effort is not in their API', () => {
    for (const [thinking, declared, model] of [
      [disabled, undefined, 'glm-5'],
      [enabled(32_000), 'off', 'glm-5.1'],
      [disabled, undefined, 'glm-4.7'],
    ] as const) {
      expect(resolveReasoning(thinking, declared, model), model).toEqual({ effort: undefined, disableThinking: true })
    }
  })

  it('switches DeepSeek off through thinking.type and leaves its effort mapping to DeepSeek', () => {
    expect(resolveReasoning(adaptive, undefined, 'deepseek-v4-pro', 'off'))
      .toEqual({ effort: undefined, disableThinking: true })
    expect(resolveReasoning(adaptive, undefined, 'deepseek-v4-pro', 'xhigh'))
      .toEqual({ effort: 'xhigh', disableThinking: false })
  })

  it('switches MiMo off through thinking.type and leaves thinking-on requests as they were', () => {
    // mimo.mi.com deep-thinking guide: thinking.type enabled|disabled, on by default.
    for (const model of ['mimo-v2.5', 'mimo-v2.6-pro', 'XiaomiMiMo/MiMo-V2.5-Pro']) {
      expect(resolveReasoning(adaptive, undefined, model, 'off'), model).toEqual({ effort: undefined, disableThinking: true })
      expect(resolveReasoning(disabled, undefined, model), model).toEqual({ effort: undefined, disableThinking: true })
      expect(resolveReasoning(adaptive, undefined, model, 'high'), model).toEqual({ effort: 'high', disableThinking: false })
    }
  })

  it('never sends a thinking toggle to a model that has none', () => {
    expect(resolveReasoning(disabled, undefined, 'gpt-4o').disableThinking).toBe(false)
    expect(resolveReasoning(adaptive, undefined, 'glm-5.2', 'off').disableThinking).toBe(false)
  })

  it('still forwards a user-declared value verbatim even where Halo infers nothing', () => {
    // "Sent to the provider as-is" is opt-in per Model Config; the model
    // family not supporting the field otherwise must not suppress it.
    expect(resolveReasoningEffortValue(enabled(10_240), 'max', 'glm-5')).toBe('max')
  })

  it('sends an explicit off to GLM-5.2, the earliest model reasoning_effort applies to', () => {
    expect(resolveReasoningEffortValue(disabled, undefined, 'glm-5.2')).toBe('none')
    expect(resolveReasoningEffortValue(enabled(32_000), 'off', 'glm-5.2')).toBe('none')
  })

  it('clamps GLM-5.2 to the two tiers that are not aliases of another tier', () => {
    expect(resolveReasoningEffortValue(enabled(5_120), undefined, 'glm-5.2')).toBe('high')
    expect(resolveReasoningEffortValue(enabled(2_048), undefined, 'glm-5.2')).toBe('high')
    expect(resolveReasoningEffortValue(enabled(32_000), undefined, 'glm-5.2')).toBe('max')
  })

  it('maps thinking-off to the lowest level for always-thinking models', () => {
    // glm-5.3 family rejects disable values outright — 400 with
    // "该模型始终思考，不支持关闭思考" — so "off" must land on low instead.
    expect(resolveReasoningEffortValue(disabled, undefined, 'glm-5.3-flash')).toBe('low')
    expect(resolveReasoningEffortValue(enabled(32_000), 'off', 'glm-5.3')).toBe('low')
    expect(resolveReasoningEffortValue(undefined, undefined, 'glm-5.3-flash')).toBe('low')
  })

  it('clamps inferred levels to the always-thinking ladder', () => {
    // Declared levels forward verbatim by design; only Halo-inferred ones
    // clamp, so medium/xhigh land on levels glm-5.3 actually accepts.
    expect(resolveReasoningEffortValue(enabled(5_120), undefined, 'glm-5.3')).toBe('low')
    expect(resolveReasoningEffortValue(enabled(10_240), undefined, 'glm-5.3-flash')).toBe('high')
    expect(resolveReasoningEffortValue(enabled(32_000), undefined, 'glm-5.3')).toBe('max')
    expect(resolveReasoningEffortValue(adaptive, undefined, 'glm-5.3-flash')).toBe('high')
  })

  it('keeps adaptive-mode requests thinking instead of collapsing them', () => {
    expect(resolveReasoningEffortValue(adaptive, undefined, 'some-proxy-model')).toBe('high')
    expect(resolveReasoningEffortValue(adaptive, 'max', 'deepseek-v4-pro')).toBe('max')
  })

  describe('with a level picked for the session', () => {
    // Claude Code sends a non-Claude model only an adaptive block, so the pick
    // is the one place the conversation's level reaches the router.
    it('wins over both the adaptive request and the Model Config value', () => {
      expect(resolveReasoningEffortValue(adaptive, undefined, 'some-proxy-model', 'low')).toBe('low')
      expect(resolveReasoningEffortValue(adaptive, 'high', 'some-proxy-model', 'low')).toBe('low')
      expect(resolveReasoningEffortValue(adaptive, 'off', 'glm-5.2', 'max')).toBe('max')
    })

    it('forwards the pick as is to a model without a profile — the upstream maps it', () => {
      expect(resolveReasoningEffortValue(adaptive, undefined, 'some-proxy-model', 'max')).toBe('max')
      expect(resolveReasoningEffortValue(adaptive, undefined, 'some-proxy-model', 'xhigh')).toBe('xhigh')
    })

    it('clamps to what a profiled model accepts', () => {
      expect(resolveReasoningEffortValue(adaptive, undefined, 'anthropic/claude-opus-4.6', 'xhigh')).toBe('high')
      expect(resolveReasoningEffortValue(adaptive, undefined, 'glm-5.3', 'max')).toBe('max')
      expect(resolveReasoningEffortValue(adaptive, undefined, 'glm-5.3', 'medium')).toBe('low')
      expect(resolveReasoningEffortValue(adaptive, undefined, 'glm-5.2', 'low')).toBe('high')
    })

    it('turns thinking off through the model\'s own disable value', () => {
      expect(resolveReasoningEffortValue(adaptive, 'high', 'glm-5.2', 'off')).toBe('none')
      // Always-thinking models cannot stop; off lands on their lowest level.
      expect(resolveReasoningEffortValue(adaptive, undefined, 'glm-5.3', 'off')).toBe('low')
      expect(resolveReasoningEffortValue(adaptive, undefined, 'claude-opus-5-5', 'off')).toBe('low')
      expect(resolveReasoningEffortValue(adaptive, undefined, 'gpt-6-astra', 'off')).toBe('low')
      expect(resolveReasoningEffortValue(adaptive, undefined, 'gpt-6.1-sol', 'off')).toBe('low')
      expect(resolveReasoningEffortValue(adaptive, undefined, 'gpt-4o', 'off')).toBeUndefined()
    })

    it('omits the field for models whose API has none', () => {
      expect(resolveReasoningEffortValue(adaptive, undefined, 'glm-5', 'high')).toBeUndefined()
    })

    it('ignores a value that is not a ladder level', () => {
      expect(resolveReasoningEffortValue(adaptive, 'max', 'some-proxy-model', 'ultra')).toBe('max')
      expect(resolveReasoningEffortValue(adaptive, undefined, 'some-proxy-model', 3)).toBe('high')
    })
  })
})

describe('isThinkingEffort', () => {
  it('does not read a disable value as thinking being active', () => {
    expect(isThinkingEffort('none')).toBe(false)
    expect(isThinkingEffort('off')).toBe(false)
    expect(isThinkingEffort(undefined)).toBe(false)
    expect(isThinkingEffort('max')).toBe(true)
  })
})
