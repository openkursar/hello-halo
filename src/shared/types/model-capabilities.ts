/**
 * Model Capabilities - Type Definitions
 *
 * Describes what each model can do (context window, vision, thinking, etc.).
 * Separates model capability metadata from AI source/channel configuration.
 *
 * Design:
 *   - Preset data lives in src/shared/data/model-capabilities.json
 *   - Users can override any field per-model inside their AISource config
 *   - Priority, highest first: user override > `[1m]` id suffix (contextWindow
 *     only) > exact preset entry > provider catalog data > family pattern
 *     entry > built-in defaults. A pattern is a family guess and ranks below
 *     the provider's live catalog; an exact entry is curated and ranks above
 *     it. Resolved in src/main/services/model-capabilities.service.ts.
 *   - Vision has its own resolution chain implemented in
 *     src/shared/constants/model-capabilities.ts — every consumer
 *     (renderer hint, backend config, image fallback) resolves through it.
 *
 * TODO(shared/models): this concern is spread across six files in four
 * directories — types/model-capabilities.ts, constants/model-capabilities.ts,
 * constants/model-runtime-limits.ts, data/model-capabilities.json,
 * model-catalog.ts and model-capability-overrides.ts. Nothing in the paths
 * tells a newcomer where capability resolution lives. Fold them into
 * `src/shared/models/` (preset-lookup / runtime-limits / catalog / overrides /
 * types). Deferred deliberately: it is an import-only move touching many
 * unrelated files and does not belong in a behavioural change.
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
  /**
   * Whether the model takes adaptive thinking (no token budget) on the
   * Anthropic Messages API. Absent = budget-based thinking.
   */
  adaptiveThinking?: boolean
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
  /** Allow Halo to opt the SDK-facing model into context above 200K. */
  extendedContext?: boolean
}

/** Provider-reported numeric limits from a model catalog. */
export interface CatalogModelCapability {
  contextWindow?: number
  maxOutputTokens?: number
}

/**
 * User-supplied partial override for a single model.
 * Only fields the user changes need to be present.
 */
export type ModelCapabilityOverride = Partial<ModelCapability> & UserModelSettings

/** Preset capability merged with catalog data and the user's own settings. */
export type ResolvedModelCapability = ModelCapability & UserModelSettings

/**
 * Substring lists driving the vision id-heuristic
 * (see shared/constants/model-capabilities.ts for the full chain).
 */
export interface VisionKeywordLists {
  /**
   * Substrings that mark a model vision-capable (e.g. "-vl", "vision").
   * Checked before the blocklist so entries like "glm-4v" are rescued from
   * the "glm-4" block entry.
   */
  allowlist: string[]
  /** Substrings that mark a model text-only (e.g. "deepseek", "glm-4") */
  blocklist: string[]
}

/** Top-level structure of model-capabilities.json */
export interface ModelCapabilitiesPreset {
  /** Schema version for future migration support */
  version: number
  /** ISO date of when this preset was last updated */
  updatedAt: string
  /** Substring lists for the vision id-heuristic */
  vision?: VisionKeywordLists
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
