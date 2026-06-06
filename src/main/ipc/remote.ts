/**
 * Remote Access IPC Handlers
 * Allows renderer to control remote access features
 */

import { BrowserWindow } from 'electron'
import {
  enableRemoteAccess,
  disableRemoteAccess,
  enableTunnel,
  disableTunnel,
  getRemoteAccessStatus,
  generateQRCode,
  onRemoteAccessStatusChange,
  setCustomPassword,
  regeneratePassword
} from '../services/remote.service'
import { getMainWindow, onMainWindowChange } from '../foundation/window.service'
import {
  isTunnelSafe,
  TUNNEL_DISABLED_BY_POLICY,
  TUNNEL_DISABLED_BY_POLICY_MESSAGE,
} from '../services/security-policy'
import { CredentialRestoreError } from '../http/auth/index'
import { remoteRpc } from '../../shared/rpc/contracts/remote.contract'
import { registerRawRpcHandlers } from './rpc'

let mainWindow: BrowserWindow | null = null

export function registerRemoteHandlers(): void {
  // Subscribe to window changes
  onMainWindowChange((window) => {
    mainWindow = window
  })

  registerRawRpcHandlers(remoteRpc, {
    // Enable remote access. Surfaces a stable `code` when the persisted
    // credential cannot be decoded so the renderer can render an actionable
    // hint (e.g. ask the user to re-pair devices) instead of a generic
    // error string.
    enableRemoteAccess: async (port?: number) => {
      console.log('[Settings] remote:enable - Enabling remote access', port ? `on port ${port}` : '')
      try {
        const status = await enableRemoteAccess(port)
        console.log('[Settings] remote:enable - Enabled, port:', status.port)
        return { success: true, data: status }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[Settings] remote:enable - Failed:', err.message)
        if (error instanceof CredentialRestoreError) {
          return { success: false, error: err.message, code: error.code }
        }
        return { success: false, error: err.message }
      }
    },

    // Disable remote access
    disableRemoteAccess: async () => {
      console.log('[Settings] remote:disable - Disabling remote access')
      try {
        await disableRemoteAccess()
        console.log('[Settings] remote:disable - Disabled')
        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[Settings] remote:disable - Failed:', err.message)
        return { success: false, error: err.message }
      }
    },

    // Enable tunnel — short-circuit at the IPC boundary when policy forbids
    // it so the service layer is not even reached. The renderer's tunnel
    // section is also hidden via useSecurityPolicy(), but defense in depth
    // still applies in case a stale renderer or remote client tries the
    // channel directly.
    enableTunnel: async () => {
      if (isTunnelSafe()) {
        console.warn('[Settings] remote:tunnel:enable - Blocked by security policy')
        return {
          success: false,
          error: TUNNEL_DISABLED_BY_POLICY_MESSAGE,
          code: TUNNEL_DISABLED_BY_POLICY,
        }
      }
      console.log('[Settings] remote:tunnel:enable - Enabling tunnel')
      try {
        const url = await enableTunnel()
        console.log('[Settings] remote:tunnel:enable - Enabled, url:', url)
        return { success: true, data: { url } }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[Settings] remote:tunnel:enable - Failed:', err.message)
        return { success: false, error: err.message }
      }
    },

    // Disable tunnel — intentionally NOT gated by tunnelSafe so the handler
    // can still clean up a tunnel that was running before the policy was
    // toggled on.
    disableTunnel: async () => {
      console.log('[Settings] remote:tunnel:disable - Disabling tunnel')
      try {
        await disableTunnel()
        console.log('[Settings] remote:tunnel:disable - Disabled')
        return { success: true }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[Settings] remote:tunnel:disable - Failed:', err.message)
        return { success: false, error: err.message }
      }
    },

    // Get status
    getRemoteStatus: async () => {
      try {
        const status = getRemoteAccessStatus()
        return { success: true, data: status }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[Settings] remote:status - Failed:', err.message)
        return { success: false, error: err.message }
      }
    },

    // Generate QR code
    getRemoteQRCode: async (includeToken?: boolean) => {
      console.log('[Settings] remote:qrcode - Generating QR code, includeToken:', includeToken)
      try {
        const qrCode = await generateQRCode(includeToken)
        console.log('[Settings] remote:qrcode - Generated')
        return { success: true, data: { qrCode } }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[Settings] remote:qrcode - Failed:', err.message)
        return { success: false, error: err.message }
      }
    },

    // Set custom password
    setRemotePassword: async (password: string) => {
      console.log('[Settings] remote:set-password - Setting custom password')
      try {
        const result = setCustomPassword(password)
        if (result.success) {
          console.log('[Settings] remote:set-password - Set successfully')
          return { success: true, data: getRemoteAccessStatus() }
        } else {
          console.warn('[Settings] remote:set-password - Validation failed:', result.error)
          return { success: false, error: result.error }
        }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[Settings] remote:set-password - Failed:', err.message)
        return { success: false, error: err.message }
      }
    },

    // Regenerate random password
    regenerateRemotePassword: async () => {
      console.log('[Settings] remote:regenerate-password - Regenerating password')
      try {
        regeneratePassword()
        console.log('[Settings] remote:regenerate-password - Regenerated')
        return { success: true, data: getRemoteAccessStatus() }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[Settings] remote:regenerate-password - Failed:', err.message)
        return { success: false, error: err.message }
      }
    },
  })

  // Set up status change listener
  onRemoteAccessStatusChange((status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('remote:status-change', status)
    }
  })

  console.log('[Settings] Remote handlers registered')
}
