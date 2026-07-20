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
 *
 * Resolution order (vision):
 *   1. Explicit ModelOption.supportsVision (provider-declared) — highest priority
 *   2. Vision keyword whitelist (e.g. "-vl", "vision", "omni")
 *   3. Non-vision pattern blacklist (e.g. "deepseek", "glm-4")
 *   4. Default: true (unknown models pass through, no false blocking)
 */

import type { ModelOption } from '../types/ai-sources'

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
