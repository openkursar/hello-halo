/**
 * Model-capabilities RPC contract (pilot for the typed-RPC pattern).
 *
 * Declared once here; the main process registers handlers against it and the
 * preload bridge derives its invokers from it. The exposed method names match
 * the existing `window.halo.*` surface so renderer callers are unaffected.
 */

import { rpcMethod } from '../define'
import type { ModelCapability, ModelCapabilityOverride } from '../../types/model-capabilities'

export const modelCapabilitiesRpc = {
  modelCapabilitiesResolve: rpcMethod<
    [modelId: string, overrides?: Record<string, ModelCapabilityOverride>],
    ModelCapability
  >('model-capabilities:resolve'),

  modelCapabilitiesGetPreset: rpcMethod<
    [modelId: string],
    ModelCapability | null
  >('model-capabilities:preset'),

  modelCapabilitiesAll: rpcMethod<
    [],
    Record<string, ModelCapability>
  >('model-capabilities:all'),
}
