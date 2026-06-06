/**
 * remoteApi — remote domain slice of the unified api object.
 * Split from the monolithic api/index.ts; transport branch (IPC vs HTTP) preserved.
 */
import {
  isElectron,
} from './_shared'
import type {
  ApiResponse,
} from './_shared'

export const remoteApi = {
  // ===== Remote Access (Electron only) =====
  enableRemoteAccess: async (port?: number): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.enableRemoteAccess(port)
  },

  disableRemoteAccess: async (): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.disableRemoteAccess()
  },

  enableTunnel: async (): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.enableTunnel()
  },

  disableTunnel: async (): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.disableTunnel()
  },

  getRemoteStatus: async (): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.getRemoteStatus()
  },

  getRemoteQRCode: async (includeToken?: boolean): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.getRemoteQRCode(includeToken)
  },

  setRemotePassword: async (password: string): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.setRemotePassword(password)
  },

  regenerateRemotePassword: async (): Promise<ApiResponse> => {
    if (!isElectron()) {
      return { success: false, error: 'Only available in desktop app' }
    }
    return window.halo.regenerateRemotePassword()
  },

}
