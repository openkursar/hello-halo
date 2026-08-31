import { describe, expect, it } from 'vitest'
import {
  getAllProviderIds,
  getBuiltinProvider,
  getDefaultModel
} from '../../../src/shared/constants/providers'

describe('Atlas Cloud built-in provider', () => {
  it('registers an OpenAI-compatible provider with dynamic model discovery', () => {
    const provider = getBuiltinProvider('atlascloud')

    expect(provider).toMatchObject({
      id: 'atlascloud',
      authType: 'api-key',
      apiUrl: 'https://api.atlascloud.ai/v1',
      modelsUrl: 'https://api.atlascloud.ai/v1/models',
      region: 'global'
    })
    expect(provider?.recommended).toBeUndefined()
    expect(getAllProviderIds()).toContain('atlascloud')
  })

  it('defaults to the cheaper V4 Flash tier, matching the DeepSeek preset ordering', () => {
    expect(getDefaultModel('atlascloud')).toBe('deepseek-ai/deepseek-v4-flash')
    expect(getBuiltinProvider('atlascloud')?.models.map(model => model.id)).toEqual([
      'deepseek-ai/deepseek-v4-flash',
      'deepseek-ai/deepseek-v4-pro',
      'qwen/qwen3.5-27b'
    ])
  })
})

describe('OrcaRouter built-in provider', () => {
  it('registers an OpenAI-compatible gateway provider with dynamic model discovery', () => {
    const provider = getBuiltinProvider('orcarouter')

    expect(provider).toMatchObject({
      id: 'orcarouter',
      authType: 'api-key',
      apiUrl: 'https://api.orcarouter.ai/v1',
      modelsUrl: 'https://api.orcarouter.ai/v1/models',
      region: 'global'
    })
    expect(provider?.recommended).toBe(true)
    expect(getAllProviderIds()).toContain('orcarouter')
  })

  it('leads with the virtual auto router, then flagship model ids', () => {
    expect(getDefaultModel('orcarouter')).toBe('orcarouter/auto')
    expect(getBuiltinProvider('orcarouter')?.models.map(model => model.id)).toEqual([
      'orcarouter/auto',
      'openai/gpt-5.5',
      'google/gemini-3.5-flash',
      'anthropic/claude-opus-4.8',
      'grok/grok-4.3',
      'deepseek/deepseek-v4-pro',
      'minimax/minimax-m2.7',
      'qwen/qwen3.7-max'
    ])
  })
})
