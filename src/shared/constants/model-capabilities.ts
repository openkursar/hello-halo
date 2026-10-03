/**
 * Model Capabilities — Capability Detection From Model IDs
 *
 * Provides unified query functions for capability inference from a model id
 * string. Currently covers:
 *   - Vision support: used by InputArea to block image input for non-vision
 *     models, and by the OpenAI-compat router to strip image blocks.
 *   - Reasoning model detection: used by the OpenAI-compat router to pick the
 *     correct output-length parameter (`max_completion_tokens` for reasoning
 *     models, `max_tokens` otherwise). OpenAI rejects `max_tokens` on the
 *     o1/o3/o4-mini and gpt-5-thinking families with HTTP 400.
 *
 * Vision resolution order, from a model id alone (data lives in
 * src/shared/data/model-capabilities.json):
 *   1. Exact `models` entry naming the complete id — a deliberate per-model
 *      statement (e.g. glm-5.3-flash is multimodal while the rest of the
 *      glm-5 family is not). Proxy-prefixed ids fall through.
 *   2. `vision.allowlist` substring hit anywhere in the full id, proxy
 *      prefixes included (e.g. "-vl", "vision", "omni")
 *   3. `vision.blocklist` substring hit anywhere in the full id
 *      (e.g. "deepseek", "glm-4")
 *   4. Normalised-id preset entry — exact match, then longest-prefix
 *      `patterns` family default; consulted only when no substring signal
 *      fired
 *   5. Default: true (unknown models pass through, no false blocking)
 *
 * Callers holding an AI source use {@link resolveModelVision} instead: it adds
 * the per-model override layer on top and is the one answer every consumer
 * (renderer hint, backend config, image fallback) must share.
 */

import presetData from '../data/model-capabilities.json'
import type { ModelOption } from '../types/ai-sources'
import type {
  ModelCapability,
  ModelCapabilitiesPreset
} from '../types/model-capabilities'

// ─────────────────────────────────────────────────────────────────────────────
// Preset lookup — shared with ModelCapabilitiesService
// ─────────────────────────────────────────────────────────────────────────────

const preset = presetData as ModelCapabilitiesPreset

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
  return (lastSlash >= 0 ? raw.slice(lastSlash + 1) : raw).toLowerCase()
}

/** Normalised key → exact `models` entry */
const normalisedModels = new Map<string, ModelCapability>(
  Object.entries(preset.models).map(([key, cap]) => [key.toLowerCase(), cap])
)

/** Pattern prefixes sorted longest-first so the most specific family wins */
const sortedPatterns: ReadonlyArray<{ prefix: string; cap: ModelCapability }> =
  Object.entries(preset.patterns ?? {})
    .map(([prefix, cap]) => ({ prefix: prefix.toLowerCase(), cap }))
    .sort((a, b) => b.prefix.length - a.prefix.length)

/**
 * Preset lookup for a wire model id: normalised exact match, then
 * longest-prefix pattern match, else null.
 *
 * Shared with ModelCapabilitiesService so the vision heuristic below and the
 * capability service always walk the same preset data.
 */
export function findModelPresetCapability(modelId: string): ModelCapability | null {
  return findModelPresetMatch(modelId)?.capability ?? null
}

/**
 * How the preset was reached, for callers that rank it against other sources.
 *
 * An `exact` entry names one model deliberately. A `pattern` entry is only a
 * family default — Codex slugs like `gpt-5.6-sol` have no entry of their own
 * and land on `gpt-5`, whose window is not theirs. A provider's live catalog
 * is the better answer than a family default, and the worse answer than a
 * deliberate per-model statement.
 */
export interface ModelPresetMatch {
  kind: 'exact' | 'pattern'
  capability: ModelCapability
}

export function findModelPresetMatch(modelId: string): ModelPresetMatch | null {
  const normalized = normalizeModelId(modelId)
  const exact = normalisedModels.get(normalized)
  if (exact) return { kind: 'exact', capability: exact }
  const pattern = sortedPatterns.find(p => normalized.startsWith(p.prefix))
  return pattern ? { kind: 'pattern', capability: pattern.cap } : null
}

/**
 * Infer vision support from a model ID (see the file header for the full
 * resolution order).
 */
