/**
 * Feishu Bot RPC contract (passthrough). Only the brand-unique QR-code
 * scan-authorization device flow lives here — generic channel lifecycle
 * (status, reconnect, reload, binding) uses the im-channels contract.
 */
import { rawRpcMethod } from '../define'

export const feishuBotRpc = {
  feishuBotReachability: rawRpcMethod('feishu-bot:reachability'),
  feishuBotScanAuthStart: rawRpcMethod('feishu-bot:scan-auth:start'),
  feishuBotScanAuthPoll: rawRpcMethod('feishu-bot:scan-auth:poll'),
  feishuBotScanAuthCancel: rawRpcMethod('feishu-bot:scan-auth:cancel'),
  feishuBotScanAuthCreateAssistant: rawRpcMethod('feishu-bot:scan-auth:create-assistant'),
}
