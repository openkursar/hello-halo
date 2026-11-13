/**
 * @module utils/errors
 * Error type hierarchy for the Agent SDK.
 * @license MIT
 */

import { describeFetchError, isRetryableStatus } from './retry.js';
import { attachHarness, baselineText, type HarnessMessage } from '../harness/text.js';

// ---------------------------------------------------------------------------
// Base error
// ---------------------------------------------------------------------------

/** Base error class for all SDK errors. */
export class SDKError extends Error {
  /** Machine-readable error code */
  readonly code: string;
  declare readonly harness?: HarnessMessage;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SDKError';
    this.code = code;
    // Fix prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// Provider errors (API / network / auth)
// ---------------------------------------------------------------------------

/**
 * The server's own wording from an error response body, in either the
 * Anthropic or the OpenAI error shape; a non-JSON body is returned trimmed to
 * a readable length. Undefined when the body says nothing.
 */
export function apiErrorMessage(body: string): string | undefined {
  try {
    const json = JSON.parse(body);
    const apiMessage =
      json?.error?.message ??
      json?.error?.error?.message ??
      json?.message ??
      json?.detail;
    return typeof apiMessage === 'string' && apiMessage ? apiMessage : undefined;
  } catch {
    return body ? body.slice(0, 500) : undefined;
  }
}

/** Error originating from an LLM provider (API errors, network failures). */
export class ProviderError extends SDKError {
  /** HTTP status code, if available */
  readonly statusCode?: number;
  /** Whether the caller should retry this request */
  readonly retryable: boolean;
  /** Provider that produced the error, for multi-provider diagnostics. */
  readonly provider?: string;
  /**
   * The provider already retried this request to its budget. The failure is
   * still of a transient kind — a fallback model may help — but sending the
   * same request again would only repeat the retries it just exhausted.
   */
  readonly retriesExhausted: boolean;
  /** An HTTP rejection before a response stream, not an error after content may have started. */
  readonly requestRejected: boolean;

  constructor(
    message: string,
    options?: { statusCode?: number; retryable?: boolean; provider?: string; retriesExhausted?: boolean; requestRejected?: boolean },
  ) {
    super('PROVIDER_ERROR', message);
    this.name = 'ProviderError';
    this.statusCode = options?.statusCode;
    this.retryable = options?.retryable ?? false;
    this.provider = options?.provider;
    this.retriesExhausted = options?.retriesExhausted ?? false;
    this.requestRejected = options?.requestRejected ?? false;
  }

  /** Create a rate-limit error (HTTP 429). */
  static rateLimit(message = baselineText('providers.error.rate_limit')): ProviderError {
    const error = new ProviderError(message, { statusCode: 429, retryable: true });
    return arguments[0] === undefined ? attachHarness(error, 'providers.error.rate_limit') : error;
  }

  /** Create an overloaded error (HTTP 529). */
  static overloaded(message = baselineText('providers.error.overloaded')): ProviderError {
    const error = new ProviderError(message, { statusCode: 529, retryable: true });
    return arguments[0] === undefined ? attachHarness(error, 'providers.error.overloaded') : error;
  }

  /** Create a context-window-exceeded error. */
  static contextWindowExceeded(
    message = baselineText('providers.error.context_window'),
  ): ProviderError {
    const error = new ProviderError(message, { statusCode: 400, retryable: false });
    return arguments[0] === undefined ? attachHarness(error, 'providers.error.context_window') : error;
  }

  /**
   * Build a ProviderError from a failed HTTP response. Extracts the API's own
   * wording from the body when it is JSON in either the Anthropic or the
   * OpenAI error shape, so callers see the server's message and not a bare status.
   */
  static fromHttpResponse(
    provider: string,
    status: number,
    body: string,
    options?: { retryable?: boolean; retriesExhausted?: boolean; requestRejected?: boolean },
  ): ProviderError {
    const apiMessage = apiErrorMessage(body);
    const template = apiMessage ? 'providers.http.error' : 'providers.http.error_without_body';
    const values = { provider, status: String(status), ...(apiMessage ? { reason: apiMessage } : {}) };
    const message = baselineText(template, values);
    return attachHarness(new ProviderError(message, {
      statusCode: status,
      retryable: options?.retryable ?? isRetryableStatus(status),
      provider,
      retriesExhausted: options?.retriesExhausted,
      requestRejected: options?.requestRejected ?? true,
    }), template, values);
  }

  /** Classify an API error delivered after HTTP headers have already succeeded. */
  static fromStreamError(provider: string, type: string, message: string): ProviderError {
    const statusByType: Record<string, number> = {
      overloaded_error: 529,
      rate_limit_error: 429,
      api_error: 500,
      server_error: 500,
      authentication_error: 401,
      permission_error: 403,
      invalid_request_error: 400,
      not_found_error: 404,
    };
    const statusCode = statusByType[type];
    return new ProviderError(message, {
      provider,
      statusCode,
      retryable: statusCode !== undefined && isRetryableStatus(statusCode),
    });
  }

