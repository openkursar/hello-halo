/**
 * updaterApi — updater domain slice of the unified api object.
 * Split from the monolithic api/index.ts; transport branch (IPC vs HTTP) preserved.
 */
import {
  httpRequest,
  isElectron,
} from './_shared'
import type {
  ApiResponse,
} from './_shared'
import type { UpdaterStatusPayload } from '../../shared/types/updater'

export const updaterApi = {
  // ===== Updater (Electron only) =====
  checkForUpdates: async (): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.checkForUpdates()
  },

  installUpdate: async (): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.installUpdate()
  },

  getVersion: async (): Promise<ApiResponse<string>> => {
    if (isElectron()) {
      const version = await window.halo.getVersion()
      return { success: true, data: version }
    }
    // Remote mode: get version from server
    return httpRequest('GET', '/api/system/version')
  },

  onUpdaterStatus: (callback: (data: UpdaterStatusPayload) => void) => {
    if (!isElectron()) {
      return () => { } // No-op in remote mode
    }
    return window.halo.onUpdaterStatus(callback)
  },

}
