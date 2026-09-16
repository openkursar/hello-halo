import presetData from '../../shared/data/model-capabilities.json'
import {
  findModelPresetCapability,
  findModelPresetMatch,
  supportsVisionById
} from '../../shared/constants/model-capabilities'
import { sanitizeCatalogModelCapability } from '../../shared/model-catalog'
import { validateModelCapabilityOverride } from '../../shared/model-capability-overrides'
import type {
  CatalogModelCapability,
  ModelCapability,
  ModelCapabilityOverride,
  ModelCapabilitiesPreset,
  ResolvedModelCapability
} from '../../shared/types/model-capabilities'

const EXPLICIT_1M_CONTEXT_WINDOW = 1_000_000

/**
 * Used only when nothing else knows the model: no preset, no family pattern,
 * no catalog entry. 200K matches CC's own assumption for an unrecognised
 * model, so it neither inflates nor shrinks what CC would have done.
 *
 * `maxOutputTokens` here is a guess and is deliberately never injected as
 * CLAUDE_CODE_MAX_OUTPUT_TOKENS — see `maxOutputTokensConfigured` in
 * agent/types.ts. It exists so the Model Config panel has a number to show.
 *
 * No `vision`: that field is owned by the id chain (see `resolve`).
 */
const DEFAULT_CAPABILITY: Omit<ModelCapability, 'displayName' | 'provider' | 'vision'> = {
  contextWindow: 200_000,
  maxOutputTokens: 64_000,
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
   * @param catalogSupportsVision `ModelOption.supportsVision` for this model,
   *   when the source states one. Keeps this result in step with
   *   `resolveModelVision`, which the router and the chat input answer through
   *   — without it the Vision checkbox can read the opposite of what the wire
   *   does.
   */
  resolve(
    modelId: string,
    overrides?: Record<string, ModelCapabilityOverride>,
    catalogCapability?: CatalogModelCapability,
    catalogSupportsVision?: boolean
  ): ResolvedModelCapability {
    const match = findModelPresetMatch(modelId)
    const catalog = sanitizeCatalogModelCapability(catalogCapability)
    // Lowest to highest. A family `pattern` sits below the provider's live
    // catalog: Codex slugs have no entry of their own and land on `gpt-5`,
    // whose 200K window is not theirs. A deliberate per-model `exact` entry
    // sits above it — those are curated, and many proxies report one blanket
    // limit for every model they front.
    //
    // Spread rather than alias: the preset table hands back a shared object
    // and this result is handed to callers.
    const base: ModelCapability = {
      displayName: modelId,
      provider: 'unknown',
      ...DEFAULT_CAPABILITY,
      ...(match?.kind === 'pattern' ? match.capability : {}),
      ...catalog,
      ...(match?.kind === 'exact' ? match.capability : {}),
      // The id chain also reads allow/blocklist substring signals no preset
      // blob can express, and the router and the renderer input gate both
      // answer through it. A disagreement here strips images the UI calls fine.
      vision: catalogSupportsVision ?? supportsVisionById(modelId)
    }
    const rawOverride = overrides?.[modelId]
    const overrideValidation = validateModelCapabilityOverride(rawOverride)
    if (rawOverride !== undefined && !overrideValidation.valid) {
      console.warn(
        `[ModelCapabilities] Discarding malformed override for "${modelId}" ` +
        `(${overrideValidation.error}); falling back to the resolved values.`
      )
    }
    const userOverride = overrideValidation.valid ? overrideValidation.value : undefined
    const merged = userOverride && Object.keys(userOverride).length > 0
      ? { ...base, ...userOverride }
      : base

    // A `[1m]` suffix is CC's documented 1M opt-in, typed by the user into the
    // model id itself. Presets, patterns and catalogs are all guesses about a
    // bare id and must not silently shrink it; only a per-model contextWindow
    // override — a more specific act by the same user — may still lower it.
    if (
      /\[1m\]$/i.test(modelId)
      && !Number.isFinite(userOverride?.contextWindow)
      && merged.contextWindow < EXPLICIT_1M_CONTEXT_WINDOW
    ) {
      return { ...merged, contextWindow: EXPLICIT_1M_CONTEXT_WINDOW }
    }

    return merged
  }

  getPreset(modelId: string): ModelCapability | null {
    return findModelPresetCapability(modelId)
  }

  getAllPresets(): Record<string, ModelCapability> {
    return this.preset.models
  }

  getPresetMeta(): { version: number; updatedAt: string } {
    return {
      version: this.preset.version,
      updatedAt: this.preset.updatedAt
    }
  }
}

export const modelCapabilitiesService = new ModelCapabilitiesService()
