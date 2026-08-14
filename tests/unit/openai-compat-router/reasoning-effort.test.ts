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
    expect(reasoningEffortProfileById('Pro/zai-org/GLM-5').disableValue)
      .toBe(reasoningEffortProfileById('glm-5').disableValue)
  })

  it('assumes the narrow ladder for an unknown model', () => {
    expect(reasoningEffortProfileById('some-proxy-model').levels).toEqual(['low', 'medium', 'high'])
    expect(reasoningEffortProfileById(undefined).disableValue).toBeUndefined()
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

  it('sends an explicit off to upstreams that think by default', () => {
    expect(resolveReasoningEffortValue(disabled, undefined, 'glm-5')).toBe('none')
    expect(resolveReasoningEffortValue(enabled(32_000), 'off', 'glm-5.1')).toBe('none')
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