function inferVisionSupport(modelId: string): boolean {
  const lower = modelId.toLowerCase()

  // A per-model statement that names the complete id wins outright — it is
  // how a multimodal variant inside a text-only family (glm-5.3-flash inside
  // glm-5) is expressed. The lookup also tries the id with its routing prefix
  // stripped, so a gateway id like "Pro/zai-org/GLM-5.3-Flash" still resolves
  // to the same statement as the bare id. That stripped prefix is discarded
  // only when it is itself inert: a prefix carrying its own blocklist signal
  // ("deepseek-proxy/gpt-4o") means the id was rewritten into another
  // family's name space, and that signal must still be honored.
  const normalized = normalizeModelId(modelId)
  const full = normalisedModels.get(normalized)
  if (full) {
    const prefix = lower.slice(0, lower.length - normalized.length)
    const prefixCarriesBlocklistSignal = preset.vision?.blocklist.some(p => prefix.includes(p))
    if (!prefixCarriesBlocklistSignal) return full.vision
  }

  const lists = preset.vision
  if (lists?.allowlist.some(kw => lower.includes(kw))) return true
  if (lists?.blocklist.some(p => lower.includes(p))) return false

  return findModelPresetCapability(modelId)?.vision ?? true
}

/**
 * Check if a model supports vision (image) input.
 *
 * Resolution order:
 *   1. Explicit ModelOption.supportsVision (provider or user set) — highest priority
 *   2. Id heuristic (see file header)
 *   3. Default true (unknown models pass through)
 */
export function supportsVision(model: ModelOption): boolean {
  if (model.supportsVision !== undefined) return model.supportsVision
  return inferVisionSupport(model.id)
}

/**
 * Check vision support by model ID alone.
 *
 * Used by the openai-compat router where only the request body's `model`
 * string is available (no `ModelOption` reference). Skips the explicit
 * `ModelOption.supportsVision` override — for full UI-facing checks use
 * {@link supportsVision} with the resolved ModelOption.
 *
 * Behavior matches {@link supportsVision} step 2-3 (id heuristic, default
 * true for unknown IDs).
 */
export function supportsVisionById(modelId: string | undefined | null): boolean {
  if (!modelId) return true
  return inferVisionSupport(modelId)
}

/**
 * Minimal shape {@link resolveModelVision} reads from an AI source. Declared
 * structurally so the renderer, the source manager and tests can all pass what
 * they hold without importing the full AISource type.
 */
export interface VisionCapabilitySource {
  modelOverrides?: Record<string, { vision?: boolean } | undefined>
  availableModels?: ModelOption[]
}

/**
 * Effective vision capability for `modelId` within `source` — the single
 * answer to "can this model accept image blocks".
 *
 * Renderer (input hint), source manager (backend config) and the image
 * fallback must agree: a split decision shows the user "images go through OCR"
 * while the request still carries image parts, which strict providers reject
 * outright. Every caller resolves through here.
 *
 * Resolution order:
 *   1. `modelOverrides[modelId].vision` — the user's Model Config setting, or
 *      a capability the provider's catalog declared. Keyed by the wire model
 *      id, the same key Model Config writes.
 *   2. Provider-declared `ModelOption.supportsVision`
 *   3. Id heuristic (see file header for the resolution order)
 */
export function resolveModelVision(
  source: VisionCapabilitySource | null | undefined,
  modelId: string | undefined | null
): boolean {
  if (!source || !modelId) return supportsVisionById(modelId)

  const override = source.modelOverrides?.[modelId]?.vision
  if (typeof override === 'boolean') return override

  const model = source.availableModels?.find(m => m.id === modelId)
  return model ? supportsVision(model) : supportsVisionById(modelId)
}

/**
 * Known reasoning model prefixes.
 *
 * OpenAI's reasoning family (o1, o3, o4-mini, gpt-5 thinking variants)
 * deprecates `max_tokens` and only accepts `max_completion_tokens`. Matching
 * these ids lets the OpenAI-compat router emit the right field and avoid an
 * upstream 400. Prefixes are matched with a token-boundary guard (see
 * {@link isReasoningModelById}) so substrings like "gpt-4o-1" are not trapped
 * and version suffixes (e.g. `-2024-12-17`, `-mini`) are still covered.
 */
const REASONING_MODEL_PREFIXES: string[] = [
  // OpenAI reasoning family — rejects max_tokens, accepts max_completion_tokens
  'o1', 'o3', 'o4',
  // GPT-5 thinking variants — same restriction
  'gpt-5-thinking', 'gpt-5-reasoning'
]

/**
 * Check whether a model id belongs to a reasoning model that requires
 * `max_completion_tokens` instead of `max_tokens` on OpenAI-compatible
 * Chat Completions endpoints. Used by the openai-compat router where only
 * the request body's `model` string is available.
 */
export function isReasoningModelById(modelId: string | undefined | null): boolean {
  if (!modelId) return false
  const lower = modelId.toLowerCase()
  return REASONING_MODEL_PREFIXES.some((prefix) => {
    if (!lower.startsWith(prefix)) return false
    // Token-boundary guard: require end-of-string, '-', or '.' after the
    // prefix so substrings like "o1" in "gpt-4o-1" are not trapped.
    const next = lower[prefix.length]
    return next === undefined || next === '-' || next === '.'
  })
}
