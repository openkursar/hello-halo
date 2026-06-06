/**
 * notifyApi — notify domain slice of the unified api object.
 * Split from the monolithic api/index.ts; transport branch (IPC vs HTTP) preserved.
 */
import {
  httpRequest,
  isElectron,
} from './_shared'
import type {
  ApiResponse,
} from './_shared'

export const notifyApi = {
  // ===== Notification Channels =====
  testNotificationChannel: async (channelType: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.testNotificationChannel(channelType)
    }
    return httpRequest('POST', '/api/notify-channels/test', { channelType })
  },

  clearNotificationChannelCache: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.clearNotificationChannelCache()
    }
    return httpRequest('POST', '/api/notify-channels/clear-cache')
  },

  // ===== Notification (in-app toast) =====
  onNotificationToast: (callback: (data: {
    title: string
    body?: string
    variant?: 'default' | 'success' | 'warning' | 'error'
    duration?: number
    appId?: string
  }) => void) => {
    if (!isElectron()) {
      return () => { } // No-op in remote mode
    }
    return window.halo.onNotificationToast(callback)
  },

}
