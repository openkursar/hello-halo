/**
 * WeChat iLink bot RPC contract (passthrough). Brand-specific QR-login flow
 * (ARCHITECTURE.md §22.3 rule 5). Business logic for save-token/disconnect is
 * shared with HTTP routes via controllers/weixin-ilink.controller.
 */
import { rawRpcMethod } from '../define'

export const weixinIlinkRpc = {
  weixinIlinkRequestQrcode: rawRpcMethod('weixin-ilink:request-qrcode'),
  weixinIlinkPollAuthStatus: rawRpcMethod('weixin-ilink:poll-auth-status'),
  weixinIlinkSaveToken: rawRpcMethod('weixin-ilink:save-token'),
  weixinIlinkDisconnect: rawRpcMethod('weixin-ilink:disconnect'),
}
