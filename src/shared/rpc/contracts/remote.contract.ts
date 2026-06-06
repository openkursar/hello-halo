/**
 * Remote-access RPC contract (passthrough). Enable/disable remote access and
 * tunnel, status/QR queries, and password management. Handler return shapes
 * (success envelopes with optional `code`) are preserved verbatim.
 */
import { rawRpcMethod } from '../define'

export const remoteRpc = {
  enableRemoteAccess: rawRpcMethod('remote:enable'),
  disableRemoteAccess: rawRpcMethod('remote:disable'),
  enableTunnel: rawRpcMethod('remote:tunnel:enable'),
  disableTunnel: rawRpcMethod('remote:tunnel:disable'),
  getRemoteStatus: rawRpcMethod('remote:status'),
  getRemoteQRCode: rawRpcMethod('remote:qrcode'),
  setRemotePassword: rawRpcMethod('remote:set-password'),
  regenerateRemotePassword: rawRpcMethod('remote:regenerate-password'),
}
