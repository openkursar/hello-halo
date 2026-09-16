/**
 * Usage Normalization: wire-protocol usage -> Anthropic-shaped internal usage.
 *
 * Everything downstream of the router speaks the Anthropic shape, where the
 * context size is `input + cacheCreation + cacheRead` (see
 * `services/agent/context-usage.ts`). The two wire protocols disagree on what
 * the prompt total means:
 *
 *   OpenAI     `prompt_tokens` / `input_tokens` — INCLUDES cache hits
 *   Anthropic  `input_tokens`                   — EXCLUDES cache hits
 *
 * So assigning an OpenAI prompt total straight into `input_tokens` and then
 * adding the cache figure counts every cached token twice.
 *
 * Cache-hit field naming is equally inconsistent in the wild: the OpenAI
 * standard is `prompt_tokens_details.cached_tokens`, but gateways fronting
 * Anthropic-protocol clients routinely emit the Anthropic name
 * `cache_read_input_tokens` inside an otherwise-OpenAI body. Both are read,
 * standard name first — never summed, exactly one wins.
 */

/** Anthropic-shaped usage, the single internal currency of this router. */
export interface NormalizedUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

/** Structural input contract; the wire usage types satisfy it. */
interface OpenAIUsageLike {
  prompt_tokens?: number
  completion_tokens?: number
  input_tokens?: number
  output_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  input_tokens_details?: { cached_tokens?: number }
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

interface AnthropicUsageLike {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export function createEmptyUsage(): NormalizedUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
}

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * Split an inclusive prompt total into the Anthropic-style increment.
 *
 * `cached > promptTotal` is impossible under OpenAI semantics, so it identifies
 * an upstream that emitted Anthropic semantics in an OpenAI body — observed on
 * the halo-cloud gateway, which reports both shapes across calls. Taking the
 * total as-is there keeps the sum `input + cacheRead` correct for both, instead
 * of driving the subtraction negative.
 */
function deriveInputTokens(promptTotal: number, cached: number): number {
  return cached <= promptTotal ? promptTotal - cached : promptTotal
}

/**
 * Normalize an OpenAI usage object (Chat Completions or Responses — the two
 * differ only in field spelling, which this resolves).
 *
 * Returns null when the upstream reported no usage at all, so callers keep the
 * last real value instead of overwriting it with zeros.
 */
export function normalizeOpenAIUsage(usage: OpenAIUsageLike | undefined | null): NormalizedUsage | null {
  if (!usage) return null

  const promptTotal = toCount(usage.prompt_tokens ?? usage.input_tokens)
  const cacheRead = toCount(
    usage.prompt_tokens_details?.cached_tokens ??
      usage.input_tokens_details?.cached_tokens ??
      usage.cache_read_input_tokens
  )

  return {
    inputTokens: deriveInputTokens(promptTotal, cacheRead),
    outputTokens: toCount(usage.completion_tokens ?? usage.output_tokens),
    cacheReadTokens: cacheRead,
    // OpenAI has no cache-creation counterpart, so this only ever arrives via
    // the Anthropic-named field and is passed through untouched.
    cacheCreationTokens: toCount(usage.cache_creation_input_tokens)
  }
}

/**
 * Normalize a native Anthropic usage object. Already the internal shape — the
 * prompt total is an increment, so no cache subtraction applies.
 */
export function normalizeAnthropicUsage(usage: AnthropicUsageLike | undefined | null): NormalizedUsage | null {
  if (!usage) return null

  return {
    inputTokens: toCount(usage.input_tokens),
    outputTokens: toCount(usage.output_tokens),
    cacheReadTokens: toCount(usage.cache_read_input_tokens),
    cacheCreationTokens: toCount(usage.cache_creation_input_tokens)
  }
}
