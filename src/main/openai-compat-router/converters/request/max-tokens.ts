/**
 * Normalize the Anthropic `max_tokens` into a positive integer suitable for
 * an OpenAI-compatible output-length field, or return `undefined` when the
 * value should be omitted entirely.
 *
 * Shared by both the Chat Completions and Responses API converters so the
 * same gating + integer hygiene is applied once at the protocol boundary.
 * `AnthropicRequest.max_tokens` is typed `number` (not `integer`), and
 * OpenAI-compatible APIs reject non-integer values with HTTP 400.
 */
export function resolveOutputTokenLimit(maxTokens: number | undefined | null): number | undefined {
  if (typeof maxTokens !== 'number' || !Number.isFinite(maxTokens)) {
    return undefined
  }
  // OpenAI-compatible APIs reject non-integer output-length fields.
  const truncated = Math.trunc(maxTokens)
  // Truncation can collapse values in (0, 1) to 0, which is not a valid cap.
  return truncated > 0 ? truncated : undefined
}
