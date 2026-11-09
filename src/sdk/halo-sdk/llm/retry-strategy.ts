/**
 * Overload retry policy: background requests fail promptly; foreground requests
 * have a bounded retry allowance before the caller considers its configured fallback.
 * @license MIT
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Lightweight representation of a retryable API error. */
export interface ApiError {
  /** HTTP status code, if known. */
  status?: number;
  /** Raw error message. */
  message?: string;
}

/**
 * Decides whether a failed attempt should be retried and what to do when the
 * retry budget is exhausted.
 */
export interface RetryStrategy {
  /**
   * Return true if the caller should sleep and try again.
   * `attempt` is 0-based (first failure = 0).
   */
  shouldRetry(attempt: number, error: ApiError): boolean;

  /**
   * Called exactly once when `shouldRetry` first returns false for a 529.
   * Returns the escalation action the caller must take.
   *
   * - `'abort'`          — surface the error to the user
   * - `'fallback_model'` — retry the request with a lighter/cheaper fallback model
   */
  onMaxRetriesExceeded(error: ApiError): 'abort' | 'fallback_model';
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum number of consecutive 529 retries before escalation.
 */
const MAX_529_RETRIES = 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True when the error is an Anthropic 529 overloaded response. */
export function is529Error(error: ApiError): boolean {
  if (error.status === 529) return true;
  // An SSE error can identify overload without an HTTP error status.
  return (error.message?.includes('"type":"overloaded_error"') ?? false);
}

// ---------------------------------------------------------------------------
// Strategy implementations
// ---------------------------------------------------------------------------

/**
 * Build a 529-specific RetryStrategy for the given query source.
 *
 * @param source
 *   `'interactive'` (foreground) — The query was initiated directly by the
 *   user and the user is waiting for the response.  Retry up to
 *   MAX_529_RETRIES times, then check for a fallbackModel. If a fallback
 *   model is configured, escalate to model fallback; otherwise abort so
 *   the error is surfaced clearly.
 *
 *   `'background'`  — Fire-and-forget work (compact, summary, background
 *   indexing).  Uses **zero retries** and **immediate abort** on 529
 *   so auxiliary work does not prolong an already overloaded request.
 */
export function build529Strategy(
  source: 'interactive' | 'background',
): RetryStrategy {
  if (source === 'background') {
    // background 529 = zero retries, immediate abort
    return {
      shouldRetry(_attempt: number, error: ApiError): boolean {
        if (!is529Error(error)) return true; // not a 529 — standard path decides
        return false; // never retry a background 529
      },
      onMaxRetriesExceeded(_error: ApiError): 'abort' | 'fallback_model' {
        return 'abort';
      },
    };
  }

  // Interactive (foreground): retry up to MAX_529_RETRIES, then fallback/abort
  return {
    shouldRetry(attempt: number, error: ApiError): boolean {
      if (!is529Error(error)) return true; // not a 529 — standard path decides
      return attempt < MAX_529_RETRIES;
    },
    onMaxRetriesExceeded(_error: ApiError): 'abort' | 'fallback_model' {
      // Callers can interpret 'fallback_model' to swap models or treat as abort if none configured.
      return 'fallback_model';
    },
  };
}

// ---------------------------------------------------------------------------
// Default strategy
// ---------------------------------------------------------------------------

/**
 * Standard retry strategy used when no query-source context is available.
 * Uses the foreground allowance; the caller handles the fallback decision.
 */
export const DEFAULT_RETRY_STRATEGY: RetryStrategy = build529Strategy('interactive');
