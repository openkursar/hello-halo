/**
 * Model Capabilities — Capability Detection From Model IDs
 *
 * Maintains pattern lists for capability inference from a model id string and
 * provides unified query functions. Currently covers:
 *   - Vision support: used by InputArea to block image input for non-vision
 *     models, and by the OpenAI-compat router to strip image blocks.
 *   - Reasoning model detection: used by the OpenAI-compat router to pick the
 *     correct output-length parameter (`max_completion_tokens` for reasoning
 *     models, `max_tokens` otherwise). OpenAI rejects `max_tokens` on the
 *     o1/o3/o4-mini and gpt-5-thinking families with HTTP 400.
 *   - Reasoning effort ladders: which effort levels an upstream accepts, and
 *     how it is told to stop thinking.
 *
 * Resolution order (vision), from a model id alone:
 *   1. Explicit ModelOption.supportsVision (provider-declared) — highest priority
 *   2. Vision keyword whitelist (e.g. "-vl", "vision", "omni")
 *   3. Non-vision pattern blacklist (e.g. "deepseek", "glm-4")
 *   4. Default: true (unknown models pass through, no false blocking)
 *
 * Callers holding an AI source use {@link resolveModelVision} instead: it adds
 * the per-model override layer on top and is the one answer every consumer
 * (renderer hint, backend config, image fallback) must share.
 */

import type { ModelOption } from '../types/ai-sources'
import type { ReasoningEffortLevel } from './reasoning-effort'

/**
 * Known non-vision model patterns (blacklist).
 * Matched via modelId.toLowerCase().includes(pattern).
 */
const NON_VISION_PATTERNS: string[] = [
  // DeepSeek family
  'deepseek',
  // GLM family (glm-4v is rescued by VISION_KEYWORDS)
  'glm-4', 'glm-5', 'chatglm',
  // Meta Llama (text-only variants)
  'llama-2', 'llama-3.1', 'llama-3.3', 'codellama',
  // Mistral family
  'mixtral', 'mistral-large', 'mistral-medium', 'mistral-nemo', 'codestral',
  // Qwen text/code variants
  'qwen-coder', 'qwen2.5-coder', 'qwen3-coder', 'qwen-math', 'qwq',
  // Microsoft Phi family
  'phi-2', 'phi-3-mini', 'phi-3-small', 'phi-3-medium', 'phi-4-mini',
  // Google Gemma
  'gemma-2', 'codegemma',
  // NVIDIA
  'nemotron',
  // MiniMax
  'minimax', 'abab',
  // Other known text-only models
  'command-r', 'dbrx', 'olmo', 'starcoder',
  'solar', 'mercury', 'lfm', 'palmyra', 'internlm', 'baichuan',
]

/**
 * Keywords that indicate vision support — takes priority over blacklist.
 * Prevents false positives (e.g. "glm-4v" matched by "glm-4" pattern).
 */
const VISION_KEYWORDS: string[] = [
  'vision', '-vl', 'pixtral', 'paligemma', 'cogvlm',
  'glm-4v', 'glm-ocr', 'multimodal', 'omni',
]

/**
 * Infer vision support from model ID using blacklist/whitelist patterns.
 */
function inferVisionSupport(modelId: string): boolean {
  const lower = modelId.toLowerCase()

  // Vision keywords take priority — rescue false positives
  if (VISION_KEYWORDS.some(kw => lower.includes(kw))) return true

  // Check blacklist
  if (NON_VISION_PATTERNS.some(p => lower.includes(p))) return false

  // Unknown models default to vision-capable (no false blocking)
  return true
}

/**
 * Check if a model supports vision (image) input.
 *
 * Resolution order:
 *   1. Explicit ModelOption.supportsVision (provider or user set) — highest priority
 *   2. Blacklist/keyword inference from model ID
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
 * Behavior matches {@link supportsVision} step 2-3 (keyword/blacklist
 * inference, default true for unknown IDs).
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
 *   3. Blacklist/keyword inference from the model id
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
