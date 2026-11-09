/**
 * SDK Redaction Utilities
 *
 * First-pass sanitization for log output within the SDK.
 * Applied at the call site before passing data to the logger.
 *
 * Design:
 * - Pure functions, zero side effects, zero external dependencies.
 * - Defensive: when in doubt, redact.
 * - The host application's logger adapter may apply additional redaction
 *   (defense in depth), but this module handles the SDK's own responsibility.
 *
 * Usage:
 *   import { redactHeaders, redactSecrets, truncateField } from '../utils/redact.js';
 *   log.debug('request', { headers: redactHeaders(rawHeaders) });
 */

// ============================================================================
// Secret patterns
// ============================================================================

/**
 * Headers whose values must be replaced with [REDACTED].
 * Matched case-insensitively.
 */
const SECRET_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-session-token',
]);

/**
 * Regex patterns for secrets embedded in arbitrary text.
 * Applied globally — each pattern gets its own replace pass.
 */
const SECRET_PATTERNS: RegExp[] = [
  // Anthropic API keys (sk-ant-api03-...)
  /sk-ant-[a-zA-Z0-9_-]{20,}/g,
  // OpenAI-style keys (sk-...)
  /sk-[a-zA-Z0-9]{20,}/g,
  // Bearer tokens embedded in text
  /Bearer\s+[a-zA-Z0-9._\-/+]{20,}/gi,
];

// ============================================================================
// Public API
// ============================================================================

/**
 * Redact sensitive headers from a header map.
 * Returns a new object — the original is not mutated.
 *
 * @param headers - Raw headers to sanitize.
 * @returns New headers object with secret values replaced.
 */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (SECRET_HEADERS.has(key.toLowerCase())) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Replace inline secret patterns in text with [REDACTED].
 *
 * @param text - Arbitrary text that may contain embedded secrets.
 * @returns Sanitized text.
 */
export function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

/**
 * Truncate a string value to a maximum length.
 * Returns the original if within bounds; otherwise appends a size summary.
 *
 * @param value - String to truncate.
 * @param maxChars - Maximum character count (default 2048).
 * @returns Original or truncated string with suffix.
 */
export function truncateField(value: string, maxChars = 2048): string {
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars) + `…(truncated, total ${value.length} chars)`;
}
