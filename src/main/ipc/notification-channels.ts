/**
 * Notification Channels IPC Handlers
 * Provides channel testing functionality for the Settings UI.
 *
 * Registered from the typed RPC contract (passthrough — handler bodies and
 * return shapes preserved verbatim).
 */

import { testChannel } from '../services/notify-channels'
import { getConfig } from '../foundation/config.service'
import { clearAllTokenCaches } from '../services/notify-channels'
import type { NotificationChannelType } from '../../shared/types/notification-channels'
import { notificationChannelsRpc } from '../../shared/rpc/contracts/notification-channels.contract'
import { registerRawRpcHandlers } from './rpc'

export function registerNotificationChannelHandlers(): void {
  registerRawRpcHandlers(notificationChannelsRpc, {
    // Test a notification channel connection
    testNotificationChannel: async (channelType: string) => {
      console.log('[NotifyChannels] Testing channel:', channelType)
      try {
        const config = getConfig()
        const channelsConfig = config.notificationChannels
        if (!channelsConfig) {
          return { success: false, data: { channel: channelType, success: false, error: 'No channels configured' } }
        }

        const result = await testChannel(channelType as NotificationChannelType, channelsConfig)
        console.log('[NotifyChannels] Test result:', channelType, result.success ? 'OK' : result.error)
        return { success: true, data: result }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[NotifyChannels] Test failed:', err.message)
        return { success: false, error: err.message }
      }
    },
    // Clear token caches (called when config changes)
    clearNotificationChannelCache: async () => {
      clearAllTokenCaches()
      return { success: true }
    },
  })

  console.log('[NotifyChannels] IPC handlers registered')
}
