/**
 * Remote Access Service - Coordinates HTTP server and tunnel
 * Provides a unified interface for remote access functionality
 */

import { BrowserWindow } from 'electron'
import { networkInterfaces } from 'os'
import {
  startHttpServer,
  stopHttpServer,
  isServerRunning,
  getServerInfo
} from '../http/server'
import {
  startTunnel,
  stopTunnel,
  getTunnelStatus,
  onTunnelStatusChange,
  TunnelDisabledByPolicyError,
} from './tunnel.service'
import { getConfig, saveConfig } from '../foundation/config.service'
import {
  setCustomAccessToken,
  generateAccessToken,
  encodeForStorage,
  CredentialRestoreError,
  logAuthEvent,
} from '../http/auth/index'
import { isTunnelSafe } from './security-policy'

/**
 * Persist the access token to config so it survives restarts. The token
 * is encoded through {@link encodeForStorage}: plain when the open-
 * source default is in effect, SM4-CBC + HMAC-SM3 wrapped when
 * `credentialAtRestSafe` is on.
 */
function persistRemotePassword(token: string): void {
  const config = getConfig()
  saveConfig({
    ...config,
    remoteAccess: {
      ...config.remoteAccess,
      password: encodeForStorage(token)
    }
  })
}

export interface RemoteAccessStatus {
  enabled: boolean
  server: {
    running: boolean
    port: number
    token: string | null
    localUrl: string | null
    lanUrl: string | null
  }
  tunnel: {
    status: 'stopped' | 'starting' | 'running' | 'error'
    url: string | null
    error: string | null
  }
  clients: number
}

// Callback for status updates
type StatusCallback = (status: RemoteAccessStatus) => void
let statusCallback: StatusCallback | null = null

/**
 * Check if a network interface name looks like a virtual adapter.
 * Virtual adapters include Docker, WSL, VPN, Hyper-V, VMware, VirtualBox,
 * sing-box TUN, etc.
 */
function isVirtualInterface(name: string): boolean {
  const virtualPatterns = [
    /^docker/i,
    /^br-/i,
    /^veth/i,
    /^vEthernet/i,
    /^vmnet/i,
    /^VMware/i,
    /^VirtualBox/i,
    /^vboxnet/i,
    /^Hyper-V/i,
    /^Default Switch/i,
    /^WSL/i,
    /^tun/i,
    /^tap/i,
    /^singbox/i,
    /^sing-box/i,
    /^clash/i,
    /^utun/i,
    /^tailscale/i,
    /^Tailscale/i,
    /^ZeroTier/i,
    /^zt/i,
    /^wg/i,
    /^wireguard/i,
    /^ham/i,
    /^Hamachi/i,
    /^npcap/i,
    /^lo/i,
  ]
  return virtualPatterns.some((pattern) => pattern.test(name))
}

/**
 * Get local network IP address.
 * Prioritizes physical network interfaces (Ethernet, Wi-Fi) over virtual ones
 * (Docker, WSL, VPN, TUN adapters, etc.) to return an IP that is actually
 * reachable by other devices on the local network.
 */
function getLocalIp(): string | null {
  const interfaces = networkInterfaces()
  let fallback: string | null = null

  for (const name of Object.keys(interfaces)) {
    const iface = interfaces[name]
    if (!iface) continue

    const virtual = isVirtualInterface(name)

    for (const info of iface) {
      // Skip internal and non-IPv4 addresses
      if (info.internal || info.family !== 'IPv4') continue

      // Prefer addresses from physical interfaces
      if (!virtual) {
        return info.address
      }

      // Keep the first virtual address as fallback
      if (!fallback) {
        fallback = info.address
      }
    }
  }

  return fallback
}

/**
 * Enable remote access (start HTTP server)
 */
export async function enableRemoteAccess(
  port?: number
): Promise<RemoteAccessStatus> {
  if (isServerRunning()) {
    return getRemoteAccessStatus()
  }

  // Reuse the persisted PIN so paired devices keep working across restarts.
  // The stored value may be plain (legacy / open-source) or encoded
  // (gmcred:v1:...); startHttpServer hands it to the auth layer which
  // decodes internally and exposes the plaintext via getAccessToken.
  //
  // When decoding fails (tampered file, profile mismatch, key derivation
  // change) we DO NOT silently rotate the PIN — that would invalidate
  // every previously paired device with no audit trail. Instead we
  // disable remote access in config, write an audit event, and re-throw
  // so the IPC layer can surface a structured `CREDENTIAL_RESTORE_FAILED`
  // code to the UI.
  const config = getConfig()
  const savedToken = config.remoteAccess.password
  const effectivePort = port ?? config.remoteAccess.port

  let actualPort: number
  let token: string
  try {
    // actualPort may differ from effectivePort when the preferred port is taken
    // (EADDRINUSE fallback); persist whichever we actually bound to.
    const result = await startHttpServer(effectivePort, savedToken)
    actualPort = result.port
    token = result.token
  } catch (err) {
    if (err instanceof CredentialRestoreError) {
      logAuthEvent('credential_restore_failed', {})
      // The plaintext is already lost — keeping the unreadable blob would
      // only force the user through this error path again on the next
      // enable attempt. Wipe it (and disable the feature) so a subsequent
      // user-initiated enable starts cleanly with a freshly generated PIN.
      // The UI receives the code below and is expected to tell the user
      // their paired devices must be re-paired.
      saveConfig({
        ...config,
        remoteAccess: {
          ...config.remoteAccess,
          enabled: false,
          password: '',
        },
      })
      if (statusCallback) {
        statusCallback(getRemoteAccessStatus())
      }
    }
    throw err
  }

  // Always re-encode the live token. This unifies three paths:
  //   - first launch (no saved value)
  //   - profile change (plain → gm, or gm → plain)
  //   - corrupted ciphertext recovery (saved value failed to decrypt,
  //     a fresh PIN was generated, and we must overwrite the bad blob)
  // For AEAD profiles the salt/IV refresh on every save is fine — the
  // ciphertext is bound to the same plaintext.
  saveConfig({
    ...config,
    remoteAccess: {
      ...config.remoteAccess,
      enabled: true,
      port: actualPort,
      password: encodeForStorage(token)
    }
  })

  // Push status so the renderer reflects the running server even when the
  // service starts outside a user-initiated IPC call (e.g. idle auto-restore).
  if (statusCallback) {
    statusCallback(getRemoteAccessStatus())
  }

  return getRemoteAccessStatus()
}

