import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  controllerFetchModelsMock,
  fetchModelsFromApiMock,
  registerRawRpcHandlersMock
} = vi.hoisted(() => ({
  controllerFetchModelsMock: vi.fn(),
  fetchModelsFromApiMock: vi.fn(),
  registerRawRpcHandlersMock: vi.fn()
}))

vi.mock('../../../src/main/controllers/config.controller', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/main/controllers/config.controller')>(),
  fetchModels: controllerFetchModelsMock
}))

vi.mock('../../../src/main/foundation/config.service', () => ({
  getConfig: vi.fn(),
  saveConfig: vi.fn()
}))

vi.mock('../../../src/main/services/ai-sources', () => ({
  getAISourceManager: vi.fn()
}))

vi.mock('../../../src/main/foundation/secure-storage.service', () => ({
  decryptString: vi.fn(value => value)
}))

vi.mock('../../../src/main/foundation/config-encryption', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/main/foundation/config-encryption')>(),
  maskConfigFields: vi.fn(value => value),
  unmaskSentinels: vi.fn()
}))

vi.mock('../../../src/main/services/api-validator.service', () => ({
  validateApiConnection: vi.fn(),
  fetchModelsFromApi: fetchModelsFromApiMock
}))

vi.mock('../../../src/main/services/analytics/analytics.service', () => ({
  analytics: { track: vi.fn(), trackErrorSurface: vi.fn() },
}))

vi.mock('../../../src/main/services/health', () => ({
  runConfigProbe: vi.fn().mockResolvedValue({ healthy: true }),
  emitConfigChange: vi.fn()
}))

vi.mock('../../../src/shared/rpc/contracts/config.contract', () => ({
  configRpc: {}
}))

vi.mock('../../../src/main/ipc/rpc', () => ({
  registerRawRpcHandlers: registerRawRpcHandlersMock
}))

import { registerConfigHandlers } from '../../../src/main/ipc/config'
import { getConfig, saveConfig } from '../../../src/main/foundation/config.service'
import { getAISourceManager } from '../../../src/main/services/ai-sources'

describe('config IPC model fetching', () => {
  beforeEach(() => {
    controllerFetchModelsMock.mockReset()
    fetchModelsFromApiMock.mockReset()
    registerRawRpcHandlersMock.mockReset()
  })

  it('returns cached and failed refresh outcomes alongside the updated configuration', async () => {
    const config = {
      api: { provider: 'anthropic', apiKey: '', apiUrl: 'https://api.anthropic.com', model: 'default' },
      aiSources: { version: 2, currentId: null, sources: [] },
      permissions: { fileAccess: 'allow', commandExecution: 'ask', networkAccess: 'allow', trustMode: false },
      appearance: { theme: 'system' },
      system: { autoLaunch: false },
      remoteAccess: { enabled: false, port: 0 },
      onboarding: { completed: false },
      mcpServers: {},
      isFirstLaunch: false
    } satisfies ReturnType<typeof getConfig>
    const modelRefresh = { degradedSourceIds: ['cached'], failedSourceIds: ['failed'] }
    vi.mocked(getConfig).mockReturnValue(config)
    vi.mocked(getAISourceManager).mockReturnValue({
      refreshAllConfigs: vi.fn().mockResolvedValue(modelRefresh)
    } as unknown as ReturnType<typeof getAISourceManager>)
    registerConfigHandlers()
    const handlers = registerRawRpcHandlersMock.mock.calls[0][1]
    await expect(handlers.refreshAISourcesConfig()).resolves.toEqual({ success: true, data: config, modelRefresh })
  })

  it('never returns managed tokens on config reads or atomic source updates', async () => {
    const config = { aiSources: { version: 2, currentId: 'a', sources: [{
      id: 'a', accessToken: 'private-access', refreshToken: 'private-refresh', name: 'Account A'
    }] } }
    vi.mocked(getConfig).mockReturnValue(config as any)
    vi.mocked(getAISourceManager).mockReturnValue({ updateSource: vi.fn(() => config.aiSources) } as any)
    registerConfigHandlers()
    const handlers = registerRawRpcHandlersMock.mock.calls[0][1]
    const read = await handlers.getConfig()
    const update = await handlers.aiSourcesUpdateSource('a', { name: 'Renamed' })
    for (const result of [read, update]) {
      expect(JSON.stringify(result)).not.toContain('private-')
      expect(JSON.stringify(result)).toContain('***')
    }
    expect(config.aiSources.sources[0].accessToken).toBe('private-access')
  })

  it('preserves managed account state when Electron submits a stale settings snapshot', async () => {
    const live = { id: 'a', authType: 'oauth', provider: 'chatgpt', accessToken: 'live', model: 'm' }
    vi.mocked(getConfig).mockReturnValue({ aiSources: { version: 2, currentId: 'a', sources: [live] } } as any)
    registerConfigHandlers()
    const handlers = registerRawRpcHandlersMock.mock.calls[0][1]
    await handlers.setConfig({ aiSources: { version: 2, currentId: 'a', sources: [{ ...live, accessToken: 'stale' }] } })
    expect(saveConfig).toHaveBeenLastCalledWith({ aiSources: { version: 2, currentId: 'a', sources: [live] } })
  })

  it('delegates to the config controller so structured errors reach Electron', async () => {
    const result = {
      success: false,
      code: 'MODEL_FETCH_UNAUTHORIZED',
      error: 'Invalid Authentication'
    }
    controllerFetchModelsMock.mockResolvedValue(result)
    fetchModelsFromApiMock.mockRejectedValue(new Error('service called directly'))

    registerConfigHandlers()
    const handlers = registerRawRpcHandlersMock.mock.calls[0][1] as {
      fetchModels: (apiKey: string, apiUrl: string) => Promise<unknown>
    }

    await expect(handlers.fetchModels(
      'sk-test-placeholder',
      'https://example.com/v1'
    )).resolves.toEqual(result)
    expect(controllerFetchModelsMock).toHaveBeenCalledWith(
      'sk-test-placeholder',
      'https://example.com/v1'
    )
  })
})
