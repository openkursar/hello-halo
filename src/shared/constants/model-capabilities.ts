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
 *   - Reasoning effort ladders: which effort levels an upstream accepts, and
 *     how it is told to stop thinking.
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
import type { ReasoningEffortLevel } from './reasoning-effort'

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
  const normalized = normalizeModelId(modelId)
  const exact = normalisedModels.get(normalized)
  if (exact) return exact
  const pattern = sortedPatterns.find(p => normalized.startsWith(p.prefix))
  return pattern ? pattern.cap : null
}

/**
 * Infer vision support from a model ID (see the file header for the full
 * resolution order).
 */
function inferVisionSupport(modelId: string): boolean {
  const lower = modelId.toLowerCase()

  // A per-model statement that names the complete id wins outright — it is
  // how a multimodal variant inside a text-only family (glm-5.3-flash inside
  // glm-5) is expressed. Proxy-prefixed forms do not match here: their
  // stripped prefixes can carry substring signals the layers below must
  // still honor ("deepseek-proxy/gpt-4o" must stay text-only).
  const full = normalisedModels.get(lower)
  if (full) return full.vision

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

/** How an upstream expresses reasoning effort on the OpenAI-compatible wire. */
export interface ReasoningEffortProfile {
  /** Levels this upstream accepts. An inferred level outside it clamps down. */
  levels: readonly ReasoningEffortLevel[]
  /**
   * Wire value that stops the model from thinking. Absent means the field is
   * omitted instead, which is how most upstreams are told not to think.
   */
  disableValue?: string
}

/**
 * Ladder assumed for a model with no entry below: the narrow set every
 * OpenAI-compatible endpoint has always accepted.
 *
 * Halo only picks a level itself when the user declared none, and guessing
 * `max` at an endpoint that never heard of it turns a working conversation
 * into an HTTP 400. A user who knows their upstream accepts more sets the
 * level in Model Config, which bypasses this ladder.
 */
const DEFAULT_REASONING_EFFORT_PROFILE: ReasoningEffortProfile = {
  levels: ['low', 'medium', 'high']
}

/**
 * Upstreams that deviate from {@link DEFAULT_REASONING_EFFORT_PROFILE}.
 * Matched like the vision blacklist — lowercase substring, so proxy-prefixed
 * ids (`Pro/zai-org/GLM-5`) still resolve. First match wins.
 *
 * Deliberately short: an entry here is a claim about a specific upstream's API,
 * and a wrong claim fails as an HTTP 400 the user cannot act on.
 */
const REASONING_EFFORT_PROFILES: ReadonlyArray<{
  pattern: string
  profile: ReasoningEffortProfile
}> = [
  // GLM-5.3 and GLM-5.3-FLASH always think: they reject every request that
  // tries to stop them and only accept low/high/max, so a "thinking off"
  // request must still send an effort, mapped to their lowest level.
  // First match wins, so this must stay above the plain glm-5 entry.
  {
    pattern: 'glm-5.3',
    profile: { levels: ['low', 'high', 'max'], disableValue: 'low' }
  },
  // GLM-5 reasons by default, so omitting the field leaves it thinking; it
  // takes an explicit value to stop.
  { pattern: 'glm-5', profile: { levels: ['low', 'medium', 'high'], disableValue: 'none' } },
]

/**
 * Effort profile for a wire model id. Used by the openai-compat router, where
 * only the request body's `model` string is available.
 */
export function reasoningEffortProfileById(
  modelId: string | undefined | null
): ReasoningEffortProfile {
  if (!modelId) return DEFAULT_REASONING_EFFORT_PROFILE
  const lower = modelId.toLowerCase()
  return REASONING_EFFORT_PROFILES.find((entry) => lower.includes(entry.pattern))?.profile
    ?? DEFAULT_REASONING_EFFORT_PROFILE
}