/**
 * Disable remote access (stop HTTP server and tunnel)
 *
 * User-initiated disable: persists `enabled: false` so the service does NOT
 * auto-restore on next start. For app shutdown use shutdownRemoteAccess().
 */
export async function disableRemoteAccess(): Promise<void> {
  await stopTunnel()
  stopHttpServer()

  // Update config
  const config = getConfig()
  saveConfig({
    ...config,
    remoteAccess: {
      ...config.remoteAccess,
      enabled: false
    }
  })
}

/**
 * Stop remote access resources during app shutdown.
 *
 * Releases the tunnel and HTTP port without mutating config. The persisted
 * `enabled` flag must survive shutdown so the next start's idle task can
 * auto-restore the service for paired devices.
 */
export async function shutdownRemoteAccess(): Promise<void> {
  await stopTunnel()
  stopHttpServer()
}

/**
 * Start tunnel for external access.
 *
 * Re-checks `tunnelSafe` here so that any future caller that bypasses
 * the IPC layer still hits the policy gate (defense in depth). The
 * underlying {@link startTunnel} will reject as well.
 */
export async function enableTunnel(): Promise<string> {
  if (isTunnelSafe()) {
    throw new TunnelDisabledByPolicyError()
  }

  const serverInfo = getServerInfo()

  if (!serverInfo.running) {
    throw new Error('HTTP server is not running. Enable remote access first.')
  }

  const url = await startTunnel(serverInfo.port)
  return url
}

/**
 * Stop tunnel. Always allowed — even when `tunnelSafe` is on we want
 * the service to clean up any tunnel state that might have been
 * persisted before the policy flag was flipped on.
 */
export async function disableTunnel(): Promise<void> {
  await stopTunnel()
}

/**
 * Get current remote access status
 */
export function getRemoteAccessStatus(): RemoteAccessStatus {
  const serverInfo = getServerInfo()
  const tunnelStatus = getTunnelStatus()
  const localIp = getLocalIp()

  return {
    enabled: serverInfo.running,
    server: {
      running: serverInfo.running,
      port: serverInfo.port,
      token: serverInfo.token,
      localUrl: serverInfo.running ? `http://localhost:${serverInfo.port}` : null,
      lanUrl: serverInfo.running && localIp ? `http://${localIp}:${serverInfo.port}` : null
    },
    tunnel: {
      status: tunnelStatus.status,
      url: tunnelStatus.url,
      error: tunnelStatus.error
    },
    clients: serverInfo.clients
  }
}

/**
 * Set status callback for real-time updates
 */
export function onRemoteAccessStatusChange(callback: StatusCallback): void {
  statusCallback = callback

  // Also listen to tunnel status changes
  onTunnelStatusChange(() => {
    if (statusCallback) {
      statusCallback(getRemoteAccessStatus())
    }
  })
}

/**
 * Generate QR code data for easy mobile access
 */
export async function generateQRCode(includeToken: boolean = false): Promise<string | null> {
  const status = getRemoteAccessStatus()

  if (!status.enabled) {
    return null
  }

  // Prefer tunnel URL, fallback to LAN URL
  let url = status.tunnel.url || status.server.lanUrl

  if (!url) {
    return null
  }

  // Optionally include token in URL for auto-login
  if (includeToken && status.server.token) {
    url = `${url}?token=${status.server.token}`
  }

  try {
    const QRCode = await import('qrcode')
    return await QRCode.toDataURL(url, {
      width: 256,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#ffffff'
      }
    })
  } catch (error) {
    console.error('[Remote] Failed to generate QR code:', error)
    return null
  }
}

/**
 * Set a custom password for remote access.
 * @param password Custom password (8-64 chars, mixed case + digit + special)
 * @returns Object with success status and optional error message
 */
export function setCustomPassword(password: string): { success: boolean; error?: string } {
  if (!isServerRunning()) {
    return { success: false, error: 'Remote access is not enabled' }
  }

  const result = setCustomAccessToken(password)
  if (result.ok) {
    // Persist so the password survives restarts.
    persistRemotePassword(password)
    console.log('[Remote] Custom password set successfully')
    // Notify status change
    if (statusCallback) {
      statusCallback(getRemoteAccessStatus())
    }
    return { success: true }
  }
  return { success: false, error: result.error }
}

/**
 * Regenerate a random password for remote access
 */
export function regeneratePassword(): void {
  if (!isServerRunning()) {
    console.log('[Remote] Cannot regenerate password: remote access not enabled')
    return
  }

  const newToken = generateAccessToken()
  persistRemotePassword(newToken)
  console.log('[Remote] Password regenerated')

  // Notify status change
  if (statusCallback) {
    statusCallback(getRemoteAccessStatus())
  }
}

