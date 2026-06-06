/**
 * IM-channels RPC contract (passthrough). Generic, provider-agnostic
 * multi-instance channel management (ARCHITECTURE.md §22). Brand-specific
 * setup/auth flows live in their own contracts (wecom-bot, weixin-ilink).
 */
import { rawRpcMethod } from '../define'

export const imChannelsRpc = {
  imChannelsStatus: rawRpcMethod('im-channels:status'),
  imChannelsInstanceStatus: rawRpcMethod('im-channels:instance-status'),
  imChannelsReconnect: rawRpcMethod('im-channels:reconnect'),
  imChannelsReload: rawRpcMethod('im-channels:reload'),
  imChannelsProviders: rawRpcMethod('im-channels:providers'),
  imChannelsPermissionDefaults: rawRpcMethod('im-channels:permission-defaults'),
}
