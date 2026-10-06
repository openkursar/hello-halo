import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ApiCredentials } from '../../../../../src/main/services/agent/types'

const state = vi.hoisted(() => ({
  haloDir: '', getApiCredentials: vi.fn(), ensureRouter: vi.fn(), prepareMcp: vi.fn(),
}))
vi.mock('../../../../../src/main/foundation/config.service', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../../src/main/foundation/config.service')>()
  return { ...actual, getHaloDir: () => state.haloDir }
})
vi.mock('../../../../../src/main/services/agent/helpers', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../../src/main/services/agent/helpers')>()
  return { ...actual, getApiCredentials: state.getApiCredentials }
})
vi.mock('../../../../../src/main/openai-compat-router', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../../src/main/openai-compat-router')>()
  return { ...actual, ensureOpenAICompatRouter: state.ensureRouter }
})
vi.mock('../../../../../src/main/services/agent/codex/mcp-config', () => ({
  prepareCodexMcpServers: state.prepareMcp,
}))

import { resolveCodexOptions } from '../../../../../src/main/services/agent/codex/options'
import { encodeBackendConfig, decodeBackendConfig } from '../../../../../src/main/openai-compat-router'

function credentials(): ApiCredentials {
  return {
    sourceId: 'account-a', credentialsGeneration: 'captured-a', provider: 'oauth',
    baseUrl: 'https://example.invalid/v1/responses', apiKey: 'test-key-a', model: 'gpt-test',
    displayModel: 'Model A', apiType: 'responses', adapterId: 'chatgpt-codex', profileArn: 'profile-a',
    customHeaders: { 'ChatGPT-Account-Id': 'workspace-a' },
    codexModelCapabilities: { reasoningSummary: true, responsesLite: false, reasoningLevels: ['low', 'high'] },
    capabilities: { contextWindow: 272_000, maxOutputTokens: 64_000, maxOutputTokensConfigured: true },
  }
}

beforeAll(() => { state.haloDir = mkdtempSync(join(tmpdir(), 'halo-codex-options-')) })
afterAll(() => { rmSync(state.haloDir, { recursive: true, force: true }) })
beforeEach(() => {
  state.getApiCredentials.mockReset().mockResolvedValue({ ...credentials(), sourceId: 'account-b', apiKey: 'test-key-b' })
  state.ensureRouter.mockReset().mockResolvedValue({ baseUrl: 'http://127.0.0.1:51234' })
  state.prepareMcp.mockReset().mockResolvedValue({ mcpServers: {}, injectedServerNames: [] })
})

describe('Codex captured-account egress', () => {
  it('carries the selected account descriptor instead of the global account', async () => {
    const resolved = await resolveCodexOptions({ cwd: '/work', env: { HALO_AI_SOURCE_ID: 'account-a' }, apiCredentials: credentials(), pickedReasoningEffort: 'high' })
    expect(state.getApiCredentials).not.toHaveBeenCalled()
    expect(resolved.env.HALO_AI_SOURCE_ID).toBe('account-a')
    expect(resolved.model).toBe('gpt-test')
    expect(resolved.displayModel).toBe('Model A')
    expect(decodeBackendConfig(String(resolved.env.HALO_ROUTER_KEY))).toMatchObject({
      sourceId: 'account-a', key: 'test-key-a', model: 'gpt-test', profileArn: 'profile-a',
      headers: { 'ChatGPT-Account-Id': 'workspace-a' }, adapterId: 'chatgpt-codex', apiType: 'responses',
      codexModelCapabilities: { reasoningSummary: true, responsesLite: false, reasoningLevels: ['low', 'high'] },
      pickedReasoningEffort: 'high',
    })
  })

  it('keeps the snapshot while async MCP preparation spans a global selection change', async () => {
    let release!: (value: { mcpServers: {}; injectedServerNames: string[] }) => void
    state.prepareMcp.mockReturnValueOnce(new Promise(resolve => { release = resolve }))
    const pending = resolveCodexOptions({ cwd: '/work', apiCredentials: credentials() })
    await vi.waitFor(() => expect(state.prepareMcp).toHaveBeenCalledTimes(1))
    state.getApiCredentials.mockResolvedValue({ ...credentials(), sourceId: 'account-c', apiKey: 'test-key-c' })
    release({ mcpServers: {}, injectedServerNames: [] })
    expect(decodeBackendConfig(String((await pending).env.HALO_ROUTER_KEY))).toMatchObject({ sourceId: 'account-a', key: 'test-key-a' })
    expect(state.getApiCredentials).not.toHaveBeenCalled()
  })

  it('uses an explicit custom API descriptor supplied by standalone validation', async () => {
    const resolved = await resolveCodexOptions({ model: 'validation-model', env: {
      ANTHROPIC_API_KEY: encodeBackendConfig({ url: 'https://example.invalid/v1/chat/completions', key: 'test-validation' }),
    } })
    expect(resolved.model).toBe('validation-model')
    expect(decodeBackendConfig(String(resolved.env.HALO_ROUTER_KEY))).toMatchObject({
      key: 'test-validation', model: 'validation-model', apiType: 'chat_completions',
    })
    expect(state.getApiCredentials).not.toHaveBeenCalled()
  })

  it('preserves direct Anthropic validation credentials without consulting a stored account', async () => {
    const resolved = await resolveCodexOptions({ model: 'gpt-validation', env: {
      ANTHROPIC_API_KEY: 'test-direct', ANTHROPIC_BASE_URL: 'https://example.invalid',
    } })
    expect(resolved.env.OPENAI_API_KEY).toBe('test-direct')
    expect(resolved.env.CODEX_API_KEY).toBe('test-direct')
    expect(resolved.env).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(state.getApiCredentials).not.toHaveBeenCalled()
  })

  it.each(['missing', 'unusable', 'delegated'] as const)('refuses %s credentials rather than resolving the global account', async kind => {
    const apiCredentials = kind === 'missing' ? undefined
      : { ...credentials(), apiKey: kind === 'unusable' ? '' : 'test-key-a', delegatedAuth: kind === 'delegated' }
    await expect(resolveCodexOptions({ apiCredentials })).rejects.toThrow('captured API credentials')
    expect(state.getApiCredentials).not.toHaveBeenCalled()
    expect(state.prepareMcp).not.toHaveBeenCalled()
  })
})
