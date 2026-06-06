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

  onStoreSyncStatusChanged: (callback: (data: { registryId: string; status: string; appCount: number; error?: string }) => void) => {
    if (isElectron()) {
      return window.halo.onStoreSyncStatusChanged(callback)
    }
    return onEvent('store:sync-status-changed', callback)
  },

}
