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
 * Additionally, a `[1m]` suffix on the model id (CC's explicit 1M context
 * opt-in) raises the resolved contextWindow to 1M unless the user override
 * explicitly sets contextWindow — see `resolve()`.
 *
 * This service is purely in-memory — preset data is bundled with the app and
 * loaded at module initialisation time. It adds zero async I/O overhead.
 */

import presetData from '../../shared/data/model-capabilities.json'
import type {
  ModelCapability,
  ModelCapabilityOverride,
  ModelCapabilitiesPreset
} from '../../shared/types/model-capabilities'

/** Context window granted by the explicit `[1m]` model-id suffix */
const EXPLICIT_1M_CONTEXT_WINDOW = 1_000_000

/** Fallback values used when a model has no preset or pattern entry */
const DEFAULT_CAPABILITY: Omit<ModelCapability, 'displayName' | 'provider'> = {
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
  vision: false,
  thinking: false
}

/**
 * Normalise a model ID so proxy-prefixed and case-variant IDs can match.
 *
 * Examples:
 *   "Pro/zai-org/GLM-4.7"  → "glm-4.7"
 *   "Claude-Opus-4-6"      → "claude-opus-4-6"
 *   "deepseek-chat"        → "deepseek-chat"
 */
function normalizeModelId(raw: string): string {
  // Strip everything before the last slash (proxy routing prefixes)
  const lastSlash = raw.lastIndexOf('/')
  const base = lastSlash >= 0 ? raw.slice(lastSlash + 1) : raw
  return base.toLowerCase()
}

class ModelCapabilitiesService {
  private readonly preset: ModelCapabilitiesPreset
  /** Normalised-key → original-key lookup for the models map */
  private readonly normalisedModels: Map<string, string>
  /** Pattern prefixes sorted by length descending (longest match first) */
  private readonly sortedPatterns: Array<{ prefix: string; cap: ModelCapability }>

  constructor() {
    this.preset = presetData as ModelCapabilitiesPreset

    // Build normalised model lookup
    this.normalisedModels = new Map()
    for (const key of Object.keys(this.preset.models)) {
      this.normalisedModels.set(key.toLowerCase(), key)
    }

    // Build sorted pattern list (longest prefix first for greedy matching)
    this.sortedPatterns = []
    if (this.preset.patterns) {
      for (const [prefix, cap] of Object.entries(this.preset.patterns)) {
        this.sortedPatterns.push({ prefix: prefix.toLowerCase(), cap })
      }
      this.sortedPatterns.sort((a, b) => b.prefix.length - a.prefix.length)
    }

    console.log(
      `[ModelCapabilities] Loaded ${Object.keys(this.preset.models).length} model presets, ` +
      `${this.sortedPatterns.length} patterns (v${this.preset.version})`
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
  ): ModelCapability {
    const base: ModelCapability = this.findPreset(modelId) ?? {
      displayName: modelId,
      provider: 'unknown',
      ...DEFAULT_CAPABILITY
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
    return this.findPreset(modelId)
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

  // ── Internal helpers ────────────────────────────────────────────────

  /**
   * Try to find a preset via normalised exact match, then pattern fallback.
   */
  private findPreset(modelId: string): ModelCapability | null {
    const normalised = normalizeModelId(modelId)

    // 1. Exact match (case-insensitive, prefix-stripped)
    const originalKey = this.normalisedModels.get(normalised)
    if (originalKey) {
      return this.preset.models[originalKey]
    }

    // 2. Longest-prefix pattern match
    for (const { prefix, cap } of this.sortedPatterns) {
      if (normalised.startsWith(prefix)) {
        return cap
      }
    }

    return null
  }
}

// Singleton — module-level initialisation is safe; no async needed.
export const modelCapabilitiesService = new ModelCapabilitiesService()
