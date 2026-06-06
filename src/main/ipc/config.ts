/**
 * Config IPC Handlers (v2)
 */

import { getConfig, saveConfig } from '../foundation/config.service'
import { getAISourceManager } from '../services/ai-sources'
import { decryptString } from '../foundation/secure-storage.service'
import { maskConfigFields, unmaskSentinels } from '../foundation/config-encryption'
import { validateApiConnection, fetchModelsFromApi } from '../services/api-validator.service'
import { runConfigProbe, emitConfigChange } from '../services/health'
import type { AISourcesConfig, AISource } from '../../shared/types'
import { configRpc } from '../../shared/rpc/contracts/config.contract'
import { registerRawRpcHandlers } from './rpc'

export function registerConfigHandlers(): void {
  registerRawRpcHandlers(configRpc, {
    // Get configuration
    getConfig: async () => {
      console.log('[Settings] config:get - Loading settings')
      try {
        const config = getConfig() as Record<string, any>

        // Legacy secure-storage migration: old enc:-prefixed values are
        // decrypted to plaintext on read (decryptString handles both
        // encrypted and plain inputs transparently).
        if (config.aiSources?.version === 2 && Array.isArray(config.aiSources.sources)) {
          for (const source of config.aiSources.sources as AISource[]) {
            if (source.apiKey) source.apiKey = decryptString(source.apiKey)
            if (source.accessToken) source.accessToken = decryptString(source.accessToken)
            if (source.refreshToken) source.refreshToken = decryptString(source.refreshToken)
          }
        }
        if (config.api?.apiKey) {
          config.api.apiKey = decryptString(config.api.apiKey)
        }

        // Mask all sensitive fields before returning to renderer.
        const masked = maskConfigFields(config)

        console.log('[Settings] config:get - Loaded, aiSources v2, currentId:', config.aiSources?.currentId || 'none')
        return { success: true, data: masked }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[Settings] config:get - Failed:', err.message)
        return { success: false, error: err.message }
      }
    },

    // Save configuration
    setConfig: async (updates: Record<string, unknown>) => {
      // Log what's being updated (without sensitive data)
      const updateKeys = Object.keys(updates)
      console.debug('[IPC] config:set keys:', updateKeys.join(', '), updates.agent ? `agent=${JSON.stringify(updates.agent)}` : '')
      const incomingAiSources = (updates.aiSources as AISourcesConfig | undefined)
      const aiSourcesCurrentId = incomingAiSources?.currentId
      console.log('[Settings] config:set - Saving:', updateKeys.join(', '), aiSourcesCurrentId ? `(currentId: ${aiSourcesCurrentId})` : '')

      // Log detailed source info for debugging provider configuration issues
      if (incomingAiSources?.sources) {
        const currentSource = incomingAiSources.sources.find(s => s.id === aiSourcesCurrentId)
        if (currentSource) {
          console.log('[Settings] config:set - Current source:', {
            name: currentSource.name,
            provider: currentSource.provider,
            apiUrl: currentSource.apiUrl,
            model: currentSource.model,
            hasApiKey: !!currentSource.apiKey,
            availableModels: currentSource.availableModels?.length || 0
          })
        }
        console.log('[Settings] config:set - Total sources:', incomingAiSources.sources.length,
          'names:', incomingAiSources.sources.map(s => s.name).join(', '))
      }

      try {
        const processedUpdates = { ...updates }

        // v2 format: aiSources is replaced entirely (sources array is the source of truth)
        // No deep merging needed - frontend manages the complete sources array

        // Restore '***' sentinels to real values before saving.
        const existing = getConfig() as Record<string, unknown>
        unmaskSentinels(processedUpdates, existing)

        const config = saveConfig(processedUpdates)
        console.log('[Settings] config:set - Saved successfully')

        // Check if aiSources changed - run config validation
        if (incomingAiSources) {
          // Emit config change event for health monitoring
          emitConfigChange(['aiSources'])

          // Run config probe to validate (async, don't block response)
          runConfigProbe().then(result => {
            if (!result.healthy) {
              console.warn('[Settings] config:set - Validation warning:', result.message)
            }
          }).catch(err => {
            console.error('[Settings] config:set - Probe failed:', err)
          })
        }

        return { success: true, data: maskConfigFields(config as Record<string, unknown>) }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[Settings] config:set - Failed:', err.message)
        return { success: false, error: err.message }
      }
    },

    // Validate API connection via SDK
    validateApi: async (apiKey: string, apiUrl: string, provider: string, model?: string) => {
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
    },

    // Fetch available models from API endpoint
    fetchModels: async (apiKey: string, apiUrl: string) => {
      console.log('[Settings] config:fetch-models - Fetching from:', apiUrl ? `${apiUrl.slice(0, 30)}...` : '(no url)')
      try {
        const result = await fetchModelsFromApi({ apiKey, apiUrl })
        console.log('[Settings] config:fetch-models - Found', result.models.length, 'models')
        return { success: true, data: result }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[Settings] config:fetch-models - Failed:', err.message)
        return { success: false, error: err.message }
      }
    },

    // Refresh AI sources configuration (auto-detects logged-in sources)
    refreshAISourcesConfig: async () => {
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
    },

    // ===== AI Sources CRUD (atomic operations) =====
    // These handlers read from disk before writing, ensuring rotating tokens are never overwritten.

    // Switch current source
    aiSourcesSwitchSource: async (sourceId: string) => {
      console.log('[Settings] ai-sources:switch-source - Switching to:', sourceId)
      try {
        const manager = getAISourceManager()
        const result = manager.setCurrentSource(sourceId)
        if (result.currentId !== sourceId) {
          return { success: false, error: `Source not found: ${sourceId}` }
        }
        emitConfigChange(['aiSources.currentId'])
        runConfigProbe().catch(err => console.error('[Settings] ai-sources:switch-source - Probe failed:', err))
        return { success: true, data: result }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[Settings] ai-sources:switch-source - Failed:', err.message)
        return { success: false, error: err.message }
      }
    },

    // Set model for current source
    aiSourcesSetModel: async (modelId: string) => {
      console.log('[Settings] ai-sources:set-model - Setting model:', modelId)
      try {
        const manager = getAISourceManager()
        const result = manager.setCurrentModel(modelId)
        const src = manager.getCurrentSourceConfig()
        console.log(`[Config] model_changed source=${src?.id || ''} provider=${src?.provider || ''} model=${modelId}`)
        emitConfigChange(['aiSources.model'])
        return { success: true, data: result }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[Settings] ai-sources:set-model - Failed:', err.message)
        return { success: false, error: err.message }
      }
    },

    // Add new source
    aiSourcesAddSource: async (source: AISource) => {
      console.log('[Settings] ai-sources:add-source - Adding source:', source.name)
      try {
        const manager = getAISourceManager()
        const result = manager.addSource(source)
        emitConfigChange(['aiSources.sources'])
        runConfigProbe().catch(err => console.error('[Settings] ai-sources:add-source - Probe failed:', err))
        return { success: true, data: result }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[Settings] ai-sources:add-source - Failed:', err.message)
        return { success: false, error: err.message }
      }
    },

    // Update existing source (merges updates into disk state via manager.updateSource)
    aiSourcesUpdateSource: async (sourceId: string, updates: Partial<AISource>) => {
      console.log('[Settings] ai-sources:update-source - Updating:', sourceId)
      try {
        const manager = getAISourceManager()
        const result = manager.updateSource(sourceId, updates)
        emitConfigChange(['aiSources.sources'])
        runConfigProbe().catch(err => console.error('[Settings] ai-sources:update-source - Probe failed:', err))
        return { success: true, data: result }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[Settings] ai-sources:update-source - Failed:', err.message)
        return { success: false, error: err.message }
      }
    },

    // Delete source
    aiSourcesDeleteSource: async (sourceId: string) => {
      console.log('[Settings] ai-sources:delete-source - Deleting:', sourceId)
      try {
        const manager = getAISourceManager()
        const result = manager.deleteSource(sourceId)
        emitConfigChange(['aiSources.sources'])
        return { success: true, data: result }
      } catch (error: unknown) {
        const err = error as Error
        console.error('[Settings] ai-sources:delete-source - Failed:', err.message)
        return { success: false, error: err.message }
      }
    },
  })

  console.log('[Settings] Config handlers registered')
}
