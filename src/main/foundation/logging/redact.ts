/**
 * Logging Redaction Utilities
 *
 * Last-mile sanitization applied before writing to log files.
 * Ensures no secrets leak even if upstream callers forget to redact.
 *
 * Design:
 * - Pure functions, zero side effects, zero dependencies beyond Node builtins.
 * - Used by sdk-transport.ts as a safety net — SDK-side redact.ts handles
 *   first-pass redaction; this module catches anything that slips through.
 * - NOT a substitute for SDK-side redaction. Callers should still sanitize
 *   at the source where possible.
 */

// ============================================================================
// Secret patterns
// ============================================================================

/**
 * Headers that must never appear in log output (case-insensitive match).
 */
const SECRET_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'cookie',
  'set-cookie',
  'proxy-authorization',
])

/**
 * Regex patterns for inline secrets embedded in arbitrary text.
 * Each pattern is applied globally with replacement.
 */
const SECRET_PATTERNS: RegExp[] = [
  // Anthropic API keys
  /sk-ant-[a-zA-Z0-9_-]{20,}/g,
  // OpenAI-style keys
  /sk-[a-zA-Z0-9]{20,}/g,
  // Bearer tokens (inline)
  /Bearer\s+[a-zA-Z0-9._\-/+]{20,}/gi,
  // Generic long hex tokens (40+ chars, common in OAuth)
  /[a-f0-9]{40,}/gi,
]

// ============================================================================
// Public API
// ============================================================================

/**
 * Redact sensitive headers from a header map.
 * Returns a new object with secret header values replaced by [REDACTED].
 */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (SECRET_HEADERS.has(key.toLowerCase())) {
      result[key] = '[REDACTED]'
    } else {
      result[key] = value
    }
  }
  return result
}

/**
 * Replace secret patterns in arbitrary text with [REDACTED].
 * Lightweight — designed to be called on every log line without measurable cost.
 */
export function redactSecrets(text: string): string {
  let result = text
  for (const pattern of SECRET_PATTERNS) {
    // Reset lastIndex since patterns use /g flag
    pattern.lastIndex = 0
    result = result.replace(pattern, '[REDACTED]')
  }
  return result
}

/**
 * Truncate a string to maxBytes, appending a summary if truncated.
 * Returns the original string if within bounds.
 */
export function truncateField(value: string, maxBytes = 2048): string {
  if (value.length <= maxBytes) return value
  return value.slice(0, maxBytes) + `…(truncated, total ${value.length} chars)`
}
