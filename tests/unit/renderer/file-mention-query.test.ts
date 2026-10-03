/**
 * The @ menu re-asks while the path index is still being built, and stops as
 * soon as a result is complete or the menu goes away.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../../src/renderer/api', () => ({ api: {} }))
vi.mock('../../../src/renderer/services/artifact-space-holds', () => ({ holdArtifactSpace: () => () => {} }))

import { hasFilesToOffer, startFileQuery } from '../../../src/renderer/hooks/useFileMentionQuery'

const result = (indexing: boolean) => ({ success: true, data: { items: [], truncated: false, indexing, hasPaths: false } })

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('startFileQuery', () => {
  it('re-queries while indexing and stops once the index is complete', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(result(true))
      .mockResolvedValueOnce(result(true))
      .mockResolvedValue(result(false))
    const onResult = vi.fn()
    startFileQuery(fetch, onResult)

    await vi.advanceTimersByTimeAsync(10_000)

    expect(fetch).toHaveBeenCalledTimes(3)
    expect(onResult.mock.calls.map(([r]) => r.indexing)).toEqual([true, true, false])
  })

  it('stops re-querying when cancelled (menu closed) even if still indexing', async () => {
    const fetch = vi.fn().mockResolvedValue(result(true))
    const cancel = startFileQuery(fetch, vi.fn())

    await vi.advanceTimersByTimeAsync(600)
    const calls = fetch.mock.calls.length
    cancel()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(calls).toBeGreaterThan(0)
    expect(fetch).toHaveBeenCalledTimes(calls)
  })

  it('debounces: a query cancelled before the debounce never runs', async () => {
    const fetch = vi.fn().mockResolvedValue(result(false))
    const cancel = startFileQuery(fetch, vi.fn())
    cancel()
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('hasFilesToOffer', () => {
  const r = (items: number, hasPaths: boolean, indexing = false) => ({
    items: Array.from({ length: items }, (_, i) => ({ path: `/s/${i}` })) as never[], truncated: false, indexing, hasPaths,
  })

  it('is false for a genuinely empty space whose index is complete', () => {
    expect(hasFilesToOffer(r(0, false))).toBe(false)
  })

  it('is true while indexing, even before any path is known', () => {
    expect(hasFilesToOffer(r(0, false, true))).toBe(true)
  })

  it('is true when the first query matches nothing but the space has files', () => {
    expect(hasFilesToOffer(r(0, true))).toBe(true)
  })
})
