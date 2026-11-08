import { describe, expect, it } from 'vitest'
import { parseAnnouncedUntil } from '../../../../src/main/openai-compat-router/balancing/announced-time'

const NOW = Date.parse('2026-03-01T12:00:00.000Z')
const until = (headers: Record<string, string>) => parseAnnouncedUntil(headers, NOW)

describe('retry-after', () => {
  it('reads seconds, fractions included', () => {
    expect(until({ 'retry-after': '120' })).toBe(NOW + 120_000)
    expect(until({ 'Retry-After': '1.5' })).toBe(NOW + 1_500)
  })

  it('reads an HTTP date', () => {
    expect(until({ 'retry-after': 'Sun, 01 Mar 2026 12:05:00 GMT' })).toBe(NOW + 300_000)
  })

  it('reads milliseconds', () => {
    expect(until({ 'retry-after-ms': '2500' })).toBe(NOW + 2_500)
  })

  it.each([
    ['text', 'soon'],
    ['a negative number', '-5'],
    ['empty', ''],
    ['zero', '0'],
    ['a date already past', 'Sun, 01 Mar 2026 11:00:00 GMT'],
  ])('ignores %s', (_label, value) => {
    expect(until({ 'retry-after': value })).toBeNull()
  })
})

describe('reset headers', () => {
  it('reads the timestamps Anthropic sends', () => {
    expect(until({ 'anthropic-ratelimit-requests-reset': '2026-03-01T12:10:00Z' })).toBe(NOW + 600_000)
    expect(until({ 'anthropic-ratelimit-unified-reset': '2026-03-01T17:00:00.000Z' })).toBe(NOW + 5 * 3_600_000)
  })

  it.each([
    ['1s', 1_000],
    ['6m0s', 360_000],
    ['1h30m', 5_400_000],
    ['250ms', 250],
    ['1.5s', 1_500],
    ['2d', 172_800_000],
  ])('reads the duration %s that OpenAI sends', (value, ms) => {
    expect(until({ 'x-ratelimit-reset-requests': value })).toBe(NOW + ms)
    expect(until({ 'x-ratelimit-reset-tokens': value })).toBe(NOW + ms)
  })

  it('reads a bare number as seconds from now, or as an epoch when it is large', () => {
    expect(until({ 'ratelimit-reset': '45' })).toBe(NOW + 45_000)
    expect(until({ 'x-ratelimit-reset': String(Math.floor((NOW + 90_000) / 1000)) })).toBe(Math.floor((NOW + 90_000) / 1000) * 1000)
    expect(until({ 'x-ratelimit-reset': String(NOW + 90_000) })).toBe(NOW + 90_000)
  })

  it('ignores a reset that is unreadable or already past', () => {
    expect(until({ 'x-ratelimit-reset-requests': 'never' })).toBeNull()
    expect(until({ 'anthropic-ratelimit-requests-reset': '2026-03-01T11:00:00Z' })).toBeNull()
    expect(until({ 'x-ratelimit-reset-requests': '' })).toBeNull()
  })

  it('does not take unrelated headers for resets', () => {
    expect(until({ 'x-ratelimit-limit-requests': '60', 'x-request-id': '5' })).toBeNull()
  })
})

describe('several headers', () => {
  it('uses the latest instant any of them announces', () => {
    expect(until({
      'retry-after': '30',
      'x-ratelimit-reset-requests': '6m0s',
      'anthropic-ratelimit-tokens-reset': '2026-03-01T12:01:00Z',
    })).toBe(NOW + 360_000)
  })

  it('skips the unreadable ones and still reads the rest', () => {
    expect(until({ 'retry-after': 'soon', 'retry-after-ms': '4000' })).toBe(NOW + 4_000)
  })

  it('announces nothing when there are no headers', () => {
    expect(until({})).toBeNull()
  })
})
