/**		      	    				  	  	  	 		 		       	 	 	         	 	    					 
 * Config Controller - Unified business logic for configuration
 * Used by both IPC handlers and HTTP routes
 */

import {
  getConfig as serviceGetConfig,
  saveConfig as serviceSaveConfig,
  getCredentialDecodeFailures as serviceGetCredentialDecodeFailures,
  getConfigPath as serviceGetConfigPath,
  getConfigReadFailure as serviceGetConfigReadFailure,
  isConfigUnreadable as serviceIsConfigUnreadable
} from '../foundation/config.service'
import { maskConfigFields, unmaskSentinels } from '../foundation/config-encryption'
import { validateApiConnection, fetchModelsFromApi } from '../services/api-validator.service'
import { ModelFetchError } from '../../shared/model-fetch-error'
import { CONFIG_UNREADABLE_CODE } from '../../shared/rpc/contracts/config.contract'
import type { AISourcesConfig } from '../../shared/types/ai-sources'

export interface ControllerResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
  code?: string
}

/**
 * Get current configuration. Sensitive fields (API keys, tokens,
 * passwords) are replaced with '***' so the HTTP / IPC boundary never
 * leaks credentials.
 */
export function getConfig(): ControllerResponse {
  try {
    const config = serviceGetConfig()
    return { success: true, data: maskConfigFields(config as unknown as Record<string, unknown>) }
  } catch (error: unknown) {
    const err = error as Error
    return { success: false, error: err.message }
  }
}

/**
 * List credential fields that could not be decoded at rest. Returns only
 * path + human label (never ciphertext), so it is safe across the boundary.
 */
export function getCredentialFailures(): ControllerResponse {
  try {
    return { success: true, data: serviceGetCredentialDecodeFailures() }
  } catch (error: unknown) {
    const err = error as Error
    return { success: false, error: err.message }
  }
}

/** The config file that cannot be read, or null — for the warning shown at the top of the app. */
export function getConfigReadFailure(): ControllerResponse {
  try {
    return { success: true, data: serviceGetConfigReadFailure() }
  } catch (error: unknown) {
    const err = error as Error
    return { success: false, error: err.message }
  }
}

/**
 * The answer to a write that saveConfig kept in memory only because
 * config.json cannot be read; null when the write went through. Reporting
 * success here would have the user re-enter settings that are then dropped.
 */
export function notSavedWhileConfigUnreadable(): ControllerResponse | null {
  if (!serviceIsConfigUnreadable()) return null
  return {
    success: false,
    code: CONFIG_UNREADABLE_CODE,
    error: `Not saved: ${serviceGetConfigPath()} cannot be read, so saving is paused to protect its contents`,
  }
}

/** Managed account edits and selection use targeted APIs, never stale client snapshots. */
export function preserveManagedSources(updates: Record<string, unknown>, existing: Record<string, unknown>): void {
  const incoming = updates.aiSources as AISourcesConfig | undefined
  const current = existing.aiSources as AISourcesConfig | undefined
  if (updates.aiSources === undefined) return
  if (incoming?.version !== 2 || !Array.isArray(incoming.sources)) throw new Error('Invalid AI sources configuration')
  if (new Set(incoming.sources.map(source => source.id)).size !== incoming.sources.length) {
    throw new Error('Duplicate AI source ids')
  }
  const managed = (current?.version === 2 ? current.sources : []).filter(source => source.authType === 'oauth' || source.authType === 'delegated')
  const byId = new Map(managed.map(source => [source.id, source]))
  const sources = incoming.sources.flatMap(source => {
    const live = byId.get(source.id)
    if (live) return [live]
    return source.authType === 'oauth' || source.authType === 'delegated' ? [] : [source]
  })
  const includedIds = new Set(sources.map(source => source.id))
  for (const source of managed) {
    if (!includedIds.has(source.id)) sources.push(source)
  }
  const currentId = sources.some(source => source.id === current?.currentId)
    ? current!.currentId
    : sources.some(source => source.id === incoming.currentId) ? incoming.currentId : sources[0]?.id ?? null
  updates.aiSources = { ...incoming, sources, currentId }
}

/**
 * Update configuration. '***' sentinels in the incoming payload are
 * replaced with the current value so unchanged secrets are preserved.
 */
export function setConfig(updates: Record<string, unknown>): ControllerResponse {
  try {
    const existing = serviceGetConfig() as unknown as Record<string, unknown>
    unmaskSentinels(updates, existing)
    preserveManagedSources(updates, existing)
    const config = serviceSaveConfig(updates as any)
    const notSaved = notSavedWhileConfigUnreadable()
    if (notSaved) return notSaved
    return { success: true, data: maskConfigFields(config as unknown as Record<string, unknown>) }
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
    if (error instanceof ModelFetchError) {
      return {
        success: false,
        code: error.code,
        ...(error.detail ? { error: error.detail } : {})
      }
    }

    return {
      success: false,
      code: 'MODEL_FETCH_FAILED'
    }
  }
}
