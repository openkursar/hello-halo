/**
 * Notification-channels RPC contract (passthrough — handler bodies preserved).
 */
import { rawRpcMethod } from '../define'

export const notificationChannelsRpc = {
  testNotificationChannel: rawRpcMethod('notify-channels:test'),
  clearNotificationChannelCache: rawRpcMethod('notify-channels:clear-cache'),
}
