/**
 * Feishu IPC Handlers
 */

import { ipcMain } from 'electron'
import * as feishuController from '../controllers/feishu.controller'

export function registerFeishuHandlers(): void {
  // Get Feishu status
  ipcMain.handle('feishu:status', async () => {
    try {
      const configured = feishuController.isFeishuConfigured()
      const config = feishuController.getFeishuConfig()
      return {
        success: true,
        data: {
          configured,
          enabled: config.enabled,
          message: configured
            ? 'Feishu integration is configured'
            : 'Missing App ID or App Secret'
        }
      }
    } catch (error: unknown) {
      const err = error as Error
      return { success: false, error: err.message }
    }
  })

  // Get Feishu config (hide secret)
  ipcMain.handle('feishu:config', async () => {
    try {
      const config = feishuController.getFeishuConfig()
      return {
        success: true,
        data: {
          appId: config.appId,
          hasSecret: !!config.appSecret,
          enabled: config.enabled
        }
      }
    } catch (error: unknown) {
      const err = error as Error
      return { success: false, error: err.message }
    }
  })

  // Save Feishu config
  ipcMain.handle('feishu:save-config', async (_event, config: {
    appId?: string
    appSecret?: string
    enabled?: boolean
  }) => {
    try {
      const result = feishuController.saveFeishuConfig(config)
      return result
    } catch (error: unknown) {
      const err = error as Error
      return { success: false, error: err.message }
    }
  })

  // Send message to Feishu
  ipcMain.handle('feishu:send', async (_event, chatId: string, message: string) => {
    try {
      const result = await feishuController.sendFeishuMessage(chatId, message)
      return result
    } catch (error: unknown) {
      const err = error as Error
      return { success: false, error: err.message }
    }
  })
}
