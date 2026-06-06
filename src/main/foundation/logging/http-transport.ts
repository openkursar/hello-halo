/**
 * HTTP Request/Response Transport
 *
 * Dedicated electron-log instance for raw outbound HTTP traffic logging.
 * Captures every request and response made through proxyFetch(), including
 * full headers (auth tokens), request body, response status, and timing.
 *
 * Lifecycle: Controlled exclusively by the logging controller.
 * This module does NOT subscribe to config changes directly — it exposes
 * setHttpLogging() and is toggled by the controller.
 *
 * Log file: same directory as main.log, filename = http-raw.log
 *   macOS:   ~/Library/Logs/Halo/http-raw.log
 *   Windows: %USERPROFILE%\AppData\Roaming\Halo\logs\http-raw.log
 */

import log from 'electron-log/main.js'

// ============================================================================
// Dedicated log instance
// ============================================================================

const httpLog = log.create({ logId: 'http-raw' })

// Write to a dedicated file, not main.log
httpLog.transports.file.fileName = 'http-raw.log'
// File only — do NOT write to console (would pollute the main log stream)
httpLog.transports.console.level = false
httpLog.transports.file.level = 'info'
// 20 MB per file with auto-rotation — generous for verbose request payloads
httpLog.transports.file.maxSize = 20 * 1024 * 1024

// ============================================================================
// Runtime toggle (in-memory, zero disk reads after init)
// ============================================================================

let _enabled = false

/**
 * Enable or disable HTTP request logging.
 * Idempotent — no-op if state is unchanged.
 */
export function setHttpLogging(enabled: boolean): void {
  if (_enabled === enabled) return
  _enabled = enabled
  if (enabled) {
    const filePath = getLogFilePath()
    console.log(`[HttpLogger] Raw HTTP logging ENABLED → ${filePath}`)
  } else {
    console.log('[HttpLogger] Raw HTTP logging disabled')
  }
}

/**
 * Whether HTTP logging is currently active.
 * Called on every proxyFetch() — must be O(1).
 */
export function isHttpLoggingEnabled(): boolean {
  return _enabled
}

/**
 * Resolve the log file path for display purposes.
 * electron-log v5 creates the file under the same directory as main.log.
 */
function getLogFilePath(): string {
  try {
    const file = httpLog.transports.file.getFile()
    return file?.path ?? 'http-raw.log'
  } catch {
    return 'http-raw.log'
  }
}

// ============================================================================
// Logging helpers
// ============================================================================

/**
 * Format a headers object into a readable multi-line string.
 * No sanitization — caller opted in to full logging.
 */
function formatHeaders(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join('\n')
}

/**
 * Pretty-print a JSON string, or return as-is if not parseable.
 */
function prettyBody(body: string | undefined): string {
  if (!body) return '(empty)'
  try {
    return JSON.stringify(JSON.parse(body), null, 2)
  } catch {
    return body
  }
}

// ============================================================================
// Public API
// ============================================================================

export interface HttpRequestLogEntry {
  method: string
  url: string
  headers: Record<string, string>
  /** Raw body string (typically JSON). undefined for bodyless requests. */
  body?: string
}

export interface HttpResponseLogEntry {
  method: string
  url: string
  status: number
  statusText: string
  /** Response duration in milliseconds */
  durationMs: number
  headers: Record<string, string>
}

/**
 * Log a raw outbound HTTP request.
 * No-op when logging is disabled — designed to be called unconditionally.
 */
export function logHttpRequest(entry: HttpRequestLogEntry): void {
  if (!_enabled) return

  const separator = '─'.repeat(60)
  const lines = [
    `\n${separator}`,
    `▶ ${entry.method} ${entry.url}`,
    '--- Headers ---',
    formatHeaders(entry.headers),
    '--- Body ---',
    prettyBody(entry.body),
    separator,
  ].join('\n')

  httpLog.info(lines)
}

/**
 * Log an HTTP response summary.
 * No-op when logging is disabled.
 */
export function logHttpResponse(entry: HttpResponseLogEntry): void {
  if (!_enabled) return

  const statusIcon = entry.status >= 200 && entry.status < 300 ? '✓' : '✗'
  const lines = [
    `  ◀ ${statusIcon} ${entry.status} ${entry.statusText} (${entry.durationMs}ms) ${entry.method} ${entry.url}`,
  ]

  httpLog.info(lines.join('\n'))
}

/**
 * Log the full response body (called asynchronously after body is fully read).
 * For SSE streams, this logs all events concatenated.
 * Truncates to MAX_BODY_LOG_SIZE to prevent log bloat.
 */
const MAX_BODY_LOG_SIZE = 32 * 1024 // 32KB

export function logHttpResponseBody(method: string, url: string, body: string): void {
  if (!_enabled) return

  const truncated = body.length > MAX_BODY_LOG_SIZE
    ? body.slice(0, MAX_BODY_LOG_SIZE) + `\n…(truncated, total ${body.length} bytes)`
    : body

  const lines = [
    `  ◀◀ Response Body: ${method} ${url}`,
    '  ' + prettyBody(truncated).split('\n').join('\n  '),
  ]

  httpLog.info(lines.join('\n'))
}
