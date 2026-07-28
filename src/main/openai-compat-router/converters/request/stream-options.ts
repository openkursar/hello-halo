/**
 * Build `stream_options: { include_usage: true }` for OpenAI-compat streaming.
 *
 * Without this flag, OpenAI-compat gateways (litellm, OpenAI public Chat
 * Completions API) omit usage from streamed chunks and `TokenUsageIndicator`
 * renders zeros — see issue #181. Shared by both converters so the contract
 * is applied once at the protocol boundary.
 */

export function buildStreamOptionsIncludeUsage(): { include_usage: true } {
  return { include_usage: true }
}
