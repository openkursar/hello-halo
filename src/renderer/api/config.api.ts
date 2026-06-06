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
      return window.halo.setConfig(updates)
    }
    return httpRequest('POST', '/api/config', updates)
  },

  validateApi: async (
    apiKey: string,
    apiUrl: string,
    provider: string,
    model?: string
  ): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.validateApi(apiKey, apiUrl, provider, model)
    }
    return httpRequest('POST', '/api/config/validate', { apiKey, apiUrl, provider, model })
  },

  fetchModels: async (
    apiKey: string,
    apiUrl: string
  ): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.fetchModels(apiKey, apiUrl)
    }
    return httpRequest('POST', '/api/config/fetch-models', { apiKey, apiUrl })
  },

  refreshAISourcesConfig: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.refreshAISourcesConfig()
    }
    return httpRequest('POST', '/api/config/refresh-ai-sources')
  },

  // ===== AI Sources CRUD (atomic - backend reads from disk, never overwrites rotating tokens) =====
  aiSourcesSwitchSource: async (sourceId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.aiSourcesSwitchSource(sourceId)
    }
    return httpRequest('POST', '/api/ai-sources/switch-source', { sourceId })
  },

  aiSourcesSetModel: async (modelId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.aiSourcesSetModel(modelId)
    }
    return httpRequest('POST', '/api/ai-sources/set-model', { modelId })
  },

  aiSourcesAddSource: async (source: unknown): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.aiSourcesAddSource(source)
    }
    return httpRequest('POST', '/api/ai-sources/sources', source as Record<string, unknown>)
  },

  aiSourcesUpdateSource: async (sourceId: string, updates: unknown): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.aiSourcesUpdateSource(sourceId, updates)
    }
    return httpRequest('PUT', `/api/ai-sources/sources/${sourceId}`, updates as Record<string, unknown>)
  },

  aiSourcesDeleteSource: async (sourceId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.aiSourcesDeleteSource(sourceId)
    }
    return httpRequest('DELETE', `/api/ai-sources/sources/${sourceId}`)
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
   * Merges preset data with the supplied user overrides.
   */
  modelCapabilitiesResolve: async (
    modelId: string,
    overrides?: Record<string, Record<string, unknown>>
  ): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.modelCapabilitiesResolve(modelId, overrides)
    }
    return httpRequest('POST', '/api/model-capabilities/resolve', { modelId, overrides })
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
