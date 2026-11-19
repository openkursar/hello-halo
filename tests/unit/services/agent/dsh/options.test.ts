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
import { encodeBackendConfig, decodeBackendConfig, convertAnthropicToOpenAIChat, type AnthropicRequest } from '../../../../../src/main/openai-compat-router'
import type { EffectiveReasoning } from '@hello-halo/agent-sdk/collaboration'
import { resolveAnthropicReasoning } from '../../../../../src/main/openai-compat-router/utils/normalize-anthropic-reasoning'

const LAUNCH = { command: 'node', args: ['entry.js', 'config.yml'], env: {}, cwd: '/work' }

function credentials(capabilities?: { maxOutputTokens: number; contextWindow: number }): ApiCredentials {
  return {
    sourceId: 'account-a', credentialsGeneration: 'captured-a',
    baseUrl: 'https://gateway.example.com/v1/chat/completions',
    apiKey: 'test-key-a', model: 'glm-4.7-zp', provider: 'openai',
    ...(capabilities ? { capabilities } : {}),
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

  it.each(['https://native.example.com', 'https://native.example.com/', 'https://native.example.com/v1/messages'])('routes native Anthropic credentials from %s through Messages', async baseUrl => {
    await resolveDshOptions({ apiCredentials: { ...credentials(), provider: 'anthropic', baseUrl, model: 'claude-opus-4-6' } })
    expect(launchedBackendConfig()).toMatchObject({ sourceId: 'account-a', apiType: 'anthropic_passthrough', url: 'https://native.example.com/v1/messages', model: 'claude-opus-4-6', key: 'test-key-a' })
  })

  it('preserves an explicitly declared native endpoint without guessing from the model name', async () => {
    await resolveDshOptions({ apiCredentials: { ...credentials(), apiType: 'anthropic_passthrough', baseUrl: 'https://native.example.com/v1/messages', model: 'claude-opus-4-6' } })
    expect(launchedBackendConfig()).toMatchObject({ apiType: 'anthropic_passthrough', url: 'https://native.example.com/v1/messages' })
    buildDshLaunchSpec.mockClear()
    await resolveDshOptions({ apiCredentials: { ...credentials(), apiType: 'chat_completions', model: 'claude-opus-4-6' } })
    expect(launchedBackendConfig()).toMatchObject({ apiType: 'chat_completions', url: 'https://gateway.example.com/v1/chat/completions' })
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

describe('resolveDshOptions frozen delegated reasoning', () => {
  function credentials(): ApiCredentials {
    return {
      sourceId: 'account-a', credentialsGeneration: 'captured-a',
      baseUrl: 'https://gateway.example.com/v1/chat/completions',
      apiKey: 'test-key-a', model: 'gateway-model', provider: 'openai',
    }
  }
  const messages: AnthropicRequest = {
    model: 'gateway-model', max_tokens: 8192, messages: [{ role: 'user', content: 'Answer.' }],
    thinking: { type: 'enabled' }, output_config: { effort: 'high' },
  }
  const wire = (backend: NonNullable<ReturnType<typeof decodeBackendConfig>>) => {
    const { request: converted } = convertAnthropicToOpenAIChat({ ...messages, model: backend.model! }, backend)
    return { effort: converted.reasoning_effort, thinking: converted.thinking }
  }

  it('keeps ordinary dsh Messages conversion unchanged even when a user picked another level', async () => {
    await resolveDshOptions({ apiCredentials: credentials(), pickedReasoningEffort: 'max' })
    expect(launchedBackendConfig()).not.toHaveProperty('pickedReasoningEffort')
    expect(wire(launchedBackendConfig()!)).toEqual({ effort: undefined, thinking: undefined })
  })

  it.each([undefined, 'high', 'provider-specific'])('preserves actual parent wire after configured effort %s changes', async configured => {
    await resolveDshOptions({ apiCredentials: { ...credentials(), capabilities: { reasoningEffort: configured } } })
    const parent = wire(launchedBackendConfig()!)
    buildDshLaunchSpec.mockClear()
    await resolveDshOptions({
      apiCredentials: { ...credentials(), capabilities: { reasoningEffort: 'medium' } },
      inheritedReasoning: (parent.effort
        ? { version: 1, mode: 'effort', effort: parent.effort }
        : { version: 1, mode: 'provider-default' }) satisfies EffectiveReasoning,
    })
    expect(wire(launchedBackendConfig()!)).toEqual(parent)
    expect(launchedBackendConfig()?.pickedReasoningEffort).toBe(configured === 'provider-specific' ? undefined : parent.effort ?? 'off')
  })

  it.each(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])('forwards frozen ladder effort %s through the public converter', async effort => {
    await resolveDshOptions({ apiCredentials: credentials(), inheritedReasoning: { version: 1, mode: 'effort', effort } })
    expect(wire(launchedBackendConfig()!).effort).toBe(effort)
    expect(launchedBackendConfig()?.pickedReasoningEffort).toBe(effort)
  })

  it.each(['off', 'provider-default'])('preserves frozen %s without inheriting the current configured effort', async mode => {
    await resolveDshOptions({ apiCredentials: { ...credentials(), capabilities: { reasoningEffort: 'high' } }, inheritedReasoning: { version: 1, mode } })
    expect(launchedBackendConfig()?.pickedReasoningEffort).toBe('off')
    expect(wire(launchedBackendConfig()!)).toEqual({ effort: undefined, thinking: undefined })
  })

  it('captures the frozen reasoning before asynchronous router setup', async () => {
    let release!: (value: { baseUrl: string }) => void
    ensureOpenAICompatRouter.mockReturnValueOnce(new Promise(resolve => { release = resolve }))
    const inheritedReasoning = { version: 1, mode: 'effort', effort: 'low' }
    const pending = resolveDshOptions({ apiCredentials: credentials(), inheritedReasoning })
    await vi.waitFor(() => expect(ensureOpenAICompatRouter).toHaveBeenCalledTimes(1))
    inheritedReasoning.effort = 'high'
    release({ baseUrl: 'http://127.0.0.1:51234' })
    await pending
    expect(wire(launchedBackendConfig()!).effort).toBe('low')
  })

  it.each(['anthropic', 'apiType'])('retains an adaptive native target through %s routing metadata', async route => {
    await resolveDshOptions({
      apiCredentials: { ...credentials(), model: 'claude-sonnet-4-6', ...(route === 'anthropic' ? { provider: 'anthropic' } : { apiType: 'anthropic_passthrough' }) },
      inheritedReasoning: { version: 1, mode: 'adaptive', effort: 'high' },
    })
    expect(launchedBackendConfig()).toMatchObject({ pickedReasoningEffort: 'high', reasoningEffort: 'high' })
    const request = resolveAnthropicReasoning({ ...messages, model: 'claude-sonnet-4-6' }, launchedBackendConfig()!).request
    expect(request.thinking).toMatchObject({ type: 'adaptive' })
    expect(request.output_config?.effort).toBe('high')
  })

  it.each([undefined, 'high'])('preserves actual adaptive native parent shape after configuration %s changes', async configured => {
    const model = 'claude-sonnet-4-6'
    await resolveDshOptions({ apiCredentials: { ...credentials(), model, provider: 'anthropic', capabilities: { reasoningEffort: configured } } })
    const parent = resolveAnthropicReasoning({ ...messages, model }, launchedBackendConfig()!).request
    const inheritedReasoning: EffectiveReasoning = parent.thinking?.type === 'adaptive'
      ? { version: 1, mode: 'adaptive', effort: parent.output_config!.effort! }
      : { version: 1, mode: 'off' }
    buildDshLaunchSpec.mockClear()
    await resolveDshOptions({ apiCredentials: { ...credentials(), model, provider: 'anthropic', capabilities: { reasoningEffort: 'medium' } }, inheritedReasoning })
    const child = resolveAnthropicReasoning({ ...messages, model }, launchedBackendConfig()!).request
    expect({ thinking: child.thinking, effort: child.output_config }).toEqual({ thinking: parent.thinking, effort: parent.output_config })
  })

  it.each(['claude-3-sonnet', 'gateway-model'])('refuses adaptive inheritance on non-adaptive native model %s', async model => {
    await expect(resolveDshOptions({ apiCredentials: { ...credentials(), provider: 'anthropic', model }, inheritedReasoning: { version: 1, mode: 'adaptive', effort: 'high' } })).rejects.toThrow('cannot preserve this reasoning mode')
    expect(buildDshLaunchSpec).not.toHaveBeenCalled()
  })

  it.each(['budget', 'adaptive'])('refuses unsupported frozen %s before preparing the router or runtime', async mode => {
    await expect(resolveDshOptions({ apiCredentials: credentials(), inheritedReasoning: { version: 1, mode, budgetTokens: 2048, effort: 'high' } })).rejects.toThrow('cannot preserve this reasoning mode')
    expect(ensureOpenAICompatRouter).not.toHaveBeenCalled()
    expect(buildDshLaunchSpec).not.toHaveBeenCalled()
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

describe('resolveDshOptions CLI tools', () => {
  it('hands the session\'s CLI tool directory to the launch spec', async () => {
    await resolveDshOptions({ cwd: '/work', apiCredentials: credentials(), env: { HALO_CLI_TOOLS_BIN: '/cli/views/v/bin' } })
    expect(buildDshLaunchSpec.mock.calls[0][0].cliToolsBinDir).toBe('/cli/views/v/bin')
  })

  it('passes none without tools', async () => {
    await resolveDshOptions({ cwd: '/work', apiCredentials: credentials(), env: {} })
    expect(buildDshLaunchSpec.mock.calls[0][0]).not.toHaveProperty('cliToolsBinDir')
  })
})
