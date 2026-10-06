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

import { fetchModels, preserveManagedSources, setConfig } from '../../../src/main/controllers/config.controller'
import { getConfig, saveConfig } from '../../../src/main/foundation/config.service'

describe('managed account configuration writes', () => {
  const live = {
    id: 'a', name: 'Account A', authType: 'oauth', provider: 'chatgpt',
    accessToken: 'live-access', refreshToken: 'live-refresh', tokenExpires: 1000,
    user: { uid: 'account-a', name: 'Account' }, model: 'chosen', apiUrl: '',
    modelCatalogCache: { entries: ['live'] }, availableModels: ['live']
  }

  it('preserves live managed metadata, auth, routing and catalog data', () => {
    const incoming = { aiSources: { version: 2, currentId: 'a', sources: [{
      ...live, name: 'Renamed', model: 'new-model', accessToken: 'stale', refreshToken: 'stale',
      tokenExpires: 1, user: { uid: 'other' }, provider: 'claude', apiUrl: 'https://wrong.example',
      modelCatalogCache: { entries: ['stale'] }, availableModels: ['stale']
    }] } }
    preserveManagedSources(incoming, { aiSources: { version: 2, currentId: 'a', sources: [live] } })
    expect(incoming.aiSources.sources).toEqual([live])
  })

  it('retains newly added accounts and cannot resurrect removed accounts from stale snapshots', () => {
    const incoming = { aiSources: { version: 2, currentId: 'removed', sources: [{ ...live, id: 'removed' }] } }
    preserveManagedSources(incoming, { aiSources: { version: 2, currentId: 'a', sources: [live] } })
    expect(incoming.aiSources).toEqual({ version: 2, currentId: 'a', sources: [live] })
  })

  it('allows custom API additions without removing managed accounts omitted by a client', () => {
    const custom = { id: 'custom', authType: 'api-key', apiKey: 'new-key' }
    const incoming = { aiSources: { version: 2, currentId: 'custom', sources: [custom] } }
    preserveManagedSources(incoming, { aiSources: { version: 2, currentId: 'a', sources: [live] } })
    expect(incoming.aiSources.sources).toEqual([custom, live])
  })

  it('cannot roll back live account selection or model overrides from an unrelated settings save', () => {
    const accountB = { ...live, id: 'b', name: 'Renamed B', model: 'new-b', modelOverrides: { 'new-b': { contextWindow: 400000 } } }
    const incoming = { aiSources: { version: 2, currentId: 'a', sources: [live, {
      ...accountB, name: 'Old B', model: 'old-b', modelOverrides: {}
    }] }, appearance: { theme: 'light' } }
    preserveManagedSources(incoming, { aiSources: { version: 2, currentId: 'b', sources: [live, accountB] } })
    expect(incoming.aiSources).toEqual({ version: 2, currentId: 'b', sources: [live, accountB] })
    expect(incoming.appearance).toEqual({ theme: 'light' })
  })

  it('rejects malformed or duplicate-id snapshots instead of erasing account state', () => {
    expect(() => preserveManagedSources({ aiSources: null }, {})).toThrow('Invalid AI sources')
    expect(() => preserveManagedSources({ aiSources: { version: 2, sources: [live, live] } }, {})).toThrow('Duplicate AI source ids')
  })

  it('applies the protection on the HTTP configuration save path', () => {
    vi.mocked(getConfig).mockReturnValue({ aiSources: { version: 2, currentId: 'a', sources: [live] } } as any)
    setConfig({ aiSources: { version: 2, currentId: 'a', sources: [{ ...live, accessToken: 'stale' }] } })
    expect(saveConfig).toHaveBeenLastCalledWith({ aiSources: { version: 2, currentId: 'a', sources: [live] } })
  })
})

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

  it('omits unexpected exception messages from the response', async () => {
    fetchModelsFromApiMock.mockRejectedValue(new Error(
      'proxy credentials at /Users/private/config'
    ))

    await expect(fetchModels('sk-test-placeholder', 'https://example.com/v1')).resolves.toEqual({
      success: false,
      code: 'MODEL_FETCH_FAILED'
    })
  })
})
