import type { RunTokenUsage } from '../../../shared/apps/app-types'

/** What a turn's `result` frame reports; a cumulative figure supersedes a per-turn one. */
export function readResultUsage(frame: unknown): RunTokenUsage | undefined {
  const message = frame as { usage?: Record<string, number>; cumulative_usage?: Record<string, number> }
  const usage = message.cumulative_usage ?? message.usage
  if (!usage) return undefined
  return {
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    cacheReadTokens: usage.cache_read_input_tokens || 0,
    cacheCreationTokens: usage.cache_creation_input_tokens || 0,
  }
}
