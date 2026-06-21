/**
 * storeApi — store domain slice of the unified api object.
 * Split from the monolithic api/index.ts; transport branch (IPC vs HTTP) preserved.
 */
import {
  httpRequest,
  isElectron,
  onEvent,
} from './_shared'
import type {
  ApiResponse,
} from './_shared'

export const storeApi = {
  // ===== Store (App Registry) =====
  storeQuery: async (params: { search?: string; type?: string; category?: string; page?: number; pageSize?: number; locale?: string }): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.storeQuery(params)
    }
    return httpRequest('POST', '/api/store/query', params)
  },

  storeListApps: async (query: { search?: string; locale?: string; category?: string; type?: string; tags?: string[] }): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.storeListApps(query)
    }
    const params = new URLSearchParams()
    if (query.search) params.set('search', query.search)
    if (query.locale) params.set('locale', query.locale)
    if (query.category) params.set('category', query.category)
    if (query.type) params.set('type', query.type)
    if (query.tags && query.tags.length > 0) {
      params.set('tags', query.tags.join(','))
    }
    const qs = params.toString()
    return httpRequest('GET', `/api/store/apps${qs ? '?' + qs : ''}`)
  },

  storeGetAppDetail: async (slug: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.storeGetAppDetail(slug)
    }
    return httpRequest('GET', `/api/store/apps/${slug}`)
  },

  storeGetAppDocument: async (slug: string): Promise<ApiResponse<{ content: string | null }>> => {
    if (isElectron()) {
      return window.halo.storeGetAppDocument(slug)
    }
    return httpRequest('GET', `/api/store/app-document?slug=${encodeURIComponent(slug)}`)
  },

  storeInstall: async (
    slug: string,
    spaceId: string | null,
    userConfig?: Record<string, unknown>,
    onProgress?: Parameters<typeof window.halo.storeInstall>[1],
  ): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.storeInstall({ slug, spaceId, userConfig }, onProgress)
    }
    return httpRequest('POST', `/api/store/apps/${slug}/install`, { spaceId, userConfig })
  },

  storeRefresh: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.storeRefresh()
    }
    return httpRequest('POST', '/api/store/refresh')
  },

  storeCheckUpdates: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.storeCheckUpdates()
    }
    return httpRequest('GET', '/api/store/updates')
  },

  storeGetRegistries: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.storeGetRegistries()
    }
    return httpRequest('GET', '/api/store/registries')
  },

  storeAddRegistry: async (input: { name: string; url: string; sourceType?: string; adapterConfig?: Record<string, unknown> }): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.storeAddRegistry(input)
    }
    return httpRequest('POST', '/api/store/registries', input)
  },

  storeRemoveRegistry: async (registryId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.storeRemoveRegistry(registryId)
    }
    return httpRequest('DELETE', `/api/store/registries/${registryId}`)
  },

  storeToggleRegistry: async (registryId: string, enabled: boolean): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.storeToggleRegistry({ registryId, enabled })
    }
    return httpRequest('POST', `/api/store/registries/${registryId}/toggle`, { enabled })
  },

  storeUpdateRegistryAdapterConfig: async (registryId: string, adapterConfig: Record<string, unknown>): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.storeUpdateRegistryAdapterConfig({ registryId, adapterConfig })
    }
    return httpRequest('PATCH', `/api/store/registries/${registryId}/adapter-config`, adapterConfig)
  },

  storeCheckUpdatesNow: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.storeCheckUpdatesNow()
    }
    return httpRequest('POST', '/api/store/updates/check-now')
  },

  storeApplyUpgrade: async (
    appId: string,
    mode: 'patch_minor' | 'major' | 'force' = 'force',
  ): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.storeApplyUpgrade({ appId, mode })
    }
    return httpRequest('POST', `/api/store/updates/${appId}/apply`, { mode })
  },

  storePublish: async (appId: string, author?: string, version?: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.storePublish({ appId, author, version })
    }
    return httpRequest('POST', `/api/store/publish`, { appId, author, version })
  },

  storePublishPreview: async (appId: string, author?: string): Promise<ApiResponse<{ slug: string; localVersion: string; storeVersion: string | null }>> => {
    if (isElectron()) {
      return window.halo.storePublishPreview({ appId, author })
    }
    return httpRequest('POST', `/api/store/publish/preview`, { appId, author })
  },

  storeExportDhpkg: async (appId: string): Promise<ApiResponse<{ path: string }>> => {
    if (isElectron()) {
      return window.halo.storeExportDhpkg({ appId })
    }
    return { success: false, error: 'Not supported outside Electron' }
  },

  storeImportDhpkg: async (input?: { filePath?: string; spaceId?: string | null }): Promise<ApiResponse<{ appId: string }>> => {
    if (isElectron()) {
      return window.halo.storeImportDhpkg(input)
    }
    if (!input?.filePath) {
      return { success: false, error: 'A server-local filePath is required outside Electron' }
    }
    return httpRequest('POST', '/api/store/import-dhpkg', input)
  },

  onStoreSyncStatusChanged: (callback: (data: { registryId: string; status: string; appCount: number; error?: string }) => void) => {
    if (isElectron()) {
      return window.halo.onStoreSyncStatusChanged(callback)
    }
    return onEvent('store:sync-status-changed', callback)
  },

  onStoreUpgradeAvailable: (callback: (data: { appId: string; currentVersion: string; latestVersion: string; strategy: 'auto' | 'notify' | 'manual'; severity: 'patch' | 'minor' | 'major' }) => void) => {
    if (isElectron()) {
      return window.halo.onStoreUpgradeAvailable(callback)
    }
    return onEvent('store:upgrade-available', callback)
  },

}
