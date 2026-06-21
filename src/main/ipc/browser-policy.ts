/**
 * Browser Policy IPC
 *
 * Read/manage the user-extensible browser allowlist. Desktop-only by
 * design: there are no HTTP mirrors for the mutation handlers, and
 * POST /api/config additionally rejects remote `browser` writes — a remote
 * caller must never widen the browser security boundary.
 *
 * Mutations are also gated in browser-policy.service.ts (the handlers
 * reject with BROWSER_ALLOWLIST_NOT_EDITABLE when the build does not set
 * `browserPolicy.userExtensible`), so a renderer bug cannot bypass policy.
 */

import { ipcMain } from 'electron'
import {
  getBrowserPolicyView,
  addCustomAllowlistEntry,
  removeCustomAllowlistEntry,
} from '../services/browser-policy.service'

function toErrorResponse(error: unknown): { success: false; error: string; code?: string } {
  const err = error as Error & { code?: string }
  return { success: false, error: err.message, code: err.code }
}

export function registerBrowserPolicyHandlers(): void {
  ipcMain.handle('browser-policy:get', async () => {
    try {
      return { success: true, data: getBrowserPolicyView() }
    } catch (error: unknown) {
      console.error('[BrowserPolicy IPC] browser-policy:get failed:', (error as Error).message)
      return toErrorResponse(error)
    }
  })

  ipcMain.handle('browser-policy:add', async (_event, { pattern }: { pattern: string }) => {
    try {
      const normalized = addCustomAllowlistEntry(pattern)
      return { success: true, data: { pattern: normalized, ...getBrowserPolicyView() } }
    } catch (error: unknown) {
      console.error('[BrowserPolicy IPC] browser-policy:add failed:', (error as Error).message)
      return toErrorResponse(error)
    }
  })

  ipcMain.handle('browser-policy:remove', async (_event, { pattern }: { pattern: string }) => {
    try {
      removeCustomAllowlistEntry(pattern)
      return { success: true, data: getBrowserPolicyView() }
    } catch (error: unknown) {
      console.error('[BrowserPolicy IPC] browser-policy:remove failed:', (error as Error).message)
      return toErrorResponse(error)
    }
  })

  console.log('[BrowserPolicy IPC] Handlers registered')
}
