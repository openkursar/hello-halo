/**
 * Unit tests for TokenManager and withTokenRetry
 * (src/main/services/notify-channels/token-manager.ts).
 *
 * Invariants under test:
 *   - a fetched token is cached and reused until the 5-minute pre-expiry buffer
 *   - crossing the buffer triggers exactly one refresh
 *   - concurrent getToken() calls dedupe onto a single in-flight refresh
 *   - withTokenRetry invalidates + retries once on a known auth error code,
 *     then returns whatever the second call yields (no third attempt)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { TokenManager, withTokenRetry } from '../../../../src/main/services/notify-channels/token-manager'

const REFRESH_BUFFER_MS = 300_000

describe('TokenManager', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('fetches once and caches the token while it is still valid', async () => {
    const fetcher = vi.fn(async () => ({ token: 'tok-1', expiresIn: 7200 }))
    const mgr = new TokenManager('test', fetcher)

    expect(await mgr.getToken()).toBe('tok-1')
    expect(await mgr.getToken()).toBe('tok-1')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('refreshes once the pre-expiry buffer is crossed', async () => {
    let n = 0
    const fetcher = vi.fn(async () => ({ token: `tok-${++n}`, expiresIn: 7200 }))
    const mgr = new TokenManager('test', fetcher)

    expect(await mgr.getToken()).toBe('tok-1')

    // Just inside the valid window (before the 5-min buffer): still cached.
    vi.setSystemTime(7200_000 - REFRESH_BUFFER_MS - 1000)
    expect(await mgr.getToken()).toBe('tok-1')
    expect(fetcher).toHaveBeenCalledTimes(1)

    // Now within the buffer window: must refresh.
    vi.setSystemTime(7200_000 - REFRESH_BUFFER_MS + 1000)
    expect(await mgr.getToken()).toBe('tok-2')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('dedupes concurrent refreshes onto a single fetch', async () => {
    const fetcher = vi.fn(
      () =>
        new Promise<{ token: string; expiresIn: number }>((resolve) => {
          setTimeout(() => resolve({ token: 'tok-1', expiresIn: 7200 }), 100)
        })
    )
    const mgr = new TokenManager('test', fetcher)

    const p1 = mgr.getToken()
    const p2 = mgr.getToken()
    await vi.advanceTimersByTimeAsync(100)

    expect(await p1).toBe('tok-1')
    expect(await p2).toBe('tok-1')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('invalidate() forces the next getToken() to re-fetch', async () => {
    let n = 0
    const fetcher = vi.fn(async () => ({ token: `tok-${++n}`, expiresIn: 7200 }))
    const mgr = new TokenManager('test', fetcher)

    expect(await mgr.getToken()).toBe('tok-1')
    mgr.invalidate()
    expect(await mgr.getToken()).toBe('tok-2')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})

describe('withTokenRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns the result directly when there is no auth error', async () => {
    const fetcher = vi.fn(async () => ({ token: 'tok-1', expiresIn: 7200 }))
    const mgr = new TokenManager('test', fetcher)
    const fn = vi.fn(async () => ({ errcode: 0, data: 'ok' }))

    const result = await withTokenRetry(mgr, fn)
    expect(result).toEqual({ errcode: 0, data: 'ok' })
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each([42001, 40014, 88])('invalidates and retries once on auth error code %i', async (code) => {
    let n = 0
    const fetcher = vi.fn(async () => ({ token: `tok-${++n}`, expiresIn: 7200 }))
    const mgr = new TokenManager('test', fetcher)

    const tokensSeen: string[] = []
    let call = 0
    const fn = vi.fn(async (token: string) => {
      tokensSeen.push(token)
      call += 1
      return call === 1 ? { errcode: code } : { errcode: 0, data: 'ok' }
    })

    const result = await withTokenRetry(mgr, fn)
    expect(result).toEqual({ errcode: 0, data: 'ok' })
    expect(fn).toHaveBeenCalledTimes(2)
    // The retry used a freshly-fetched token (invalidate forced a re-fetch).
    expect(tokensSeen).toEqual(['tok-1', 'tok-2'])
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('propagates the second result even if it still carries an auth error (no third attempt)', async () => {
    const fetcher = vi.fn(async () => ({ token: 'tok', expiresIn: 7200 }))
    const mgr = new TokenManager('test', fetcher)
    const fn = vi.fn(async () => ({ errcode: 42001 }))

    const result = await withTokenRetry(mgr, fn)
    expect(result).toEqual({ errcode: 42001 })
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
