import { describe, expect, it } from 'vitest'
import { applyEffectiveReasoning, captureEffectiveReasoning } from '../../../../src/main/services/agent/reasoning-effort'

describe('effective reasoning snapshots', () => {
  it('captures an actual budget independently of later settings', () => {
    const options = { maxThinkingTokens: 8192, effort: 'high' }
    const snapshot = captureEffectiveReasoning(options)
    options.maxThinkingTokens = 1024
    expect(snapshot).toEqual({ version: 1, mode: 'budget', budgetTokens: 8192, effort: 'high' })
  })

  it('captures the router model default when an unpicked toggle cannot override it', () => {
    expect(captureEffectiveReasoning({ reasoningEffort: 'off' }, 'halo', {
      contextWindow: 32000, maxOutputTokens: 4096, reasoningEffort: 'high',
    })).toEqual({ version: 1, mode: 'effort', effort: 'high' })
  })

  it('captures OpenAI wire effort rather than an unused engine thinking budget', () => {
    expect(captureEffectiveReasoning({ model: 'o3', pickedReasoningEffort: 'high', reasoningEffort: 'high', maxThinkingTokens: 8192,
      apiCredentials: { provider: 'openai', apiType: 'chat_completions' } })).toEqual({ version: 1, mode: 'effort', effort: 'high' })
    expect(captureEffectiveReasoning({ model: 'gpt-4o', reasoningEffort: 'off',
      apiCredentials: { provider: 'openai', apiType: 'chat_completions' } })).toEqual({ version: 1, mode: 'provider-default' })
  })

  it('preserves provider-default without inventing a strength', () => {
    expect(captureEffectiveReasoning({})).toEqual({ version: 1, mode: 'provider-default' })
  })

  it('clears incompatible fields before applying frozen off', () => {
    const options: Record<string, unknown> = { effort: 'high', maxThinkingTokens: 8192, adaptiveThinking: true }
    expect(applyEffectiveReasoning(options, { version: 1, mode: 'off' })).toBeNull()
    expect(options).toEqual({ thinking: { type: 'disabled' }, maxThinkingTokens: 0, reasoningEffort: 'off', pickedReasoningEffort: 'off' })
  })

  it('round-trips budget and adaptive modes without re-clamping', () => {
    for (const snapshot of [
      { version: 1, mode: 'budget', budgetTokens: 7421, effort: 'high' },
      { version: 1, mode: 'adaptive', effort: 'max' },
    ] as const) {
      const options = {}
      applyEffectiveReasoning(options, snapshot)
      expect(captureEffectiveReasoning(options)).toEqual(snapshot)
    }
  })

  it('rejects a budget that no longer fits before mutating options', () => {
    const options = { effort: 'low' }
    expect(() => applyEffectiveReasoning(options,
      { version: 1, mode: 'budget', budgetTokens: 8192 },
      { contextWindow: 32000, maxOutputTokens: 4096 })).toThrow('capacity')
    expect(options).toEqual({ effort: 'low' })
  })

  it('rejects unsupported engine modes rather than silently lowering strength', () => {
    expect(() => applyEffectiveReasoning({}, { version: 1, mode: 'budget', budgetTokens: 1024 }, undefined, 'codex')).toThrow('Codex')
    expect(() => applyEffectiveReasoning({}, { version: 1, mode: 'adaptive', effort: 'high' }, undefined, 'dsh')).toThrow('upstream reasoning')
  })

  it.each([
    ['gpt-5-pro', { version: 1, mode: 'effort', effort: 'high' }],
    ['gpt-5-5-pro', { version: 1, mode: 'effort', effort: 'medium' }],
    ['gpt-6-luna', { version: 1, mode: 'off' }],
    ['gpt-4o', { version: 1, mode: 'provider-default' }],
  ])('captures Codex off using the actual %s upstream control', (model, expected) => {
    expect(captureEffectiveReasoning({ model, reasoningEffort: 'off', pickedReasoningEffort: 'off' }, 'codex')).toEqual(expected)
  })

  it('captures dsh upstream defaults independently of ignored host picks', () => {
    expect(captureEffectiveReasoning({ model: 'o3', pickedReasoningEffort: 'off' }, 'dsh')).toEqual({ version: 1, mode: 'effort', effort: 'low' })
    expect(captureEffectiveReasoning({ model: 'o3', pickedReasoningEffort: 'high' }, 'dsh', {
      contextWindow: 32000, maxOutputTokens: 4096, reasoningEffort: 'high',
    })).toEqual({ version: 1, mode: 'effort', effort: 'high' })
  })

  it('prevents SDK defaults from enabling a provider-default child', () => {
    const options: Record<string, unknown> = { model: 'gpt-4o', effort: 'high', maxThinkingTokens: 8192,
      apiCredentials: { provider: 'openai', apiType: 'chat_completions' } }
    applyEffectiveReasoning(options, { version: 1, mode: 'provider-default' }, {
      contextWindow: 32000, maxOutputTokens: 4096, reasoningEffort: 'high',
    })
    expect(options.thinking).toEqual({ type: 'disabled' })
    expect(options.maxThinkingTokens).toBe(0)
    expect(options.effort).toBeUndefined()
    expect(captureEffectiveReasoning(options, 'halo', {
      contextWindow: 32000, maxOutputTokens: 4096, reasoningEffort: 'high',
    })).toEqual({ version: 1, mode: 'provider-default' })
  })

  it('captures native Anthropic dsh using the actual passthrough shaping', () => {
    const options = { model: 'claude-sonnet-4-6', apiCredentials: { provider: 'anthropic' } }
    expect(captureEffectiveReasoning(options, 'dsh')).toEqual({ version: 1, mode: 'off' })
    expect(captureEffectiveReasoning(options, 'dsh', {
      contextWindow: 32000, maxOutputTokens: 4096, reasoningEffort: 'high',
    })).toEqual({ version: 1, mode: 'adaptive', effort: 'high' })
    expect(() => captureEffectiveReasoning({ model: 'claude-sonnet-4-5', apiCredentials: { provider: 'anthropic' } }, 'dsh')).toThrow('token budget')
  })

  it('captures a disabled Halo request before the unused model default', () => {
    expect(captureEffectiveReasoning({ model: 'o3', reasoningEffort: 'off',
      apiCredentials: { provider: 'openai', apiType: 'chat_completions' } }, 'halo', {
      contextWindow: 32000, maxOutputTokens: 4096, reasoningEffort: 'high',
    })).toEqual({ version: 1, mode: 'effort', effort: 'low' })
  })
})
