import { getDefaultEngine } from '../services/agent'
import { isEngineId } from '../../shared/types/engine'
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
  getConfigReadFailureCount as serviceGetConfigReadFailureCount,
  isConfigUnreadable as serviceIsConfigUnreadable,
  recordAgentEngineChoice,
} from '../foundation/config.service'
import { maskConfigFields, unmaskSentinels } from '../foundation/config-encryption'
import { getProductFederationGatewayUrl } from '../foundation/product-config'
import { validateApiConnection, fetchModelsFromApi } from '../services/api-validator.service'
import { ModelFetchError } from '../../shared/model-fetch-error'
import { CONFIG_RELOAD_REQUIRED_CODE, CONFIG_UNREADABLE_CODE, type ConfigReadMetadata } from '../../shared/rpc/contracts/config.contract'
import type { AISourcesConfig } from '../../shared/types/ai-sources'

export interface ControllerResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
  code?: string
}

export function getConfigReadMetadata(): ConfigReadMetadata {
  return {
    configEpoch: configSnapshotEpoch(),
    productDefaults: {
      federation: { gatewayUrl: getProductFederationGatewayUrl()?.trim() || null },
    },
  }
}

/** Credentials stay masked; build defaults stay outside the user-config payload. */
export function getConfig(): ControllerResponse & ConfigReadMetadata {
  try {
    const config = serviceGetConfig()
    return {
      success: true,
      data: maskConfigFields(config as unknown as Record<string, unknown>),
      ...getConfigReadMetadata(),
    }
  } catch (error: unknown) {
    const err = error as Error
    return { success: false, error: err.message }
  }
}

/**
 * Stamp for the settings a client loads with the read just made: how many
 * reads had failed by then, or -1 when this read itself fell back to the
 * defaults. Sent as `configEpoch`; a whole-settings save hands it back.
 */
export function configSnapshotEpoch(): number {
  return serviceIsConfigUnreadable() ? -1 : serviceGetConfigReadFailureCount()
}

/**
 * The answer to a whole-settings save built on settings loaded before the
 * latest failed read, or during it; null when it may go ahead. Call it after
 * this save's own read of the config.
 *
 * Such settings may be the built-in defaults, or carry changes that were
 * refused while the file could not be read. Written back once the file reads
 * again, they would replace what it holds — every IM channel and notification
 * channel among them. A save that sends no stamp is not judged here.
 */
export function reloadRequiredBeforeSave(snapshotEpoch: number | undefined): ControllerResponse | null {
  if (snapshotEpoch === undefined || serviceIsConfigUnreadable()) return null
  if (snapshotEpoch === serviceGetConfigReadFailureCount()) return null
  return {
    success: false,
    code: CONFIG_RELOAD_REQUIRED_CODE,
    error: 'Not saved: these settings were loaded before the configuration file could be read; reload them and make the change again',
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
 * `snapshotEpoch` is the stamp of the settings the client built this save on.
 */
export function updateConfig(updates: Record<string, unknown>, snapshotEpoch?: number): ControllerResponse {
  try {
    const existing = serviceGetConfig() as unknown as Record<string, unknown>
    const reloadRequired = reloadRequiredBeforeSave(snapshotEpoch)
    if (reloadRequired) return reloadRequired
    const agent = updates.agent
    if (agent && typeof agent === 'object' && 'ccRuntime' in agent) {
      const stored = (existing.agent as Record<string, unknown> | undefined)?.ccRuntime
      if (JSON.stringify(agent.ccRuntime) !== JSON.stringify(stored)) {
        console.warn('[Config] Ignored externally supplied CC runtime settings; preserving the runtime manager selection')
      }
      const { ccRuntime: _runtime, ...preferences } = agent
      updates.agent = preferences
    }
    if (updates.agent && typeof updates.agent === 'object') {
      const { legacySdkEngine: _legacyEngine, ...preferences } = updates.agent as Record<string, unknown>
      const storedAgent = existing.agent as Record<string, unknown> | undefined
      if ('sdkEngine' in preferences && !isEngineId(preferences.sdkEngine)) throw new Error('Unknown agent engine')
      if (isEngineId(preferences.sdkEngine) && preferences.sdkEngine !== (storedAgent?.sdkEngine ?? 'halo') && !isEngineId(storedAgent?.legacySdkEngine)) {
        preferences.legacySdkEngine = getDefaultEngine()
      }
      updates.agent = preferences
    }
    unmaskSentinels(updates, existing)
    preserveManagedSources(updates, existing)
    const config = serviceSaveConfig(updates as any)
    const notSaved = notSavedWhileConfigUnreadable()
    if (notSaved) return notSaved
    if (agent && typeof agent === 'object' && 'sdkEngine' in agent) recordAgentEngineChoice()
    return { success: true, data: config }
  } catch (error: unknown) {
    const err = error as Error
    return { success: false, error: err.message }
  }
}

/** Remote callers receive masked secrets; desktop IPC applies its own response masking. */
export function setConfig(updates: Record<string, unknown>, snapshotEpoch?: number): ControllerResponse {
  const result = updateConfig(updates, snapshotEpoch)
  if (result.success) return { ...result, data: maskConfigFields(result.data as Record<string, unknown>) }
  return result
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
