import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelFetchError } from '../../../src/shared/model-fetch-error'

const { fetchModelsFromApiMock } = vi.hoisted(() => ({
  fetchModelsFromApiMock: vi.fn()
}))

vi.mock('../../../src/main/foundation/config.service', () => ({
  getConfig: vi.fn(),
  saveConfig: vi.fn()
}))

vi.mock('../../../src/main/foundation/config-encryption', () => ({
  maskConfigFields: vi.fn(),
  unmaskSentinels: vi.fn()
}))

vi.mock('../../../src/main/services/api-validator.service', () => ({
  validateApiConnection: vi.fn(),
  fetchModelsFromApi: fetchModelsFromApiMock
}))

import { fetchModels } from '../../../src/main/controllers/config.controller'

describe('config controller model fetching', () => {
  beforeEach(() => {
    fetchModelsFromApiMock.mockReset()
  })

  it('preserves a stable model-fetch error code and safe detail', async () => {
    fetchModelsFromApiMock.mockRejectedValue(new ModelFetchError({
      code: 'MODEL_FETCH_UNAUTHORIZED',
      detail: 'Invalid Authentication'
    }))

    await expect(fetchModels('sk-test-placeholder', 'https://example.com/v1')).resolves.toEqual({
      success: false,
      code: 'MODEL_FETCH_UNAUTHORIZED',
      error: 'Invalid Authentication'
    })
  })

  it('omits a generic duplicate detail when the provider did not send one', async () => {
    fetchModelsFromApiMock.mockRejectedValue(new ModelFetchError({
      code: 'MODEL_FETCH_NOT_FOUND'
    }))

    await expect(fetchModels('sk-test-placeholder', 'https://example.com/v1')).resolves.toEqual({
      success: false,
      code: 'MODEL_FETCH_NOT_FOUND'
    })
  })
})
