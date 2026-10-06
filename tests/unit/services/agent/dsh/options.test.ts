import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { ApiCredentials } from '../../../../../src/main/services/agent/types'

const getApiCredentials = vi.fn()
const buildDshLaunchSpec = vi.fn()
const ensureOpenAICompatRouter = vi.fn()

vi.mock('../../../../../src/main/services/agent/helpers', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../../src/main/services/agent/helpers')>()
  return { ...actual, getApiCredentials: (config: unknown) => getApiCredentials() }
})
vi.mock('../../../../../src/main/openai-compat-router', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../../src/main/openai-compat-router')>()
  return { ...actual, ensureOpenAICompatRouter: (options: unknown) => ensureOpenAICompatRouter(options) }
})
vi.mock('../../../../../src/main/services/agent/dsh/runtime', () => ({
  buildDshLaunchSpec: (options: Record<string, any>) => buildDshLaunchSpec(options),
}))

import { resolveDshOptions } from '../../../../../src/main/services/agent/dsh/options'
import { encodeBackendConfig, decodeBackendConfig } from '../../../../../src/main/openai-compat-router'

const LAUNCH = { command: 'node', args: ['entry.js', 'config.yml'], env: {}, cwd: '/work' }

function credentials(capabilities?: { maxOutputTokens: number; contextWindow: number }): ApiCredentials {
  return {
    sourceId: 'account-a', credentialsGeneration: 'captured-a',
    baseUrl: 'https://gateway.example.com/v1/chat/completions',
    apiKey: 'test-key-a', model: 'glm-4.7-zp', provider: 'openai',
    ...(capabilities ? { capabilities: { ...capabilities, maxOutputTokensConfigured: true } } : {}),
  }
}

function launchedBackendConfig() {
  return decodeBackendConfig(buildDshLaunchSpec.mock.calls[0][0].apiKey)
}

beforeEach(() => {
  getApiCredentials.mockReset().mockResolvedValue({ ...credentials(), sourceId: 'account-b', apiKey: 'test-key-b' })
  buildDshLaunchSpec.mockReset().mockReturnValue(LAUNCH)
  ensureOpenAICompatRouter.mockReset().mockResolvedValue({ baseUrl: 'http://127.0.0.1:51234', port: 51234 })
})

