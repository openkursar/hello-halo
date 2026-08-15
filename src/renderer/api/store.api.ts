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
import type { StoreSignInStatus } from '../../shared/store/store-types'
import type { AppType } from '../../shared/apps/spec-types'

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

  storePublish: async (
    appId: string,
    overrides?: { author?: string; version?: string; changelog?: string; category?: string; name?: string; description?: string; tags?: string[] },
  ): Promise<ApiResponse> => {
    const payload = { appId, ...overrides }
    if (isElectron()) {
      return window.halo.storePublish(payload)
    }
    return httpRequest('POST', `/api/store/publish`, payload)
  },

  storePublishPreview: async (appId: string, author?: string, name?: string): Promise<ApiResponse<{ slug: string; localVersion: string; storeVersion: string | null }>> => {
    if (isElectron()) {
      return window.halo.storePublishPreview({ appId, author, name })
    }
    return httpRequest('POST', `/api/store/publish/preview`, { appId, author, name })
  },

  storeFindAppByPublishSlug: async (slug: string, type?: AppType, author?: string): Promise<ApiResponse<{ appId: string | null }>> => {
    if (isElectron()) {
      return window.halo.storeFindAppByPublishSlug({ slug, type, author })
    }
    return httpRequest('POST', `/api/store/publish/find-app`, { slug, type, author })
  },

  storeExportDhpkg: async (appId: string): Promise<ApiResponse<{ path: string }>> => {
    if (isElectron()) {
      return window.halo.storeExportDhpkg({ appId })
    }
    return { success: false, error: 'Not supported outside Electron' }
  },

  storeExportSkill: async (appId: string): Promise<ApiResponse<{ path: string }>> => {
    if (isElectron()) {
      return window.halo.storeExportSkill({ appId })
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

  storeGetCapabilities: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.storeGetCapabilities()
    }
    return httpRequest('GET', '/api/store/capabilities')
  },

  storeGetCategoryTaxonomy: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.storeGetCategoryTaxonomy()
    }
    return httpRequest('GET', '/api/store/category-taxonomy')
  },

  storeRevalidate: async (): Promise<ApiResponse<{ changed: boolean }>> => {
    if (isElectron()) {
      return window.halo.storeRevalidate()
    }
    return httpRequest('POST', '/api/store/revalidate')
  },

  storeGetDiscoverPage: async (input?: { locale?: string; pageSize?: number }): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.storeGetDiscoverPage(input)
    }
    const qs = new URLSearchParams()
    if (input?.locale) qs.set('locale', input.locale)
    if (input?.pageSize) qs.set('pageSize', String(input.pageSize))
    const suffix = qs.toString() ? `?${qs}` : ''
    return httpRequest('GET', `/api/store/discover-page${suffix}`)
  },

  storeEnsureSignedIn: async (force = false): Promise<ApiResponse<boolean>> => {
    if (isElectron()) {
      return window.halo.storeEnsureSignedIn({ force })
    }
    // Browser OAuth login is a desktop-only flow (system browser + loopback).
    return { success: true, data: false }
  },

  storeGetIdentity: async (): Promise<ApiResponse<{ uid: string; name: string } | null>> => {
    if (isElectron()) {
      return window.halo.storeGetIdentity()
    }
    return { success: true, data: null }
  },

  storeGetSignInStatus: async (): Promise<ApiResponse<StoreSignInStatus>> => {
    if (isElectron()) {
      return window.halo.storeGetSignInStatus()
    }
    // Creator sign-in is a desktop-only flow; the browser store is read-only.
    return { success: true, data: 'not-required' }
  },

  storeGetMyPublications: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.storeGetMyPublications()
    }
    return httpRequest('GET', '/api/store/my-publications')
  },

  storeUnpublish: async (input: { slug: string }): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.storeUnpublish(input)
    }
    return httpRequest('POST', '/api/store/unpublish', input)
  },

  storeIgnoreVersion: async (input: { appId: string; version: string }): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.storeIgnoreVersion(input)
    }
    return httpRequest('POST', '/api/store/ignore-version', input)
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
