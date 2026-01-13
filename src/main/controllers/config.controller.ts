/**
 * Config Controller - Unified business logic for configuration
 * Used by both IPC handlers and HTTP routes
 */

import {
  getConfig as serviceGetConfig,
  saveConfig as serviceSaveConfig,
  validateApiConnection as serviceValidateApiConnection
} from '../services/config.service'

export interface ControllerResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

/**
 * Get current configuration
 */
export function getConfig(): ControllerResponse {
  try {
    const config = serviceGetConfig()
    return { success: true, data: config }
  } catch (error: unknown) {
    const err = error as Error
    return { success: false, error: err.message }
  }
}

/**
 * Update configuration
 */
export function setConfig(updates: Record<string, unknown>): ControllerResponse {
  try {
    const config = serviceSaveConfig(updates as any)
    return { success: true, data: config }
  } catch (error: unknown) {
    const err = error as Error
    return { success: false, error: err.message }
  }
}

/**
 * Validate API connection
 */
export async function validateApi(
  apiKey: string,
  apiUrl: string,
  provider: string
): Promise<ControllerResponse> {
  try {
    const result = await serviceValidateApiConnection(apiKey, apiUrl, provider)
    return {
      success: result.valid,
      data: { model: result.model },
      error: result.message
    }
  } catch (error: unknown) {
    const err = error as Error
    return { success: false, error: err.message }
  }
}
