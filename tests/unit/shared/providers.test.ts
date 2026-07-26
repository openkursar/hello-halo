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

  it('uses a verified Atlas Cloud text model as the default', () => {
    expect(getDefaultModel('atlascloud')).toBe('deepseek-ai/deepseek-v4-pro')
    expect(getBuiltinProvider('atlascloud')?.models.map(model => model.id)).toEqual([
      'deepseek-ai/deepseek-v4-pro',
      'deepseek-ai/deepseek-v4-flash',
      'qwen/qwen3.5-27b'
    ])
  })
})
