/**
 * @module utils/retry
 * Shared HTTP retry utilities: exponential backoff with jitter,
 * retryable status detection, and Retry-After header handling.
 * Used by all LLM provider implementations.
 * @license MIT
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetryConfig {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Default retry configuration: 10 retries, 1 s initial delay,
 * 60 s cap, 2× exponential backoff with 10 % jitter.
 */
export const DEFAULT_RETRY: RetryConfig = {
  maxRetries: 10,
  initialDelayMs: 1_000,
  maxDelayMs: 60_000,
  backoffMultiplier: 2.0,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the delay for a given retry attempt (0-based).
 * Adds ±10 % random jitter to reduce thundering-herd effects.
 */
export function delayForAttempt(config: RetryConfig, attempt: number): number {
  const base = config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt);
  const jitter = base * 0.1 * Math.random();
  return Math.min(base + jitter, config.maxDelayMs);
}

/**
 * Whether an HTTP status code warrants an automatic retry.
 *
 * - 408: Request Timeout — transient network/proxy cutoff
 * - 409: Conflict — retained as a retryable provider response
 * - 429: rate limited
 * - 529: Anthropic-specific overloaded signal
 * - 5xx: server-side errors
 *
 * Note: 401/403 auth errors are intentionally excluded here.
 * They require token refresh logic that lives above this utility layer.
 */
export function isRetryableStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 409 ||
    status === 429 ||
    status === 529 ||
    (status >= 500 && status < 600)
  );
}

/**
 * Longest server-requested wait honoured within one request. A server asking
 * for more is reporting a limit that outlasts any reasonable wait (a spent
 * quota, a long lockout), so the failure is surfaced instead of held.
 */
export const MAX_RETRY_AFTER_MS = 60_000;

/**
 * How long to wait before retrying a failed HTTP attempt, or `null` when the
 * failure must not be retried at all.
 *
 * The server has the final say: `x-should-retry` overrides the status-based
 * default in either direction, and a `Retry-After` beyond
 * {@link MAX_RETRY_AFTER_MS} means the condition is not transient. A
 * `Retry-After` within the cap replaces the backoff delay rather than adding
 * to it. The attempt budget is the caller's concern — it alone can tell
 * "not retryable" from "retried to exhaustion".
 */
export function httpRetryDelay(
  config: RetryConfig,
  attempt: number,
  status: number,
  headers: Headers,
): number | null {
  const hint = headers.get('x-should-retry');
  const retryable = hint === 'true' ? true : hint === 'false' ? false : isRetryableStatus(status);
  if (!retryable) return null;

  const retryAfterMs = parseRetryAfterMs(headers);
  if (retryAfterMs === undefined) return delayForAttempt(config, attempt);
  return retryAfterMs <= MAX_RETRY_AFTER_MS ? retryAfterMs : null;
}

/**
 * A failed `fetch()` in words a person can act on. Node's fetch reports every
 * network failure as "fetch failed" and keeps the reason (ECONNREFUSED,
 * ETIMEDOUT, a TLS error) on `cause`.
 */
export function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  if (!(cause instanceof Error)) return err.message;
  const detail = (cause as { code?: unknown }).code ?? cause.message;
  if (typeof detail !== 'string' || !detail || err.message.includes(detail)) return err.message;
  return `${err.message} (${detail})`;
}

/**
 * Parse the `Retry-After` response header and return the delay in ms.
 * Returns `undefined` when the header is absent or unparseable.
 *
 * The header value may be a delta-seconds integer or an HTTP-date string.
 */
export function parseRetryAfterMs(headers: Headers): number | undefined {
  const value = headers.get('retry-after');
  if (!value) return undefined;

  // Try delta-seconds form first (e.g. "30")
  const seconds = parseFloat(value);
  if (!isNaN(seconds) && seconds > 0) {
    return Math.ceil(seconds) * 1_000;
  }

  // Try HTTP-date form (e.g. "Thu, 01 Jan 2026 00:00:00 GMT")
  const date = new Date(value);
  if (!isNaN(date.getTime())) {
    const deltaMs = date.getTime() - Date.now();
    return deltaMs > 0 ? deltaMs : undefined;
  }

  return undefined;
}

/**
 * Sleep for `ms` milliseconds, respecting an optional abort signal.
 * Rejects with the signal's reason if aborted during the wait.
 */
export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    // The listener is removed on completion: the signal usually outlives the
    // sleep (a whole session), and every retry would otherwise leave one behind.
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
