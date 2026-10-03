/**
 * Unit tests for reasoning effort on the Anthropic passthrough wire.
 *
 * Guards that a level picked in Halo reaches Claude as `output_config.effort`
 * with a thinking type the model accepts, whatever Claude Code put on the
 * request — and that a request needing no change keeps its raw body.
 */

import { describe, it, expect } from 'vitest'
import { normalizeAnthropicReasoning } from '../../../src/main/openai-compat-router/utils/normalize-anthropic-reasoning'
import type { AnthropicRequest } from '../../../src/main/openai-compat-router/types'

function request(model: string, extra: Partial<AnthropicRequest> = {}): AnthropicRequest {
  return { model, max_tokens: 64_000, messages: [{ role: 'user', content: 'hi' }], ...extra }
}

/** What Claude Code sends a Claude model it does not know. */
const legacyBudget = { thinking: { type: 'enabled' as const, budget_tokens: 32_000 } }

function reshape(model: string, picked?: string, extra?: Partial<AnthropicRequest>, declared?: string) {
  return normalizeAnthropicReasoning(request(model, extra), {
    pickedReasoningEffort: picked as never,
    reasoningEffort: declared,
  })
}

describe('normalizeAnthropicReasoning', () => {
  describe('adaptive Claude models', () => {
    it('replaces the legacy budget block with adaptive thinking at the picked effort', () => {
      const { request: out, modified } = reshape('claude-opus-5-5', 'xhigh', legacyBudget)
      expect(modified).toBe(true)
      expect(out.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
      expect(out.output_config).toEqual({ effort: 'xhigh' })
    })

    it('sends every slider level the model accepts unchanged', () => {
      for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
        expect(reshape('claude-opus-5', level, legacyBudget).request.output_config?.effort, level).toBe(level)
      }
    })

    it('steps a level the model lacks down to one it accepts', () => {
      expect(reshape('claude-opus-4-6', 'xhigh', legacyBudget).request.output_config?.effort).toBe('high')
    })

    it('keeps other output_config fields and an explicit display', () => {
      const { request: out } = reshape('claude-opus-4-7', 'low', {
        thinking: { type: 'adaptive', display: 'omitted' },
        output_config: { format: { type: 'json_schema' } },
      })
      expect(out.thinking).toEqual({ type: 'adaptive', display: 'omitted' })
      expect(out.output_config).toEqual({ format: { type: 'json_schema' }, effort: 'low' })
    })

    it('repairs a legacy budget block even when nothing was picked', () => {
      // Automation runs carry no pick; the engine sized the budget from the
      // model's configured level, which is read back from it.
      const { request: out } = reshape('claude-opus-5-5', undefined, { thinking: { type: 'enabled', budget_tokens: 10_240 } })
      expect(out.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
      expect(out.output_config).toEqual({ effort: 'high' })
    })

    it('applies a Model Config level verbatim when nothing was picked', () => {
      expect(reshape('claude-opus-5', undefined, legacyBudget, 'medium').request.output_config?.effort).toBe('medium')
    })
  })

  describe('thinking off', () => {
    it('runs an always-thinking model at its lowest level instead', () => {
      const { request: out } = reshape('claude-opus-5-5', 'off', legacyBudget)
      expect(out.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
      expect(out.output_config).toEqual({ effort: 'low' })
    })

    it('sends `disabled` with no effort to a model that can stop', () => {
      const { request: out } = reshape('claude-opus-5', 'off', legacyBudget)
      expect(out.thinking).toEqual({ type: 'disabled' })
      expect(out.output_config).toBeUndefined()
    })

    it('sends `between_tools` to Sonnet 5.5, which rejects `disabled`', () => {
      expect(reshape('claude-sonnet-5-5', 'off', legacyBudget).request.thinking).toEqual({ type: 'between_tools' })
    })

    it('turns off a budget model that was asked to think', () => {
      expect(reshape('claude-haiku-4-5', 'off', legacyBudget).request.thinking).toEqual({ type: 'disabled' })
    })
  })

  describe('budget Claude models', () => {
    it('keeps the engine-sized budget and adds effort only where the model takes it', () => {
      const opus45 = reshape('claude-opus-4-5', 'max', legacyBudget).request
      expect(opus45.thinking).toEqual(legacyBudget.thinking)
      expect(opus45.output_config).toEqual({ effort: 'high' })

      expect(reshape('claude-sonnet-4-5', 'max', legacyBudget).modified).toBe(false)
    })
  })

  describe('non-Claude models on the Anthropic wire', () => {
    it('forwards the pick as effort and leaves thinking as the engine built it', () => {
      const { request: out } = reshape('deepseek-v4-pro', 'max', { thinking: { type: 'adaptive' } })
      expect(out.thinking).toEqual({ type: 'adaptive' })
      expect(out.output_config).toEqual({ effort: 'max' })
    })

    it('switches off with `disabled` only where thinking defaults on', () => {
      expect(reshape('deepseek-v4-pro', 'off', { thinking: { type: 'adaptive' } }).request.thinking)
        .toEqual({ type: 'disabled' })
      const unknown = reshape('some-proxy-model', 'off', { thinking: { type: 'adaptive' } }).request
      expect(unknown.thinking).toBeUndefined()
      expect(unknown.output_config).toBeUndefined()
    })

    it('runs an always-thinking GLM at its lowest level when asked to stop', () => {
      const { request: out } = reshape('glm-5.3', 'off', { thinking: { type: 'adaptive' } })
      expect(out.thinking).toEqual({ type: 'adaptive' })
      expect(out.output_config).toEqual({ effort: 'low' })
    })

    it('drops a `disabled` block an always-thinking model would reject', () => {
      const { request: out } = reshape('glm-5.3', 'off', { thinking: { type: 'disabled' } })
      expect(out.thinking).toBeUndefined()
      expect(out.output_config).toEqual({ effort: 'low' })
    })
  })

  it('leaves a request without a thinking block untouched, whatever is picked', () => {
    // Claude Code's auxiliary calls (summaries, checks) carry no thinking
    // block; the router rewrites their model to the session's, which must not
    // make them think or change their effort.
    for (const model of ['claude-opus-4-7', 'claude-opus-5-5', 'claude-sonnet-5-5', 'deepseek-v4-pro']) {
      for (const picked of ['off', 'low', 'max']) {
        const original = request(model)
        const result = normalizeAnthropicReasoning(original, { pickedReasoningEffort: picked as never, reasoningEffort: 'high' })
        expect(result.modified, `${model} ${picked}`).toBe(false)
        expect(result.request).toBe(original)
      }
    }
  })

  it('leaves the request untouched when nothing is picked and nothing needs repair', () => {
    const original = request('claude-opus-4-7', { thinking: { type: 'adaptive' } })
    const result = normalizeAnthropicReasoning(original, {})
    expect(result.modified).toBe(false)
    expect(result.request).toBe(original)
  })

  it('reports no change when the request already matches', () => {
    const { request: once } = reshape('claude-opus-5-5', 'high', legacyBudget)
    const again = normalizeAnthropicReasoning(once, { pickedReasoningEffort: 'high' })
    expect(again.modified).toBe(false)
  })
})