  /**
   * Coerce an arbitrary thrown value into a ProviderError.
   *
   * The bundled providers throw ProviderError directly. This exists for
   * host-supplied providers, which may throw plain errors carrying only a
   * numeric `status`. Returns null when the value holds no provider-failure
   * information, so the caller can let it propagate untouched.
   */
  static from(err: unknown): ProviderError | null {
    if (err instanceof ProviderError) return err;
    if (!(err instanceof Error)) return null;
    const details = err as { statusCode?: unknown; status?: unknown; code?: unknown; cause?: { code?: unknown }; provider?: string };
    const status = details.statusCode ?? details.status;
    if (typeof status === 'number') {
      return new ProviderError(err.message, {
        statusCode: status,
        retryable: isRetryableStatus(status),
        provider: details.provider,
      });
    }
    const code = details.code ?? details.cause?.code;
    if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(String(code)) ||
        (err instanceof TypeError && err.message.toLowerCase() === 'fetch failed')) {
      return new ProviderError(describeFetchError(err), { retryable: true, provider: details.provider });
    }
    return null;
  }

  /**
   * Check whether this error represents a context-window-exceeded / prompt-too-long
   * condition. The Anthropic API returns HTTP 400 with error type
   * "invalid_request_error" and a message containing "prompt is too long" or
   * "context_window_exceeded".
   */
  get isContextWindowExceeded(): boolean {
    if (this.statusCode !== 400 && this.statusCode !== 413 && this.statusCode !== 422) return false;
    const msg = this.message.toLowerCase();
    return (
      msg.includes('prompt is too long') ||
      msg.includes('context_window_exceeded') ||
      msg.includes('context_length_exceeded') ||
      msg.includes('prompt_too_long') ||
      msg.includes('maximum context length') ||
      msg.includes('context window') ||
      msg.includes('exceeds the available context size')
    );
  }
}

/**
 * Raised when a provider has exhausted its overload budget for the current
 * model. The query loop treats this as "switch to the fallback model now"
 * rather than "back off and try the same model again", so it does not consume
 * the retry budget — and without a fallback model it is surfaced as is.
 */
export class ModelFallbackError extends ProviderError {
  constructor(message: string, options?: { statusCode?: number; provider?: string }) {
    super(message, {
      statusCode: options?.statusCode ?? 529,
      retryable: true,
      provider: options?.provider,
      retriesExhausted: true,
    });
    this.name = 'ModelFallbackError';
  }
}

/**
 * The same failure, recorded as retried to the provider's budget. Errors that
 * carry no provider status pass through unchanged — nothing downstream would
 * retry them anyway.
 */
export function withRetriesExhausted(err: Error): Error {
  if (!(err instanceof ProviderError) || err.retriesExhausted) return err;
  return new ProviderError(err.message, {
    statusCode: err.statusCode,
    retryable: err.retryable,
    provider: err.provider,
    retriesExhausted: true,
    requestRejected: err.requestRejected,
  });
}

/**
 * Check whether an arbitrary error represents a context-window-exceeded condition.
 * Works with both ProviderError and raw Error objects from provider SDKs.
 */
export function isContextWindowExceededError(err: unknown): boolean {
  return ProviderError.from(err)?.isContextWindowExceeded ?? false;
}

