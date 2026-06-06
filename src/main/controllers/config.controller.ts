/**		      	    				  	  	  	 		 		       	 	 	         	 	    					 
 * Config Controller - Unified business logic for configuration
 * Used by both IPC handlers and HTTP routes
 */

import {
  getConfig as serviceGetConfig,
  saveConfig as serviceSaveConfig
} from '../foundation/config.service'
import { maskConfigFields, unmaskSentinels } from '../foundation/config-encryption'
import { validateApiConnection, fetchModelsFromApi } from '../services/api-validator.service'

export interface ControllerResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

/**
 * Get current configuration. Sensitive fields (API keys, tokens,
 * passwords) are replaced with '***' so the HTTP / IPC boundary never
 * leaks credentials.
 */
export function getConfig(): ControllerResponse {
  try {
    const config = serviceGetConfig()
    return { success: true, data: maskConfigFields(config as Record<string, unknown>) }
  } catch (error: unknown) {
    const err = error as Error
    return { success: false, error: err.message }
  }
}

/**
 * Update configuration. '***' sentinels in the incoming payload are
 * replaced with the current value so unchanged secrets are preserved.
 */
export function setConfig(updates: Record<string, unknown>): ControllerResponse {
  try {
    const existing = serviceGetConfig() as Record<string, unknown>
    unmaskSentinels(updates, existing)
    const config = serviceSaveConfig(updates as any)
    return { success: true, data: maskConfigFields(config as Record<string, unknown>) }
  } catch (error: unknown) {
    const err = error as Error
    return { success: false, error: err.message }
  }
}

/**
 * Validate API connection via SDK
 */
export async function validateApi(
  apiKey: string,
  apiUrl: string,
  provider: string,
  model?: string
): Promise<ControllerResponse> {
  try {
    const result = await validateApiConnection({
      apiKey,
      apiUrl,
      provider: provider as 'anthropic' | 'openai',
      model
    })
    return {
      success: result.valid,
      data: {
        model: result.model,
        normalizedUrl: result.normalizedUrl
      },
      error: result.message
    }
  } catch (error: unknown) {
    const err = error as Error
    return { success: false, error: err.message }
  }
}

/**
 * Fetch available models from an OpenAI-compatible API endpoint
 */
export async function fetchModels(
  apiKey: string,
  apiUrl: string
): Promise<ControllerResponse> {
  try {
    const result = await fetchModelsFromApi({ apiKey, apiUrl })
    return { success: true, data: result }
  } catch (error: unknown) {
    const err = error as Error
    return { success: false, error: err.message }
  }
}
