import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AISource, BackendRequestConfig } from '../../../../../src/shared/types/ai-sources'

const state = vi.hoisted(() => ({ source: null as AISource | null, apiType: 'responses' as BackendRequestConfig['apiType'], refresh: vi.fn(), current: vi.fn() }))
vi.mock('../../../../../src/main/services/ai-sources', () => ({ getAISourceManager: () => ({
  ensureInitialized: async () => {},
  getSourceConfig: (id: string) => state.source?.id === id ? state.source : null,
  getCurrentSourceConfig: state.current,
  ensureValidToken: state.refresh,
  getBackendConfigForSource: (id: string, model: string) => state.source?.id === id ? {
    sourceId: id, url: `https://selected.example/v1/${state.apiType === 'responses' ? 'responses' : 'chat/completions'}`,
    key: 'selected-account-key', model, apiType: state.apiType,
  } : null,
}) }))
vi.mock('../../../../../src/main/services/analytics/analytics.service', () => ({ analytics: { track: vi.fn(), trackErrorSurface: vi.fn() } }))
vi.mock('../../../../../src/main/openai-compat-router', async original => ({
  ...await original<typeof import('../../../../../src/main/openai-compat-router')>(),
  ensureOpenAICompatRouter: async () => ({ baseUrl: 'http://127.0.0.1:51234' }),
}))
vi.mock('../../../../../src/main/services/agent/codex/mcp-config', () => ({
  prepareCodexMcpServers: async () => ({ mcpServers: {}, injectedServerNames: [] }),
}))

import { getApiCredentialsForSelection } from '../../../../../src/main/services/agent/helpers'
import { resolveCredentialsForSdk } from '../../../../../src/main/services/agent/sdk-config'
import { resolveCodexOptions } from '../../../../../src/main/services/agent/codex/options'
import { decodeBackendConfig } from '../../../../../src/main/openai-compat-router'
import { DEFAULT_MODEL } from '../../../../../src/shared/types/ai-sources'

beforeEach(() => {
  vi.clearAllMocks()
  state.source = {
    id: 'selected-account', name: 'Explicit gateway', provider: 'custom', authType: 'api-key',
    apiKey: 'selected-account-key', apiUrl: 'https://selected.example/v1', model: 'claude-mythos-preview',
    availableModels: [{ id: 'claude-mythos-preview', name: 'Private gateway model' }], createdAt: 'test', updatedAt: 'test',
  }
  state.current.mockReturnValue({ id: 'different-default', model: 'gpt-other' })
})

describe('stored source to Codex request identity', () => {
  it.each(['chat_completions', 'responses'] as const)('preserves an Anthropic-retired name on a selected %s gateway through every layer', async apiType => {
    state.apiType = apiType
    state.source!.apiType = apiType
    const credentials = await getApiCredentialsForSelection({ modelSourceId: 'selected-account', modelId: 'claude-mythos-preview' })
    expect(credentials).toMatchObject({ sourceId: 'selected-account', model: 'claude-mythos-preview', apiKey: 'selected-account-key', apiType })
    const sdk = await resolveCredentialsForSdk(credentials, undefined, 'codex')
    expect(sdk.sdkModel).toBe('claude-mythos-preview')
    const options = await resolveCodexOptions({ engineId: 'codex', model: sdk.sdkModel, apiCredentials: sdk.apiCredentials, env: {} })
    expect(options.threadParams.model).toBe('claude-mythos-preview')
    for (const encoded of [sdk.anthropicApiKey, options.env.HALO_ROUTER_KEY!]) {
      expect(decodeBackendConfig(encoded)).toMatchObject({ sourceId: 'selected-account', model: 'claude-mythos-preview', key: 'selected-account-key', url: credentials.baseUrl, apiType })
    }
    expect(state.current).not.toHaveBeenCalled()
    expect(state.refresh).not.toHaveBeenCalled()
    expect(state.source!.model).toBe('claude-mythos-preview')
  })

  it('keeps the existing retirement migration on an Anthropic-protocol account', async () => {
    state.apiType = 'anthropic_passthrough'
    state.source!.apiType = 'anthropic_passthrough'
    const credentials = await getApiCredentialsForSelection({ modelSourceId: 'selected-account' })
    expect(credentials.model).toBe(DEFAULT_MODEL)
  })
})
