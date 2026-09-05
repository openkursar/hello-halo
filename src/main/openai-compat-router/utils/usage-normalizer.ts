/**
 * OpenAI's `prompt_tokens` includes anything served from cache; Anthropic's
 * `input_tokens` excludes it (callers sum `input_tokens + cache_read_input_tokens`
 * to get the true total). A provider that bolts `cache_read_input_tokens` onto an
 * otherwise OpenAI-shaped response may or may not have also switched
 * `prompt_tokens` to the exclusive convention — this can't be assumed from the
 * field's mere presence, so it's verified per response against `total_tokens`.
 */

export interface UsageForNormalization {
  promptTokens: number | undefined
  completionTokens: number | undefined
  totalTokens: number | undefined
  cacheReadTokens: number | undefined
  /** Model id or similar, for the unclassified-shape diagnostic log only. */
  providerLabel?: string
}

export function normalizeOpenAIInputTokens(usage: UsageForNormalization): number | undefined {
  const { promptTokens, completionTokens, totalTokens, cacheReadTokens, providerLabel } = usage

  if (promptTokens === undefined || !cacheReadTokens) return promptTokens

  if (totalTokens !== undefined) {
    if (cacheReadTokens <= promptTokens && totalTokens === promptTokens + (completionTokens ?? 0)) {
      return promptTokens - cacheReadTokens
    }
    if (totalTokens === promptTokens + (completionTokens ?? 0) + cacheReadTokens) {
      return promptTokens
    }
  }

  console.debug(
    `[UsageNormalizer] unclassified usage shape${providerLabel ? ` (${providerLabel})` : ''}: ` +
    `prompt_tokens=${promptTokens}, completion_tokens=${completionTokens}, ` +
    `total_tokens=${totalTokens}, cache_read_input_tokens=${cacheReadTokens}. ` +
    `Neither the OpenAI-inclusive nor the Anthropic-exclusive identity holds — leaving prompt_tokens unadjusted.`
  )
  return promptTokens
}
