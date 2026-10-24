/**
 * Diagnostics Sanitizer - Remove sensitive data from reports
 *
 * Ensures no API keys, tokens, or personal information
 * are included in diagnostic reports.
 */

import type { DiagnosticReport } from '../types'

// Patterns that indicate sensitive data
const SENSITIVE_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/g,           // API keys
  /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, // UUIDs (if they're tokens)
  /eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]*/g,  // JWT tokens
  /Bearer\s+[a-zA-Z0-9._-]+/gi,     // Bearer tokens
]

// Paths that should have username redacted
const pathRegex = /\/(Users|home)\/[^/\s]+/g

/**
 * Sanitize a diagnostic report
 */
export function sanitizeReport(report: DiagnosticReport): DiagnosticReport {
  // Deep clone to avoid modifying original
  const sanitized = JSON.parse(JSON.stringify(report)) as DiagnosticReport

  // Sanitize error messages
  for (const error of sanitized.recentErrors) {
    error.message = sanitizeString(error.message)
    error.source = sanitizeString(error.source)
  }
  for (const channel of sanitized.imChannels) {
    if (channel.lastError) channel.lastError = sanitizeString(channel.lastError)
  }

  return sanitized
}

/**
 * Sanitize a string by removing sensitive patterns
 */
export function sanitizeString(str: string): string {
  let result = str

  // Replace sensitive patterns
  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, '***')
  }

  // Redact usernames in paths
  result = result.replace(pathRegex, (match) => {
    const parts = match.split('/')
    if (parts.length >= 3) {
      parts[2] = '***'
    }
    return parts.join('/')
  })

  return result
}

/**
 * Sanitize a URL (keep only hostname)
 */
export function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.hostname
  } catch {
    return '***'
  }
}
