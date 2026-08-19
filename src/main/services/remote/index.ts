/**
 * Remote Access module — lets other devices reach this Halo over HTTP.
 *
 * `service.ts` is the coordinator: it drives the local HTTP server plus the
 * Cloudflare tunnel and owns access-token/credential persistence. `tunnel.ts`
 * spawns and supervises the cloudflared process (named + quick modes);
 * `issuer-client.ts` obtains a permanent named-tunnel grant from the issuer.
 *
 * The tunnel and issuer internals are implementation details of the
 * coordinator — only the coordinator surface and the error/grant types that
 * cross the IPC boundary are re-exported here.
 */

export {
  enableRemoteAccess,
  disableRemoteAccess,
  shutdownRemoteAccess,
  enableTunnel,
  disableTunnel,
  resetTunnelAddress,
  getRemoteAccessStatus,
  onRemoteAccessStatusChange,
  generateQRCode,
  setCustomPassword,
  regeneratePassword,
  type RemoteAccessStatus,
  type TunnelFallbackReason,
} from './service'

export {
  TunnelIssueError,
  type NamedTunnelGrant,
} from './issuer-client'
