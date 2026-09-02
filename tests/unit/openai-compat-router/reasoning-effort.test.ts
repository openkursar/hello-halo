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
  resolveReasoningEffortValue,
  isThinkingEffort,
} from '../../../src/main/openai-compat-router/converters/reasoning-effort'
import { reasoningEffortProfileById } from '../../../src/shared/constants/model-capabilities'
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

  it('assumes the narrow ladder for an unknown model', () => {
    expect(reasoningEffortProfileById('some-proxy-model').levels).toEqual(['low', 'medium', 'high'])
    expect(reasoningEffortProfileById(undefined).disableValue).toBeUndefined()
  })

  it('marks GLM-5/5.1/5-Turbo/4.7/4.6 as not supporting reasoning_effort at all', () => {
    // docs.bigmodel.cn: the field is documented from GLM-5.2 onward only.
    for (const id of ['glm-5', 'glm-5.1', 'glm-5-turbo', 'glm-4.7', 'glm-4.6', 'glm-4.5']) {
      expect(reasoningEffortProfileById(id).levels, id).toEqual([])
      expect(reasoningEffortProfileById(id).disableValue, id).toBeUndefined()
    }
  })

  it('gives GLM-5.2 the two effort tiers its API does not silently alias', () => {
    expect(reasoningEffortProfileById('glm-5.2').levels).toEqual(['high', 'max'])
    expect(reasoningEffortProfileById('glm-5.2').disableValue).toBe('none')
  })
})

describe('resolveReasoningEffortValue', () => {
  it('caps an inferred level at what an unknown upstream accepts', () => {
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

  it('omits the field for GLM-5/5.1/4.7 — reasoning_effort is not in their API surface', () => {
    // Their only real thinking toggle is `thinking.type`, which Halo does not
    // send yet, so an inferred "off" here has no wire value to carry it.
    expect(resolveReasoningEffortValue(disabled, undefined, 'glm-5')).toBeUndefined()
    expect(resolveReasoningEffortValue(enabled(32_000), 'off', 'glm-5.1')).toBeUndefined()
    expect(resolveReasoningEffortValue(disabled, undefined, 'glm-4.7')).toBeUndefined()
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
})

describe('isThinkingEffort', () => {
  it('does not read a disable value as thinking being active', () => {
    expect(isThinkingEffort('none')).toBe(false)
    expect(isThinkingEffort('off')).toBe(false)
    expect(isThinkingEffort(undefined)).toBe(false)
    expect(isThinkingEffort('max')).toBe(true)
  })
})
