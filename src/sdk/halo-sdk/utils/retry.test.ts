/**
 * Unit tests for retry utility functions.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  delayForAttempt,
  describeFetchError,
  httpRetryDelay,
  isRetryableStatus,
  MAX_RETRY_AFTER_MS,
  parseRetryAfterMs,
  sleep,
  DEFAULT_RETRY,
} from './retry.js';

// ---------------------------------------------------------------------------
// delayForAttempt
// ---------------------------------------------------------------------------

describe('delayForAttempt', () => {
  it('returns initial delay for attempt 0', () => {
    const d = delayForAttempt(DEFAULT_RETRY, 0);
    // initialDelayMs=1000, no backoff yet; should be roughly 1000-1100ms
    expect(d).toBeGreaterThanOrEqual(1000);
    expect(d).toBeLessThanOrEqual(1100);
  });

  it('doubles with each attempt (exponential backoff)', () => {
    const d0 = delayForAttempt({ ...DEFAULT_RETRY, initialDelayMs: 1000, backoffMultiplier: 2 }, 0);
    const d1 = delayForAttempt({ ...DEFAULT_RETRY, initialDelayMs: 1000, backoffMultiplier: 2 }, 1);
    // d1 base = 2000, d0 base = 1000 → ratio ≈ 2
    expect(d1 / d0).toBeGreaterThan(1.5);
    expect(d1 / d0).toBeLessThan(2.5);
  });

  it('caps at maxDelayMs', () => {
    const cfg = { ...DEFAULT_RETRY, initialDelayMs: 1000, maxDelayMs: 5000, backoffMultiplier: 10 };
    const d = delayForAttempt(cfg, 5);
    expect(d).toBeLessThanOrEqual(5000);
  });
});

// ---------------------------------------------------------------------------
// isRetryableStatus
// ---------------------------------------------------------------------------

describe('isRetryableStatus', () => {
  it('returns true for 429 (rate limit)', () => {
    expect(isRetryableStatus(429)).toBe(true);
  });

  it('returns true for 529 (Anthropic overloaded)', () => {
    expect(isRetryableStatus(529)).toBe(true);
  });

  it('returns true for 500 series errors', () => {
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(599)).toBe(true);
  });

  it('returns false for 200, 400, 401, 403, 404', () => {
    for (const status of [200, 201, 400, 401, 403, 404]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// parseRetryAfterMs
// ---------------------------------------------------------------------------

function makeHeaders(pairs: Record<string, string>): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(pairs)) {
    h.set(k, v);
  }
  return h;
}

describe('parseRetryAfterMs', () => {
  it('parses delta-seconds integer', () => {
    const ms = parseRetryAfterMs(makeHeaders({ 'retry-after': '30' }));
    expect(ms).toBe(30_000);
  });

  it('parses delta-seconds float (rounds up)', () => {
    const ms = parseRetryAfterMs(makeHeaders({ 'retry-after': '1.5' }));
    expect(ms).toBe(2_000);
  });

  it('parses HTTP-date in the future', () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const ms = parseRetryAfterMs(makeHeaders({ 'retry-after': future }));
    expect(ms).toBeDefined();
    expect(ms!).toBeGreaterThan(50_000);
    expect(ms!).toBeLessThan(70_000);
  });

  it('returns undefined when header absent', () => {
    expect(parseRetryAfterMs(new Headers())).toBeUndefined();
  });

  it('returns undefined for unparseable value', () => {
    const ms = parseRetryAfterMs(makeHeaders({ 'retry-after': 'not-a-date' }));
    expect(ms).toBeUndefined();
  });

  it('returns undefined for past HTTP-date', () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    const ms = parseRetryAfterMs(makeHeaders({ 'retry-after': past }));
    expect(ms).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// sleep
// ---------------------------------------------------------------------------

describe('delayForAttempt — jitter bounds', () => {
  it('jitter is always non-negative (delay >= base)', () => {
    // Math.random returns [0, 1) — jitter = base * 0.1 * rand ≥ 0
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const d = delayForAttempt(DEFAULT_RETRY, 0);
    // base = 1000, jitter = 0 → exactly 1000 (before cap)
    expect(d).toBe(1_000);
    vi.restoreAllMocks();
  });

  it('jitter is at most 10% of the base delay', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9999);
    const d = delayForAttempt(DEFAULT_RETRY, 0);
    // base = 1000, max jitter ≈ 1000 * 0.1 * 1 = 100 → at most 1100
    expect(d).toBeLessThanOrEqual(1_100);
    vi.restoreAllMocks();
  });

  it('jitter scales with the attempt (larger base = larger jitter band)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(1); // max jitter for both
    const d0 = delayForAttempt(DEFAULT_RETRY, 0); // base=1000
    const d1 = delayForAttempt(DEFAULT_RETRY, 1); // base=2000
    // Both at max jitter: d1 should be larger than d0
    expect(d1).toBeGreaterThan(d0);
    vi.restoreAllMocks();
  });

  it('maxDelayMs caps the final value including jitter', () => {
    vi.spyOn(Math, 'random').mockReturnValue(1); // push towards max
    const cfg = { ...DEFAULT_RETRY, maxDelayMs: 1_050 };
    // attempt=0: base=1000, max jitter=100, uncapped=1100 → capped at 1050
    const d = delayForAttempt(cfg, 0);
    expect(d).toBe(1_050);
    vi.restoreAllMocks();
  });
});

describe('sleep', () => {
  it('resolves after the specified delay', async () => {
    const start = Date.now();
    await sleep(50);
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });

  it('resolves normally when no abort signal is provided', async () => {
    // No signal argument — should resolve cleanly
    await expect(sleep(10)).resolves.toBeUndefined();
  });

  it('rejects immediately when signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort(new Error('aborted'));
    await expect(sleep(10_000, ac.signal)).rejects.toThrow('aborted');
  });

  it('rejects when signal aborts mid-sleep', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    await expect(sleep(10_000, ac.signal)).rejects.toBeDefined();
  });

  it('leaves no abort listener behind once it completes', async () => {
    const ac = new AbortController();
    const remove = vi.spyOn(ac.signal, 'removeEventListener');
    await sleep(1, ac.signal);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});

// ---------------------------------------------------------------------------
// httpRetryDelay
// ---------------------------------------------------------------------------

describe('httpRetryDelay', () => {
  it('backs off on a retryable status without server hints', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(httpRetryDelay(DEFAULT_RETRY, 2, 503, new Headers())).toBe(4_000);
    vi.restoreAllMocks();
  });

  it('refuses a status that is not retryable', () => {
    expect(httpRetryDelay(DEFAULT_RETRY, 0, 400, new Headers())).toBeNull();
  });

  it('lets x-should-retry override the status either way', () => {
    expect(httpRetryDelay(DEFAULT_RETRY, 0, 429, makeHeaders({ 'x-should-retry': 'false' }))).toBeNull();
    expect(httpRetryDelay(DEFAULT_RETRY, 0, 400, makeHeaders({ 'x-should-retry': 'true' }))).not.toBeNull();
  });

  it('uses Retry-After in place of the backoff', () => {
    expect(httpRetryDelay(DEFAULT_RETRY, 5, 429, makeHeaders({ 'retry-after': '3' }))).toBe(3_000);
  });

  it('refuses a Retry-After longer than one request may wait', () => {
    const seconds = String(MAX_RETRY_AFTER_MS / 1000 + 1);
    expect(httpRetryDelay(DEFAULT_RETRY, 0, 429, makeHeaders({ 'retry-after': seconds }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// describeFetchError
// ---------------------------------------------------------------------------

describe('describeFetchError', () => {
  it('appends the network cause that fetch hides', () => {
    const err = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' }),
    });
    expect(describeFetchError(err)).toBe('fetch failed (ENOTFOUND)');
  });

  it('keeps a message that already names its cause', () => {
    expect(describeFetchError(new Error('socket hang up'))).toBe('socket hang up');
  });

  it('stringifies non-errors', () => {
    expect(describeFetchError('boom')).toBe('boom');
  });
});
