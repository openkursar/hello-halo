/**
 * Config IPC Handlers (v2)
 */

import { ipcMain } from 'electron'
import { getConfig, saveConfig } from '../services/config.service'
import { getAISourceManager } from '../services/ai-sources'
import { decryptString } from '../services/secure-storage.service'
import { validateApiConnection } from '../services/api-validator.service'
import { runConfigProbe, emitConfigChange } from '../services/health'
import type { AISourcesConfig, AISource } from '../../shared/types'

export function registerConfigHandlers(): void {
  // Get configuration
  ipcMain.handle('config:get', async () => {
    console.log('[Settings] config:get - Loading settings')
    try {
      const config = getConfig() as Record<string, any>

      // For v2 aiSources, decrypt API keys and tokens in sources array
      const decryptedConfig = { ...config }
      if (decryptedConfig.aiSources?.version === 2 && Array.isArray(decryptedConfig.aiSources.sources)) {
        decryptedConfig.aiSources = {
          ...decryptedConfig.aiSources,
          sources: decryptedConfig.aiSources.sources.map((source: AISource) => ({
            ...source,
            apiKey: source.apiKey ? decryptString(source.apiKey) : undefined,
            accessToken: source.accessToken ? decryptString(source.accessToken) : undefined,
            refreshToken: source.refreshToken ? decryptString(source.refreshToken) : undefined
          }))
        }
      }

      // Also handle legacy api.apiKey
      if (decryptedConfig.api?.apiKey) {
        decryptedConfig.api = {
          ...decryptedConfig.api,
          apiKey: decryptString(decryptedConfig.api.apiKey)
        }
      }

      console.log('[Settings] config:get - Loaded, aiSources v2, currentId:', decryptedConfig.aiSources?.currentId || 'none')
      return { success: true, data: decryptedConfig }
    } catch (error: unknown) {
      const err = error as Error
      console.error('[Settings] config:get - Failed:', err.message)
      return { success: false, error: err.message }
    }
  })

  // Save configuration
  ipcMain.handle('config:set', async (_event, updates: Record<string, unknown>) => {
    // Log what's being updated (without sensitive data)
    const updateKeys = Object.keys(updates)
    const aiSourcesCurrentId = (updates.aiSources as any)?.currentId
    console.log('[Settings] config:set - Saving:', updateKeys.join(', '), aiSourcesCurrentId ? `(currentId: ${aiSourcesCurrentId})` : '')

    try {
      const processedUpdates = { ...updates }
      const incomingAiSources = processedUpdates.aiSources as AISourcesConfig | undefined

      // v2 format: aiSources is replaced entirely (sources array is the source of truth)
      // No deep merging needed - frontend manages the complete sources array

      const config = saveConfig(processedUpdates)
      console.log('[Settings] config:set - Saved successfully')

      // Check if aiSources changed - run config validation
      if (incomingAiSources) {
        // Emit config change event for health monitoring
        emitConfigChange('aiSources updated')

        // Run config probe to validate (async, don't block response)
        runConfigProbe().then(result => {
          if (!result.healthy) {
            console.warn('[Settings] config:set - Validation warning:', result.message)
          }
        }).catch(err => {
          console.error('[Settings] config:set - Probe failed:', err)
        })
      }

      return { success: true, data: config }
    } catch (error: unknown) {
      const err = error as Error
      console.error('[Settings] config:set - Failed:', err.message)
      return { success: false, error: err.message }
    }
  })

  // Validate API connection via SDK
  ipcMain.handle(
    'config:validate-api',
    async (_event, apiKey: string, apiUrl: string, provider: string, model?: string) => {
      console.log('[Settings] config:validate-api - Validating:', provider, apiUrl ? `(url: ${apiUrl.slice(0, 30)}...)` : '(default url)', model ? `(model: ${model})` : '(no model)')
      try {
        const result = await validateApiConnection({
          apiKey,
          apiUrl,
          provider: provider as 'anthropic' | 'openai',
          model
        })
        console.log('[Settings] config:validate-api - Result:', result.valid ? 'valid' : 'invalid')
        return { success: true, data: result }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[Settings] config:validate-api - Failed:', err.message)
        return { success: false, error: err.message }
      }
    }
  )

  // Refresh AI sources configuration (auto-detects logged-in sources)
  ipcMain.handle('config:refresh-ai-sources', async () => {
    console.log('[Settings] config:refresh-ai-sources - Refreshing all AI sources')
    try {
      const manager = getAISourceManager()
      await manager.refreshAllConfigs()
      const config = getConfig()
      console.log('[Settings] config:refresh-ai-sources - Refreshed, current:', (config as any).aiSources?.current || 'custom')
      return { success: true, data: config }
    } catch (error: unknown) {
      const err = error as Error
      console.error('[Settings] config:refresh-ai-sources - Failed:', err.message)
      return { success: false, error: err.message }
    }
  })

  console.log('[Settings] Config handlers registered')
}
