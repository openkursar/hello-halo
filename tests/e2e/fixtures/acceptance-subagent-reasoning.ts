import { expect, type Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { AcceptanceSource } from './acceptance-app'

export function reasoningVariants(engine: string) {
  return engine === 'halo' || engine === 'anthropic'
    ? ['provider-default', 'high', 'low', 'off', 'max', 'budget', 'adaptive'] as const
    : engine === 'dsh'
      ? ['provider-default', 'high', 'low', 'off', 'max', 'adaptive'] as const
      : ['provider-default', 'high', 'low', 'off', 'max'] as const
}

export function selectedReasoning(reasoning: string): 'high' | 'low' | 'off' | 'max' | undefined {
  if (reasoning === 'provider-default') return undefined
  return reasoning === 'budget' || reasoning === 'adaptive' ? 'high' : reasoning as 'high' | 'low' | 'off' | 'max'
}

export function reasoningSource(url: string, reasoning: string): AcceptanceSource & { modelOverrides?: Record<string, { reasoningEffort: string; maxOutputTokens?: number; contextWindow?: number }> } {
  const native = reasoning === 'budget' || reasoning === 'adaptive'
  const model = reasoning === 'budget' ? 'claude-sonnet-4-5' : reasoning === 'adaptive' ? 'claude-opus-4-6' : reasoning === 'max' ? 'gpt-6-1-sol' : 'o3'
  const effort = selectedReasoning(reasoning)
  return {
    provider: native ? 'anthropic' : 'openai', apiType: native ? 'anthropic_passthrough' : 'chat_completions',
    apiKey: 'local-scripted-endpoint', apiUrl: url, model,
    ...(effort ? { modelOverrides: { [model]: { reasoningEffort: effort, ...(native ? { maxOutputTokens: 32768, contextWindow: 200000 } : {}) } } } : {}),
  }
}

// Provider-default names an unpicked effective default, not an absent upstream field.
export function assertRequestedReasoning(engine: string, requested: string, body: Record<string, any>, entry: string) {
  if (requested === 'budget') {
    expect(body.model).toBe('claude-sonnet-4-5')
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 10240 })
    expect(body.output_config?.effort).toBeUndefined()
    return
  }
  if (requested === 'adaptive') {
    expect(body.model).toBe('claude-opus-4-6')
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(body.output_config?.effort).toBe('high')
    return
  }
  expect(body.model).toBe(requested === 'max' ? 'gpt-6-1-sol' : 'o3')
  const effort = body.reasoning_effort ?? body.reasoning?.effort ?? body.output_config?.effort
  if (requested === 'max') {
    expect(effort).toBe('max')
  } else if (engine === 'dsh' && (entry === 'space' || entry === 'digital-human' || requested === 'provider-default')) {
    expect(effort).toBe('low')
  } else if (requested === 'provider-default') {
    expect(effort).toBe(engine === 'anthropic' ? 'high' : engine === 'codex' || entry === 'space' || entry === 'digital-human' || entry === 'team-member' ? 'low' : 'high')
  } else if (requested === 'off') {
    expect(effort).toBe('low')
  } else if (requested === 'high' || requested === 'low') {
    expect(effort).toBe(requested)
  }
}

export async function waitForReasoningParentIdle(window: Page, conversationId: string) {
  await expect.poll(async () => {
    const state = await window.evaluate(id => (globalThis as unknown as { halo: HaloAPI }).halo.getSessionState(id), conversationId)
    expect(state.success, state.error).toBe(true)
    return (state.data as { isActive: boolean }).isActive
  }, { timeout: 30000 }).toBe(false)
}
