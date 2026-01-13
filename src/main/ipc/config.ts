/**
 * Config IPC Handlers
 */

import { ipcMain } from 'electron'
import { getConfig, saveConfig, validateApiConnection } from '../services/config.service'

export function registerConfigHandlers(): void {
  // Get configuration
  ipcMain.handle('config:get', async () => {
    try {
      const config = getConfig()
      return { success: true, data: config }
    } catch (error: unknown) {
      const err = error as Error
      return { success: false, error: err.message }
    }
  })

  // Save configuration
  ipcMain.handle('config:set', async (_event, updates: Record<string, unknown>) => {
    try {
      const config = saveConfig(updates)
      return { success: true, data: config }
    } catch (error: unknown) {
      const err = error as Error
      return { success: false, error: err.message }
    }
  })

  // Validate API connection
  ipcMain.handle(
    'config:validate-api',
    async (_event, apiKey: string, apiUrl: string, provider: string) => {
      try {
        const result = await validateApiConnection(apiKey, apiUrl, provider)
        return { success: true, data: result }
      } catch (error: unknown) {
        const err = error as Error
        return { success: false, error: err.message }
      }
    }
  )
}
