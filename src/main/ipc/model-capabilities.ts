/**
 * IPC handlers for model capability queries.
 *
 * Channels (request/response):
 *   model-capabilities:resolve   — resolve final capability (preset + user overrides)
 *   model-capabilities:preset    — get raw preset for a single model
 *   model-capabilities:all       — get all presets (for UI browsing)
 *
 * Registered from the shared typed-RPC contract: the channel names, argument
 * shapes, and result types live in `shared/rpc/contracts/model-capabilities`
 * and the `{ success, data } | { success, error }` envelope + error logging
 * are applied uniformly by `registerRpcHandlers`. This is the reference
 * migration for the typed-RPC pattern.
 */

import { modelCapabilitiesService } from '../services/model-capabilities.service'
import { modelCapabilitiesRpc } from '../../shared/rpc/contracts/model-capabilities.contract'
import { registerRpcHandlers } from './rpc'
import { isCatalogModelCapability } from '../../shared/model-catalog'
import { validateModelCapabilityOverrides } from '../../shared/model-capability-overrides'

export function registerModelCapabilitiesHandlers(): void {
  registerRpcHandlers(
    modelCapabilitiesRpc,
    {
      modelCapabilitiesResolve: (modelId, overrides, catalogCapability, catalogSupportsVision) => {
        if (
          typeof modelId !== 'string'
          || !modelId.trim()
          || modelId !== modelId.trim()
          || modelId.length > 512
        ) {
          throw new Error('A model ID is required')
        }
        if (overrides !== undefined && !validateModelCapabilityOverrides(overrides)) {
          throw new Error('Invalid model capability overrides')
        }
        if (catalogCapability !== undefined && !isCatalogModelCapability(catalogCapability)) {
          throw new Error('Invalid catalog capability')
        }
        if (catalogSupportsVision !== undefined && typeof catalogSupportsVision !== 'boolean') {
          throw new Error('Invalid catalog vision flag')
        }
        return modelCapabilitiesService.resolve(
          modelId.trim(),
          overrides,
          catalogCapability,
          catalogSupportsVision
        )
      },
      modelCapabilitiesGetPreset: (modelId) =>
        modelCapabilitiesService.getPreset(modelId),
      modelCapabilitiesAll: () =>
        modelCapabilitiesService.getAllPresets(),
    },
    'ModelCapabilities',
  )
  console.log('[ModelCapabilities] IPC handlers registered')
}
