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

vi.mock('../../../src/main/controllers/config.controller', () => ({
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

vi.mock('../../../src/main/foundation/config-encryption', () => ({
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
  runConfigProbe: vi.fn(),
  emitConfigChange: vi.fn()
}))

vi.mock('../../../src/shared/rpc/contracts/config.contract', () => ({
  configRpc: {}
}))

vi.mock('../../../src/main/ipc/rpc', () => ({
  registerRawRpcHandlers: registerRawRpcHandlersMock
}))

import { registerConfigHandlers } from '../../../src/main/ipc/config'
import { getConfig } from '../../../src/main/foundation/config.service'
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
