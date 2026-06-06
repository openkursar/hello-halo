/**
 * WeCom Bot RPC contract (passthrough). Brand-specific legacy compat
 * status/reconnect APIs and the QR-code scan-authorization device flow.
 * Generic channel lifecycle lives in the im-channels contract.
 * Handler bodies and return shapes preserved verbatim.
 */
import { rawRpcMethod } from '../define'

export const wecomBotRpc = {
  getWecomBotStatus: rawRpcMethod('wecom-bot:status'),
  reconnectWecomBot: rawRpcMethod('wecom-bot:reconnect'),
  wecomBotScanAuthStart: rawRpcMethod('wecom-bot:scan-auth:start'),
  wecomBotScanAuthPoll: rawRpcMethod('wecom-bot:scan-auth:poll'),
  wecomBotScanAuthCancel: rawRpcMethod('wecom-bot:scan-auth:cancel'),
  wecomBotScanAuthCreateAssistant: rawRpcMethod('wecom-bot:scan-auth:create-assistant'),
}
