/**
 * A run's token usage reads like the chat's token hint: the total the model
 * processed, cache included, in K/M, with the split on hover.
 */

import { describe, expect, it } from 'vitest'
import { formatTokenCount, runTokenBreakdown, runTokenTotal } from '../../../src/renderer/components/apps/run-tokens'

const t = (key: string, values?: Record<string, unknown>) =>
  key.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values?.[name] ?? ''))

describe('run token usage text', () => {
  it('formats counts the way the chat does, with millions for long runs', () => {
    expect(formatTokenCount(999)).toBe('999')
    expect(formatTokenCount(4_550)).toBe('4.5K')
    expect(formatTokenCount(46_400)).toBe('46K')
    expect(formatTokenCount(5_240_000)).toBe('5.2M')
  })

  it('totals everything the model processed and splits it on hover', () => {
    const usage = { inputTokens: 1_200, outputTokens: 800, cacheReadTokens: 42_000, cacheCreationTokens: 2_400 }

    expect(runTokenTotal(usage)).toBe('46K')
    expect(runTokenBreakdown(usage, t)).toBe('Input: 1.2K\nOutput: 800\nCache read: 42K\nCache write: 2.4K')
  })
})
