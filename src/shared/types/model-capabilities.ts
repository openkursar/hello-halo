/**
 * Model Capabilities - Type Definitions
 *
 * Describes what each model can do (context window, vision, thinking, etc.).
 * Separates model capability metadata from AI source/channel configuration.
 *
 * Design:
 *   - Preset data lives in src/shared/data/model-capabilities.json
 *   - Users can override any field per-model inside their AISource config
 *   - Priority: user override > JSON preset > built-in defaults
 */

import type { ReasoningEffortSetting } from '../constants/reasoning-effort'

/** Full capability description for a single model */
export interface ModelCapability {
  /** Human-readable model name */
  displayName: string
  /** Owning provider (e.g. 'deepseek', 'qwen', 'anthropic', 'openai') */
  provider: string
  /** Maximum context window in tokens */
  contextWindow: number
  /** Maximum output tokens per response */
  maxOutputTokens: number
  /** Whether the model accepts image input */
  vision: boolean
  /** Whether the model supports extended thinking / reasoning mode */
  thinking: boolean
}

/**
 * Model settings that exist only as a user choice.
 *
 * Deliberately outside {@link ModelCapability}: a value here is always
 * something the user typed, which is what lets the engine paths forward an
 * unrecognized level to the upstream instead of clamping it. A preset able to
 * declare one would send that unclamped value to users who never opted in.
 */
export interface UserModelSettings {
  /**
   * How hard this model should think while the chat "Deep Thinking" toggle is
   * on. Absent = Halo's default level.
   */
  reasoningEffort?: ReasoningEffortSetting
}

/**
 * User-supplied partial override for a single model.
 * Only fields the user changes need to be present.
 */
export type ModelCapabilityOverride = Partial<ModelCapability> & UserModelSettings

/** Preset capability merged with the user's own settings. */
export type ResolvedModelCapability = ModelCapability & UserModelSettings

/** Top-level structure of model-capabilities.json */
export interface ModelCapabilitiesPreset {
  /** Schema version for future migration support */
  version: number
  /** ISO date of when this preset was last updated */
  updatedAt: string
  /**
   * Prefix-based fallback patterns.
   * When no exact match exists in `models`, the service tries the longest
   * matching prefix from this map. Useful for model families where all
   * variants share the same capabilities (e.g. all Claude Opus → 200K).
   */
  patterns?: Record<string, ModelCapability>
  /** Map of model ID → capability data */
  models: Record<string, ModelCapability>
}
