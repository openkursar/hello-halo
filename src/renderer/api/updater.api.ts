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
import type { UpdaterChannel, UpdaterStatusPayload } from '../../shared/types/updater'

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

  /**
   * Which release feed this build follows.
   *
   * Remote clients are looking at somebody else's desktop install and cannot
   * act on its update channel, so they are told nothing rather than shown a
   * channel that is not theirs.
   */
  getUpdateChannel: async (): Promise<ApiResponse<UpdaterChannel>> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return { success: true, data: await window.halo.getUpdateChannel() }
  },

  onUpdaterStatus: (callback: (data: UpdaterStatusPayload) => void) => {
    if (!isElectron()) {
      return () => { } // No-op in remote mode
    }
    return window.halo.onUpdaterStatus(callback)
  },

}
