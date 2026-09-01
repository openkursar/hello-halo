/**
 * ModelCapabilitiesService
 *
 * Resolves the effective capability of a model by merging:
 *   1. Built-in defaults (fallback when no preset exists)
 *   2. Preset data from model-capabilities.json (exact match → pattern match)
 *   3. Per-model user overrides stored in the AISource config
 *
 * Matching priority:
 *   1. Exact match on normalised model ID
 *   2. Longest-prefix match from the `patterns` section
 *   3. Built-in defaults
 *
 * Vision is the one exception to "preset blob wins": it is resolved by the
 * shared id-heuristic chain (`supportsVisionById`) so this service, the
 * OpenAI-compat router and the renderer input hint always produce the same
 * answer for the same model id.
 *
 * Additionally, a `[1m]` suffix on the model id (CC's explicit 1M context
 * opt-in) raises the resolved contextWindow to 1M unless the user override
 * explicitly sets contextWindow — see `resolve()`.
 *
 * This service is purely in-memory — preset data is bundled with the app and
 * loaded at module initialisation time. It adds zero async I/O overhead.
 */

import presetData from '../../shared/data/model-capabilities.json'
import {
  findModelPresetCapability,
  supportsVisionById
} from '../../shared/constants/model-capabilities'
import type {
  ModelCapability,
  ModelCapabilityOverride,
  ModelCapabilitiesPreset,
  ResolvedModelCapability
} from '../../shared/types/model-capabilities'

/** Context window granted by the explicit `[1m]` model-id suffix */
const EXPLICIT_1M_CONTEXT_WINDOW = 1_000_000

/**
 * Fallback values used when a model has no preset or pattern entry.
 * No `vision` here: that field is resolved by the shared id heuristic.
 */
const DEFAULT_CAPABILITY: Omit<ModelCapability, 'displayName' | 'provider' | 'vision'> = {
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
  thinking: false
}

class ModelCapabilitiesService {
  private readonly preset: ModelCapabilitiesPreset

  constructor() {
    this.preset = presetData as ModelCapabilitiesPreset

    console.log(
      `[ModelCapabilities] Loaded ${Object.keys(this.preset.models).length} model presets, ` +
      `${Object.keys(this.preset.patterns ?? {}).length} patterns (v${this.preset.version})`
    )
  }

  /**
   * Resolve the final capability for a model.
   *
   * Priority (highest → lowest):
   *   user override > `[1m]` model-id suffix (contextWindow only)
   *   > exact match > pattern match > built-in defaults
   *
   * @param modelId   The model identifier (e.g. "deepseek-chat", "Pro/zai-org/GLM-4.7")
   * @param overrides Optional map of per-model overrides from the AISource config
   */
  resolve(
    modelId: string,
    overrides?: Record<string, ModelCapabilityOverride>
  ): ResolvedModelCapability {
    const base: ModelCapability = {
      ...(findModelPresetCapability(modelId) ?? {
        displayName: modelId,
        provider: 'unknown',
        ...DEFAULT_CAPABILITY
      }),
      vision: supportsVisionById(modelId)
    }

    const userOverride = overrides?.[modelId]
    const merged =
      userOverride && Object.keys(userOverride).length > 0
        ? { ...base, ...userOverride }
        : base

    // A `[1m]` suffix in the model id is the user's explicit 1M context
    // opt-in (CC's documented convention). Preset/pattern/default windows
    // are guesses and must not silently shrink it; only an explicit
    // per-model contextWindow override — a more specific user action —
    // may still lower it.
    if (
      /\[1m\]$/i.test(modelId) &&
      !Number.isFinite(userOverride?.contextWindow) &&
      merged.contextWindow < EXPLICIT_1M_CONTEXT_WINDOW
    ) {
      return { ...merged, contextWindow: EXPLICIT_1M_CONTEXT_WINDOW }
    }

    return merged
  }

  /**
   * Return the preset for a model using the full matching chain:
   *   normalised exact match → longest prefix match → null.
   *
   * Does not apply user overrides — useful for "Reset to preset" and
   * for checking whether a preset exists (non-null = matched).
   */
  getPreset(modelId: string): ModelCapability | null {
    return findModelPresetCapability(modelId)
  }

  /** Return all exact-match preset model capability entries. */
  getAllPresets(): Record<string, ModelCapability> {
    return this.preset.models
  }

  /** Preset metadata (version, updatedAt). */
  getPresetMeta(): { version: number; updatedAt: string } {
    return {
      version: this.preset.version,
      updatedAt: this.preset.updatedAt
    }
  }
}

// Singleton — module-level initialisation is safe; no async needed.
export const modelCapabilitiesService = new ModelCapabilitiesService()
