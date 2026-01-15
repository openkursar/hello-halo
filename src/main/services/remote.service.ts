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
  onTunnelStatusChange
} from './tunnel.service'
import { getConfig, saveConfig } from './config.service'
import { setCustomAccessToken, generateAccessToken } from '../http/auth'

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
 * Get local network IP address
 */
function getLocalIp(): string | null {
  const interfaces = networkInterfaces()

  for (const name of Object.keys(interfaces)) {
    const iface = interfaces[name]
    if (!iface) continue

    for (const info of iface) {
      // Skip internal and non-IPv4 addresses
      if (info.internal || info.family !== 'IPv4') continue

      // Return the first valid IP
      return info.address
    }
  }

  return null
}

/**
 * Enable remote access (start HTTP server)
 */
export async function enableRemoteAccess(
  mainWindow: BrowserWindow | null,
  port?: number
): Promise<RemoteAccessStatus> {
  if (isServerRunning()) {
    return getRemoteAccessStatus()
  }

  const { port: actualPort, token } = await startHttpServer(mainWindow, port)

  // Update config
  const config = getConfig()
  saveConfig({
    ...config,
    remoteAccess: {
      ...config.remoteAccess,
      enabled: true,
      port: actualPort
    }
  })

  return getRemoteAccessStatus()
}

/**
 * Disable remote access (stop HTTP server and tunnel)
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
 * Start tunnel for external access
 */
export async function enableTunnel(): Promise<string> {
  const serverInfo = getServerInfo()

  if (!serverInfo.running) {
    throw new Error('HTTP server is not running. Enable remote access first.')
  }

  const url = await startTunnel(serverInfo.port)
  return url
}

/**
 * Stop tunnel
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
 * Set a custom password for remote access
 * @param password Custom password (4-32 alphanumeric characters)
 * @returns Object with success status and optional error message
 */
export function setCustomPassword(password: string): { success: boolean; error?: string } {
  if (!isServerRunning()) {
    return { success: false, error: 'Remote access is not enabled' }
  }

  const result = setCustomAccessToken(password)
  if (result) {
    console.log('[Remote] Custom password set successfully')
    // Notify status change
    if (statusCallback) {
      statusCallback(getRemoteAccessStatus())
    }
    return { success: true }
  } else {
    return { success: false, error: 'Password must be 4-32 alphanumeric characters' }
  }
}

/**
 * Regenerate a random password for remote access
 */
export function regeneratePassword(): void {
  if (!isServerRunning()) {
    console.log('[Remote] Cannot regenerate password: remote access not enabled')
    return
  }

  generateAccessToken()
  console.log('[Remote] Password regenerated')

  // Notify status change
  if (statusCallback) {
    statusCallback(getRemoteAccessStatus())
  }
}

