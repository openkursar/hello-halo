/**
 * How a run's token usage reads: the total the model processed, cache
 * included — what a usage quota usually counts — in the chat's K format, and
 * the split for a hover title.
 */

import type { RunTokenUsage } from '../../../shared/apps/app-types'
import { totalRunTokens } from '../../../shared/apps/app-types'

type Translate = (key: string, options?: Record<string, unknown>) => string

export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return tokens.toString()
  if (tokens < 10_000) return `${(tokens / 1000).toFixed(1)}K`
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000)}K`
  return `${(tokens / 1_000_000).toFixed(1)}M`
}

export function runTokenTotal(usage: RunTokenUsage): string {
  return formatTokenCount(totalRunTokens(usage))
}

export function runTokenBreakdown(usage: RunTokenUsage, t: Translate): string {
  return [
    t('Input: {{tokens}}', { tokens: formatTokenCount(usage.inputTokens) }),
    t('Output: {{tokens}}', { tokens: formatTokenCount(usage.outputTokens) }),
    t('Cache read: {{tokens}}', { tokens: formatTokenCount(usage.cacheReadTokens) }),
    t('Cache write: {{tokens}}', { tokens: formatTokenCount(usage.cacheCreationTokens) }),
  ].join('\n')
}
