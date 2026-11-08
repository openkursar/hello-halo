/**
 * What an engine is told about a session that runs on a load-balancing group:
 * one stable model whose limits every usable member can honor.
 */

import { describe, expect, it, vi } from 'vitest'
import { resolveGroupCredentials, type GroupCredentialDeps } from '../../../../src/main/services/agent/group-credentials'
import { GROUP_MODEL_ID, type AIGroup, type AISource } from '../../../../src/shared/types/ai-sources'
import type { ResolvedModelCapabilities } from '../../../../src/main/services/agent/types'

const account = (id: string, extra: Partial<AISource> = {}): AISource => ({
  id, name: id, provider: 'custom', authType: 'api-key', apiUrl: 'https://example.invalid', apiKey: 'key',
  model: 'm1', availableModels: [{ id: 'm1', name: 'M1', supportsVision: true }, { id: 'm2', name: 'M2', supportsVision: false }],
  createdAt: '', updatedAt: '', ...extra,
})

const group = (members: Array<[string, string]>): AIGroup => ({
  id: 'g', name: 'Daily work', strategy: 'priority', createdAt: '', updatedAt: '',
  members: members.map(([sourceId, modelId]) => ({ sourceId, modelId })),
})

const capabilities = (extra: Partial<ResolvedModelCapabilities> = {}): ResolvedModelCapabilities =>
  ({ maxOutputTokens: 32_000, contextWindow: 200_000, maxOutputTokensConfigured: true, adaptiveThinking: false, ...extra })

function depsWith(sources: AISource[], facts: Record<string, Partial<ResolvedModelCapabilities>> = {}): GroupCredentialDeps {
  return {
    readSource: id => sources.find(source => source.id === id) ?? null,
    capabilitiesOf: (source, modelId) => capabilities(facts[`${source.id}/${modelId}`]),
    credentialsGeneration: id => `generation-of-${id}`,
  }
}

describe('credentials for a group', () => {
  it('stand for the group alone, with a placeholder the router never forwards', () => {
    const credentials = resolveGroupCredentials(group([['a', 'm1']]), depsWith([account('a')]))
    expect(credentials).toMatchObject({
      sourceId: 'g',
      credentialsGeneration: 'generation-of-g',
      model: GROUP_MODEL_ID,
      displayModel: 'Daily work',
      provider: 'openai',
      apiType: 'chat_completions',
      isGroup: true,
    })
    expect(credentials.baseUrl).toMatch(/\.invalid\//)
    expect(credentials.apiKey).not.toBe('')
    expect(credentials.apiKey).not.toBe('key')
  })

  it('promise what the weakest usable member can do', () => {
    const credentials = resolveGroupCredentials(
      group([['a', 'm1'], ['b', 'm1']]),
      depsWith([account('a'), account('b')], {
        'a/m1': { contextWindow: 1_000_000, maxOutputTokens: 64_000, adaptiveThinking: true },
        'b/m1': { contextWindow: 128_000, maxOutputTokens: 16_000, adaptiveThinking: true },
      })
    )
    expect(credentials.capabilities).toEqual({
      contextWindow: 128_000, maxOutputTokens: 16_000, maxOutputTokensConfigured: true, adaptiveThinking: true,
    })
  })

  it('does not mistake an unknown model\'s fallback for a declared output limit', () => {
    const credentials = resolveGroupCredentials(
      group([['a', 'm1'], ['b', 'm1']]),
      depsWith([account('a'), account('b')], {
        'a/m1': { maxOutputTokens: 128_000 },
        'b/m1': { maxOutputTokens: 64_000, maxOutputTokensConfigured: false },
      })
    )
    expect(credentials.capabilities).toMatchObject({ maxOutputTokens: 128_000, maxOutputTokensConfigured: true })
  })

  it('leave the engine default alone when no member declares an output limit', () => {
    const credentials = resolveGroupCredentials(
      group([['a', 'm1'], ['b', 'm1']]),
      depsWith([account('a'), account('b')], {
        'a/m1': { maxOutputTokensConfigured: false },
        'b/m1': { maxOutputTokensConfigured: false },
      })
    )
    expect(credentials.capabilities?.maxOutputTokensConfigured).toBe(false)
  })

  it('claim adaptive thinking only if every member has it', () => {
    const credentials = resolveGroupCredentials(
      group([['a', 'm1'], ['b', 'm1']]),
      depsWith([account('a'), account('b')], { 'a/m1': { adaptiveThinking: true } })
    )
    expect(credentials.capabilities?.adaptiveThinking).toBe(false)
  })

  it('promise images only when every member takes them', () => {
    const allSee = resolveGroupCredentials(group([['a', 'm1'], ['b', 'm1']]), depsWith([account('a'), account('b')]))
    expect(allSee).toMatchObject({ visionOverride: true, supportsVision: true })
    const oneBlind = resolveGroupCredentials(group([['a', 'm1'], ['b', 'm2']]), depsWith([account('a'), account('b')]))
    expect(oneBlind).toMatchObject({ visionOverride: false, supportsVision: false })
  })

  it('leave out a member that cannot serve, without changing the group', () => {
    const credentials = resolveGroupCredentials(
      group([['a', 'm1'], ['signed-out', 'm1'], ['gone', 'm1'], ['cli', 'm1']]),
      depsWith(
        [
          account('a'),
          account('signed-out', { authType: 'oauth', accessToken: '' }),
          account('cli', { authType: 'delegated', apiKey: undefined }),
        ],
        { 'a/m1': { contextWindow: 500_000 }, 'signed-out/m1': { contextWindow: 8_000 } }
      )
    )
    expect(credentials.capabilities?.contextWindow).toBe(500_000)
  })

  it('are refused, with a reason, when no member can serve', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => resolveGroupCredentials(group([]), depsWith([]))).toThrow('None of the models in "Daily work" can be used')
    expect(() => resolveGroupCredentials(group([['gone', 'm1']]), depsWith([]))).toThrow('sign in to its accounts again')
  })
})
