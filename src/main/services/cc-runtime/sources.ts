import type { CcRuntimePreferences } from '../../../shared/types/cc-runtime'
import { getRuntime } from '../external-runtime'
export { PRESET_SOURCE_ID, isInstallVersion, validateSource } from '../external-runtime/compatibility'
export const getSources = (preferences?: CcRuntimePreferences) => getRuntime('anthropic').sources.getSources(preferences)
export const getEffectiveSourceId = (preferences?: CcRuntimePreferences) => getRuntime('anthropic').sources.getEffectiveSourceId(preferences)
export const validatePreferences = (preferences: CcRuntimePreferences) => getRuntime('anthropic').sources.validatePreferences(preferences)
