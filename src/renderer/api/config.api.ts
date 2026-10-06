/**
 * configApi — config domain slice of the unified api object.
 * Split from the monolithic api/index.ts; transport branch (IPC vs HTTP) preserved.
 */
import {
  httpRequest,
  isElectron,
} from './_shared'
import type {
  ApiResponse,
} from './_shared'
import type { ModelOption, ModelRefreshSummary } from '../../shared/types'
import type { CatalogModelCapability, ModelCapabilityOverride } from '../../shared/types/model-capabilities'
import { CONFIG_UNREADABLE_CODE } from '../../shared/rpc/contracts/config.contract'

/** Window event raised when a settings write came back unsaved because config.json cannot be read. */
export const CONFIG_NOT_SAVED_EVENT = 'halo:config-not-saved'

/**
 * Raise CONFIG_NOT_SAVED_EVENT for a write the main process declined, and hand
 * the response back. Many callers ignore the result and show the new value as
 * saved; the event lets the app say otherwise in one place.
 */
export function reportIfNotSaved<T extends ApiResponse>(response: T): T {
  if (response?.code === CONFIG_UNREADABLE_CODE) {
    window.dispatchEvent(new CustomEvent(CONFIG_NOT_SAVED_EVENT))
  }
  return response
}

/** Result payload of `validateApi` (connection test). */
export interface ValidateApiResult {
  valid: boolean
  message?: string
  /** Server-canonicalized base URL; callers adopt it when it differs. */
  normalizedUrl?: string
}

/** Result payload of `fetchModels` (live model-list lookup). */
export interface FetchModelsResult {
  models: ModelOption[]
}

