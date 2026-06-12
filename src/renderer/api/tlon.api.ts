/**
 * tlonApi — knowledge base (Tlon) domain slice of the unified api object.
 * Nested under `api.tlon.*`; transport branch (IPC vs HTTP) preserved.
 */
import { httpRequest, isElectron, onEvent } from './_shared'
import type { ApiResponse } from './_shared'

export const tlonApi = {
  tlon: {
    create: async (input: {
      name: string
      icon?: string
      description?: string
      linkedDirs?: Array<{ path: string; label: string }>
    }): Promise<ApiResponse> => {
      if (isElectron()) return window.halo.tlonCreate(input)
      return httpRequest('POST', '/api/tlon', input)
    },
    list: async (): Promise<ApiResponse> => {
      if (isElectron()) return window.halo.tlonList()
      return httpRequest('GET', '/api/tlon')
    },
    listForSpace: async (spaceId: string): Promise<ApiResponse> => {
      if (isElectron()) return window.halo.tlonListForSpace(spaceId)
      return httpRequest('GET', `/api/tlon/for-space/${spaceId}`)
    },
    get: async (kbId: string): Promise<ApiResponse> => {
      if (isElectron()) return window.halo.tlonGet(kbId)
      return httpRequest('GET', `/api/tlon/${kbId}`)
    },
    update: async (kbId: string, updates: {
      name?: string; icon?: string; description?: string; status?: string
    }): Promise<ApiResponse> => {
      if (isElectron()) return window.halo.tlonUpdate(kbId, updates)
      return httpRequest('PUT', `/api/tlon/${kbId}`, updates)
    },
    delete: async (kbId: string): Promise<ApiResponse> => {
      if (isElectron()) return window.halo.tlonDelete(kbId)
      return httpRequest('DELETE', `/api/tlon/${kbId}`)
    },
    setDefault: async (kbId: string | null): Promise<ApiResponse> => {
      if (isElectron()) return window.halo.tlonSetDefault(kbId)
      return httpRequest('POST', `/api/tlon/set-default`, { kbId })
    },
    bindSpace: async (kbId: string, spaceId: string): Promise<ApiResponse> => {
      if (isElectron()) return window.halo.tlonBindSpace(kbId, spaceId)
      return httpRequest('POST', `/api/tlon/${kbId}/bind-space`, { spaceId })
    },
    unbindSpace: async (kbId: string, spaceId: string): Promise<ApiResponse> => {
      if (isElectron()) return window.halo.tlonUnbindSpace(kbId, spaceId)
      return httpRequest('POST', `/api/tlon/${kbId}/unbind-space`, { spaceId })
    },
    bindApp: async (kbId: string, appId: string): Promise<ApiResponse> => {
      if (isElectron()) return window.halo.tlonBindApp(kbId, appId)
      return httpRequest('POST', `/api/tlon/${kbId}/bind-app`, { appId })
    },
    unbindApp: async (kbId: string, appId: string): Promise<ApiResponse> => {
      if (isElectron()) return window.halo.tlonUnbindApp(kbId, appId)
      return httpRequest('POST', `/api/tlon/${kbId}/unbind-app`, { appId })
    },
    addLinkedDir: async (kbId: string, dir: { path: string; label: string }): Promise<ApiResponse> => {
      if (isElectron()) return window.halo.tlonAddLinkedDir(kbId, dir)
      return httpRequest('POST', `/api/tlon/${kbId}/linked-dirs`, dir)
    },
    removeLinkedDir: async (kbId: string, linkId: string): Promise<ApiResponse> => {
      if (isElectron()) return window.halo.tlonRemoveLinkedDir(kbId, linkId)
      return httpRequest('DELETE', `/api/tlon/${kbId}/linked-dirs/${linkId}`)
    },
    addFiles: async (kbId: string, filePaths: string[]): Promise<ApiResponse> => {
      if (isElectron()) return window.halo.tlonAddFiles(kbId, filePaths)
      return httpRequest('POST', `/api/tlon/${kbId}/files`, { filePaths })
    },
    listRaw: async (kbId: string): Promise<ApiResponse> => {
      if (isElectron()) return window.halo.tlonListRaw(kbId)
      return httpRequest('GET', `/api/tlon/${kbId}/raw`)
    },
    removeRaw: async (kbId: string, relativePath: string): Promise<ApiResponse> => {
      if (isElectron()) return window.halo.tlonRemoveRaw(kbId, relativePath)
      return httpRequest('POST', `/api/tlon/${kbId}/remove-raw`, { relativePath })
    },
    listWiki: async (kbId: string): Promise<ApiResponse> => {
      if (isElectron()) return window.halo.tlonListWiki(kbId)
      return httpRequest('GET', `/api/tlon/${kbId}/wiki`)
    },
    readWiki: async (kbId: string, pagePath: string): Promise<ApiResponse> => {
      if (isElectron()) return window.halo.tlonReadWiki(kbId, pagePath)
      return httpRequest('POST', `/api/tlon/${kbId}/read-wiki`, { pagePath })
    },
    readIndex: async (kbId: string): Promise<ApiResponse> => {
      if (isElectron()) return window.halo.tlonReadIndex(kbId)
      return httpRequest('GET', `/api/tlon/${kbId}/index`)
    },
    triggerIngest: async (kbId: string): Promise<ApiResponse> => {
      if (isElectron()) return window.halo.tlonTriggerIngest(kbId)
      return httpRequest('POST', `/api/tlon/${kbId}/ingest`)
    },
    clearRelearn: async (kbId: string): Promise<ApiResponse> => {
      if (isElectron()) return window.halo.tlonClearRelearn(kbId)
      return httpRequest('POST', `/api/tlon/${kbId}/clear-relearn`)
    },
    getIngestStatus: async (kbId: string): Promise<ApiResponse> => {
      if (isElectron()) return window.halo.tlonGetIngestStatus(kbId)
      return httpRequest('GET', `/api/tlon/${kbId}/ingest-status`)
    },
    // Pickers are desktop-only (need the OS file dialog).
    pickFiles: async (): Promise<ApiResponse> => {
      if (!isElectron()) return { success: false, error: 'Only available in desktop app' }
      return window.halo.tlonPickFiles()
    },
    pickFolder: async (
      options?: { title?: string; buttonLabel?: string }
    ): Promise<ApiResponse> => {
      if (!isElectron()) return { success: false, error: 'Only available in desktop app' }
      return window.halo.tlonPickFolder(options)
    },
    onStatsUpdated: (callback: (data: unknown) => void) => onEvent('tlon:stats-updated', callback),
    onIngestProgress: (callback: (data: unknown) => void) => onEvent('tlon:ingest-progress', callback),
  },
}