/** Return a lower output ceiling only for explicit 400/422 parameter-range rejections. */
export function outputTokenLimitFromError(err: unknown, requestedMaxTokens: number): number | undefined {
  if (!(err instanceof Error) || !Number.isSafeInteger(requestedMaxTokens) || requestedMaxTokens <= 0) return undefined;
  const details = err as { statusCode?: unknown; status?: unknown };
  const status = details.statusCode ?? details.status;
  if (status !== 400 && status !== 422) return undefined;

  const msg = err.message.trim()
    .replace(/^(?:[a-z][a-z0-9 ._-]{0,80} )?API error \((?:400|422)\):\s*/i, '')
    .replace(/^Upstream request failed:\s*/i, '')
    .replace(/^\[invalid_request_error\]\s*/i, '');
  const match = /^(['"`]?)max_(?:tokens|completion_tokens|output_tokens)\1\s+must\s+be\s+between\s+1\s+and\s+(\d+)(?:\s+\(request_id:\s*[a-z0-9_-]+\))?\.?\s*$/i.exec(msg);
  if (!match) return undefined;
  const ceiling = Number(match[2]);
  return Number.isSafeInteger(ceiling) && ceiling > 0 && ceiling < requestedMaxTokens ? ceiling : undefined;
}

/**
 * The provider refused a reasoning block in the history because its signature
 * does not verify, as when reasoning recorded under another model is sent to
 * one that signs its own (`messages.1.content.0: Invalid \`signature\` in
 * \`thinking\` block`).
 */
export function isInvalidThinkingSignatureError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const status = (err as { statusCode?: number }).statusCode ?? (err as { status?: number }).status;
  if (status !== undefined && status !== 400) return false;
  const msg = err.message.toLowerCase();
  return msg.includes('signature') && msg.includes('thinking');
}

// ---------------------------------------------------------------------------
// Tool execution error
// ---------------------------------------------------------------------------

/** Error thrown when a tool fails during execution. */
export class ToolExecutionError extends SDKError {
  /** Name of the tool that failed */
  readonly toolName: string;
  /** Input that was passed to the tool */
  readonly toolInput: Record<string, unknown>;

  constructor(
    toolName: string,
    toolInput: Record<string, unknown>,
    message: string,
  ) {
    super('TOOL_EXECUTION_ERROR', message);
    this.name = 'ToolExecutionError';
    this.toolName = toolName;
    this.toolInput = toolInput;
  }
}

// ---------------------------------------------------------------------------
// Budget exceeded
// ---------------------------------------------------------------------------

/** Error thrown when the cost budget has been exceeded. */
export class BudgetExceededError extends SDKError {
  /** Current accumulated cost in USD */
  readonly currentCostUsd: number;
  /** Configured maximum budget in USD */
  readonly maxBudgetUsd: number;

  constructor(currentCostUsd: number, maxBudgetUsd: number) {
    const values = { spent: currentCostUsd.toFixed(4), maximum: maxBudgetUsd.toFixed(4) };
    super(
      'BUDGET_EXCEEDED',
      baselineText('context.execution.budget', values),
    );
    this.name = 'BudgetExceededError';
    this.currentCostUsd = currentCostUsd;
    this.maxBudgetUsd = maxBudgetUsd;
    attachHarness(this, 'context.execution.budget', values);
  }
}

// ---------------------------------------------------------------------------
// Max turns exceeded
// ---------------------------------------------------------------------------

/** Error thrown when the maximum number of conversation turns is reached. */
export class MaxTurnsExceededError extends SDKError {
  /** Number of turns completed */
  readonly turns: number;
  /** Configured maximum turns */
  readonly maxTurns: number;

  constructor(turns: number, maxTurns: number) {
    const values = { completed: String(turns), maximum: String(maxTurns) };
    super(
      'MAX_TURNS_EXCEEDED',
      baselineText('context.execution.max_turns', values),
    );
    this.name = 'MaxTurnsExceededError';
    this.turns = turns;
    this.maxTurns = maxTurns;
    attachHarness(this, 'context.execution.max_turns', values);
  }
}

// ---------------------------------------------------------------------------
// Abort error
// ---------------------------------------------------------------------------

/** Error thrown when an operation is cancelled via AbortSignal. */
export class AbortError extends SDKError {
  constructor(message = baselineText('context.execution.aborted')) {
    super('ABORTED', message);
    this.name = 'AbortError';
    if (arguments[0] === undefined) attachHarness(this, 'context.execution.aborted');
  }
}

// ---------------------------------------------------------------------------
// Multi-variant abort detection
// ---------------------------------------------------------------------------

/**
 * Detect whether an error represents an abort/cancellation, regardless of
 * source. Covers:
 * - Our own `AbortError`
 * - Anthropic SDK's `APIUserAbortError`
 * - DOM `DOMException` with name "AbortError" (fetch)
 * - Any error where the associated signal is already aborted
 */
export function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (err instanceof AbortError) return true;

  if (err instanceof Error) {
    // DOMException thrown by fetch when the signal is aborted
    if (err.name === 'AbortError') return true;
    // Anthropic SDK abort class
    if (err.name === 'APIUserAbortError') return true;
    // Some libraries set err.code
    if ((err as { code?: string }).code === 'ABORT_ERR') return true;
  }

  // Signal-based detection: if the signal is aborted, treat any error as abort
  if (signal?.aborted) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Compact error
// ---------------------------------------------------------------------------

/** Error thrown when context compaction fails. */
export class CompactError extends SDKError {
  constructor(message = baselineText('context.error.compact')) {
    super('COMPACT_ERROR', message);
    this.name = 'CompactError';
    if (arguments[0] === undefined) attachHarness(this, 'context.error.compact');
  }
}

// ---------------------------------------------------------------------------
// Resume history error
// ---------------------------------------------------------------------------

/** Code of {@link ResumeHistoryError}; survives the worker boundary, unlike the class. */
export const RESUME_HISTORY_UNAVAILABLE = 'RESUME_HISTORY_UNAVAILABLE';

/** missing: no stored history; unreadable: none of it could be read; incomplete: reading it would lose recorded content. */
export type ResumeHistoryReason = 'missing' | 'unreadable' | 'incomplete';

/**
 * A `strictResume` session refused to continue from stored history that cannot
 * be restored as recorded, so the host can continue from its own record instead.
 */
export class ResumeHistoryError extends SDKError {
  readonly reason: ResumeHistoryReason;

  constructor(reason: ResumeHistoryReason) {
    super(RESUME_HISTORY_UNAVAILABLE, baselineText('context.history.unavailable', { reason }));
    this.name = 'ResumeHistoryError';
    this.reason = reason;
    attachHarness(this, 'context.history.unavailable', { reason });
  }
}

/** True for a {@link ResumeHistoryError}, including one rebuilt from another thread. */
export function isResumeHistoryError(err: unknown): err is Error & { code: string; reason: ResumeHistoryReason } {
  return err instanceof Error && (err as { code?: unknown }).code === RESUME_HISTORY_UNAVAILABLE;
}