export const configApi = {
  // ===== Config =====
  getConfig: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.getConfig()
    }
    return httpRequest('GET', '/api/config')
  },

  setConfig: async (updates: Record<string, unknown>): Promise<ApiResponse> => {
    if (isElectron()) {
      return reportIfNotSaved(await window.halo.setConfig(updates))
    }
    return reportIfNotSaved(await httpRequest('POST', '/api/config', updates))
  },

  // Credential fields that could not be decoded at rest (alert banner source).
  getCredentialFailures: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.getCredentialFailures()
    }
    return httpRequest('GET', '/api/config/credential-failures')
  },

  // The config file when it cannot be read, or null (warning banner source).
  getConfigReadFailure: async (): Promise<ApiResponse<{ path: string } | null>> => {
    if (isElectron()) {
      return window.halo.getConfigReadFailure() as Promise<ApiResponse<{ path: string } | null>>
    }
    return httpRequest('GET', '/api/config/read-failure')
  },

  validateApi: async (
    apiKey: string,
    apiUrl: string,
    provider: string,
    model?: string
  ): Promise<ApiResponse<ValidateApiResult>> => {
    if (isElectron()) {
      return window.halo.validateApi(apiKey, apiUrl, provider, model) as Promise<ApiResponse<ValidateApiResult>>
    }
    return httpRequest('POST', '/api/config/validate', { apiKey, apiUrl, provider, model })
  },

  fetchModels: async (
    apiKey: string,
    apiUrl: string
  ): Promise<ApiResponse<FetchModelsResult>> => {
    if (isElectron()) {
      return window.halo.fetchModels(apiKey, apiUrl) as Promise<ApiResponse<FetchModelsResult>>
    }
    return httpRequest('POST', '/api/config/fetch-models', { apiKey, apiUrl })
  },

  refreshAISourcesConfig: async (): Promise<ApiResponse & { modelRefresh?: ModelRefreshSummary }> => {
    if (isElectron()) {
      return window.halo.refreshAISourcesConfig()
    }
    return httpRequest('POST', '/api/config/refresh-ai-sources')
  },

  // ===== AI Sources CRUD (atomic - backend reads from disk, never overwrites rotating tokens) =====
  aiSourcesSwitchSource: async (sourceId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return reportIfNotSaved(await window.halo.aiSourcesSwitchSource(sourceId))
    }
    return reportIfNotSaved(await httpRequest('POST', '/api/ai-sources/switch-source', { sourceId }))
  },

  aiSourcesSetModel: async (modelId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return reportIfNotSaved(await window.halo.aiSourcesSetModel(modelId))
    }
    return reportIfNotSaved(await httpRequest('POST', '/api/ai-sources/set-model', { modelId }))
  },

  aiSourcesAddSource: async (source: unknown): Promise<ApiResponse> => {
    if (isElectron()) {
      return reportIfNotSaved(await window.halo.aiSourcesAddSource(source))
    }
    return reportIfNotSaved(await httpRequest('POST', '/api/ai-sources/sources', source as Record<string, unknown>))
  },

  aiSourcesUpdateSource: async (sourceId: string, updates: unknown): Promise<ApiResponse> => {
    if (isElectron()) {
      return reportIfNotSaved(await window.halo.aiSourcesUpdateSource(sourceId, updates))
    }
    return reportIfNotSaved(
      await httpRequest('PUT', `/api/ai-sources/sources/${sourceId}`, updates as Record<string, unknown>)
    )
  },

  aiSourcesDeleteSource: async (sourceId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return reportIfNotSaved(await window.halo.aiSourcesDeleteSource(sourceId))
    }
    return reportIfNotSaved(await httpRequest('DELETE', `/api/ai-sources/sources/${sourceId}`))
  },

  // ===== CLI Config (desktop-only) =====
  cliConfigGetPaths: async (): Promise<ApiResponse> => {
    if (isElectron()) return window.halo.cliConfigGetPaths()
    return { success: false, error: 'CLI config not available in remote mode' }
  },

  cliConfigScanSkills: async (): Promise<ApiResponse> => {
    if (isElectron()) return window.halo.cliConfigScanSkills()
    return { success: false, error: 'CLI config not available in remote mode' }
  },

  cliConfigMigrateSkills: async (
    actions: Array<{ name: string; action: 'skip' | 'overwrite' | 'rename' }>
  ): Promise<ApiResponse> => {
    if (isElectron()) return window.halo.cliConfigMigrateSkills(actions)
    return { success: false, error: 'CLI config not available in remote mode' }
  },

  cliConfigScanMcp: async (): Promise<ApiResponse> => {
    if (isElectron()) return window.halo.cliConfigScanMcp()
    return { success: false, error: 'CLI config not available in remote mode' }
  },

  cliConfigMigrateMcp: async (
    actions: Array<{ name: string; action: 'skip' | 'overwrite' }>
  ): Promise<ApiResponse> => {
    if (isElectron()) return window.halo.cliConfigMigrateMcp(actions)
    return { success: false, error: 'CLI config not available in remote mode' }
  },

  cliConfigSetConfigDir: async (
    mode: 'halo' | 'cc' | 'custom',
    customDir?: string
  ): Promise<ApiResponse> => {
    if (isElectron()) return window.halo.cliConfigSetConfigDir(mode, customDir)
    return { success: false, error: 'CLI config not available in remote mode' }
  },

  // ===== Security Policy =====
  // Renderer-safe slice of the security policy from product.json. The
  // value cannot change at runtime, so consumers should cache the result
  // (see hooks/useSecurityPolicy.ts). Available in both Electron and
  // remote/web mode so every surface gates the same way.
  getSecurityPolicy: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.getSecurityPolicy()
    }
    return httpRequest('GET', '/api/security/policy')
  },

  // ===== Model Capabilities =====

  /**
   * Resolve the effective capability for a model.
   * Merges preset data and provider catalog data with the supplied user overrides.
   */
  modelCapabilitiesResolve: async (
    modelId: string,
    overrides?: Record<string, ModelCapabilityOverride>,
    catalogCapability?: CatalogModelCapability,
    catalogSupportsVision?: boolean
  ): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.modelCapabilitiesResolve(modelId, overrides, catalogCapability, catalogSupportsVision)
    }
    return httpRequest('POST', '/api/model-capabilities/resolve', {
      modelId,
      overrides,
      catalogCapability,
      catalogSupportsVision
    })
  },

  /**
   * Get the raw preset for a model (no user overrides applied).
   * Returns null data when no preset exists.
   */
  modelCapabilitiesGetPreset: async (modelId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.modelCapabilitiesGetPreset(modelId)
    }
    return httpRequest('GET', `/api/model-capabilities/preset/${encodeURIComponent(modelId)}`)
  },

  /**
   * Get all preset model capability entries as a flat map.
   */
  modelCapabilitiesAll: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.modelCapabilitiesAll()
    }
    return httpRequest('GET', '/api/model-capabilities/all')
  },

}
