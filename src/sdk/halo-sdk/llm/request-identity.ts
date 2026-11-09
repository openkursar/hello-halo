/**
 * @module llm/request-identity
 * Neutral provider-request identity seam.
 *
 * The host application can inject custom HTTP headers, a system-prompt
 * prefix block, and body-level metadata into every Anthropic API request.
 * The SDK itself carries no provider-specific identity constants — it only
 * forwards what the caller supplies.
 *
 * @license MIT
 */

import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// RequestIdentity — caller-provided identity context
// ---------------------------------------------------------------------------

/**
 * Optional identity payload that the host application injects into every
 * Anthropic API request. When omitted, the provider sends only the
 * standard authentication and version headers.
 */
export interface RequestIdentity {
  /**
   * Host-provided headers merged into each request.
   */
  headers?: Record<string, string>;

  /**
   * Per-attempt header factory. Called with the zero-based retry counter so
   * the host can include retry-count or per-request-id headers.
   * Merged after `headers` — keys here override static values.
   */
  headersForAttempt?: (attempt: number, options?: { signal?: AbortSignal }) => Record<string, string> | Promise<Record<string, string>>;

  /**
   * Text block prepended to the system field as `system[0]`.
   * The host receives the current messages when constructing this block.
   */
  systemPrefix?: (messages: Array<{ role: string; content: unknown }>, options?: { signal?: AbortSignal }) =>
    { type: 'text'; text: string } | Promise<{ type: 'text'; text: string }>;

  /**
   * Body-level `metadata` object passed through to the API.
   */
  metadata?: Record<string, string>;

  /**
   * When true, `?beta=true` is appended to the request URL.
   */
  betaQueryParam?: boolean;

  /**
   * Body-level `context_management` object. When provided, it is included
   * in the request body unconditionally.
   */
  contextManagement?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a fresh per-request UUID for `x-client-request-id`. */
export function generateRequestId(): string {
  return randomUUID();
}