describe('resolveDshOptions account egress', () => {
  it('uses the selected snapshot rather than the globally selected account', async () => {
    await resolveDshOptions({ cwd: '/work', apiCredentials: {
      ...credentials(), customHeaders: { 'User-Agent': 'ExampleIDE/1.0.0', 'ChatGPT-Account-Id': 'account-a' },
      adapterId: 'tencent', apiType: 'chat_completions', profileArn: 'profile-a',
      codexModelCapabilities: { reasoningSummary: true, responsesLite: false },
    } })
    expect(getApiCredentials).not.toHaveBeenCalled()
    expect(buildDshLaunchSpec.mock.calls[0][0].baseUrl).toBe('http://127.0.0.1:51234/v1')
    expect(launchedBackendConfig()).toMatchObject({
      sourceId: 'account-a', url: 'https://gateway.example.com/v1/chat/completions', key: 'test-key-a',
      headers: { 'User-Agent': 'ExampleIDE/1.0.0', 'ChatGPT-Account-Id': 'account-a' },
      adapterId: 'tencent', apiType: 'chat_completions', profileArn: 'profile-a',
      codexModelCapabilities: { reasoningSummary: true, responsesLite: false },
    })
  })

  it('does not change account or model while awaiting router preparation', async () => {
    let release!: (value: { baseUrl: string }) => void
    ensureOpenAICompatRouter.mockReturnValueOnce(new Promise(resolve => { release = resolve }))
    const pending = resolveDshOptions({ cwd: '/work', model: 'sdk-decorated-model[1m]', apiCredentials: credentials() })
    await vi.waitFor(() => expect(ensureOpenAICompatRouter).toHaveBeenCalledTimes(1))
    getApiCredentials.mockResolvedValue({ ...credentials(), sourceId: 'account-c', apiKey: 'test-key-c', model: 'new-default' })
    release({ baseUrl: 'http://127.0.0.1:51234' })
    expect((await pending).init.model).toBe('glm-4.7-zp')
    expect(launchedBackendConfig()).toMatchObject({ sourceId: 'account-a', key: 'test-key-a', model: 'glm-4.7-zp' })
    expect(getApiCredentials).not.toHaveBeenCalled()
  })

  it('passes only an encoded descriptor to the runtime auth channel', async () => {
    await resolveDshOptions({ cwd: '/work', apiCredentials: credentials() })
    expect(buildDshLaunchSpec.mock.calls[0][0].apiKey).not.toBe('test-key-a')
    expect(launchedBackendConfig()?.key).toBe('test-key-a')
  })

  it('honors the selected account vision override', async () => {
    await resolveDshOptions({ cwd: '/work', apiCredentials: { ...credentials(), visionOverride: true } })
    expect(buildDshLaunchSpec.mock.calls[0][0].imageInputModel).toBe('glm-4.7-zp')
    buildDshLaunchSpec.mockClear()
    await resolveDshOptions({ cwd: '/work', apiCredentials: { ...credentials(), visionOverride: false } })
    expect(buildDshLaunchSpec.mock.calls[0][0]).not.toHaveProperty('imageInputModel')
  })

  it('can use a standalone validation descriptor without reading a stored source', async () => {
    await resolveDshOptions({ cwd: '/work', model: 'validation-model', env: {
      ANTHROPIC_API_KEY: encodeBackendConfig({ url: 'https://example.invalid/v1/chat/completions', key: 'test-validation' }),
    } })
    expect(launchedBackendConfig()).toMatchObject({ key: 'test-validation', model: 'validation-model' })
    expect(getApiCredentials).not.toHaveBeenCalled()
  })

  it.each(['missing', 'unusable', 'delegated'] as const)('refuses %s credentials without global fallback', async state => {
    const apiCredentials = state === 'missing' ? undefined
      : { ...credentials(), apiKey: state === 'unusable' ? '' : 'test-key-a', delegatedAuth: state === 'delegated' }
    await expect(resolveDshOptions({ cwd: '/work', apiCredentials })).rejects.toThrow('captured API credentials')
    expect(getApiCredentials).not.toHaveBeenCalled()
    expect(buildDshLaunchSpec).not.toHaveBeenCalled()
    expect(ensureOpenAICompatRouter).not.toHaveBeenCalled()
  })
})

describe('resolveDshOptions selected model limits', () => {
  it('pins the runtime to the captured model capabilities', async () => {
    const resolved = await resolveDshOptions({ cwd: '/work', apiCredentials: credentials({ maxOutputTokens: 131_072, contextWindow: 200_000 }) })
    expect(resolved.init.maxTokens).toBe(131_072)
    expect(buildDshLaunchSpec.mock.calls[0][0].contextWindow).toBe(200_000)
  })

  it('bounds capabilities driven out of range', async () => {
    const resolved = await resolveDshOptions({ cwd: '/work', apiCredentials: credentials({ maxOutputTokens: 9_000_000, contextWindow: 1_024 }) })
    expect(resolved.init.maxTokens).toBe(1_000_000)
    expect(buildDshLaunchSpec.mock.calls[0][0].contextWindow).toBe(40_000)
  })

  it('leaves runtime defaults alone when no model capabilities were resolved', async () => {
    const resolved = await resolveDshOptions({ cwd: '/work', apiCredentials: credentials() })
    expect(resolved.init.maxTokens).toBeUndefined()
    expect(buildDshLaunchSpec.mock.calls[0][0].contextWindow).toBeUndefined()
  })

  it('lets an explicit caller output cap win', async () => {
    const resolved = await resolveDshOptions({ cwd: '/work', maxTokens: 2_048, apiCredentials: credentials({ maxOutputTokens: 131_072, contextWindow: 200_000 }) })
    expect(resolved.init.maxTokens).toBe(2_048)
  })
})
