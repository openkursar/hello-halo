/**
 * SDK Log Transport
 *
 * Dedicated electron-log instance for Halo SDK (@hello-halo/agent-sdk) output.
 * Implements the SDK's Logger interface and writes structured entries to
 * halo-sdk.log, independent of main.log.
 *
 * Lifecycle: Controlled by the logging controller (controller.ts).
 * - Default level: 'info' (always-on for production diagnostics)
 * - Developer Mode: bumps to 'debug' for full trace output
 *
 * Log file: same directory as main.log, filename = halo-sdk.log
 *   macOS:   ~/Library/Logs/Halo/halo-sdk.log
 *   Windows: %USERPROFILE%\AppData\Roaming\Halo\logs\halo-sdk.log
 *
 * Architecture:
 *   SDK defines a Logger port (interface + setLogger DI).
 *   This file is the driving adapter that binds that port to electron-log.
 *   It does NOT import from the SDK at compile time — types are duplicated
 *   locally to avoid coupling the logging module to the SDK package.
 */

import log from 'electron-log/main.js'
import { redactSecrets, truncateField } from './redact'

// ============================================================================
// Dedicated log instance
// ============================================================================

const sdkLog = log.create({ logId: 'halo-sdk' })

sdkLog.transports.file.fileName = 'halo-sdk.log'
// File only — do NOT write to console (avoids polluting main.log)
sdkLog.transports.console.level = false
// Default: info level — always-on for production diagnostics
sdkLog.transports.file.level = 'info'
// 20 MB per file, electron-log auto-rotates to .old
sdkLog.transports.file.maxSize = 20 * 1024 * 1024

// ============================================================================
// Level management
// ============================================================================

/** Log level priority map for O(1) comparison. */
const LEVEL_PRIORITY: Record<string, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
}

let _currentLevel: string = 'info'

/**
 * Set the SDK log level.
 * Called by the logging controller when Developer Mode toggles.
 */
export function setSdkLogLevel(level: string): void {
  if (_currentLevel === level) return
  _currentLevel = level

  // Map to electron-log transport level
  const transportLevel = level === 'silent' ? false : level
  sdkLog.transports.file.level = transportLevel as any

  console.log(`[SdkTransport] SDK log level → ${level}`)
}

/**
 * Get the current SDK log level.
 */
export function getSdkLogLevel(): string {
  return _currentLevel
}

// ============================================================================
// Logger adapter (implements SDK Logger interface locally)
// ============================================================================

/**
 * Structured fields attached to a log entry.
 * Mirrors the SDK's LogFields type without importing it.
 */
interface LogFields { [key: string]: unknown }

/**
 * Logger interface — mirrors SDK's Logger port.
 * Duplicated here to avoid compile-time SDK dependency.
 */
interface Logger {
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields | Error): void
  error(message: string, fields?: LogFields | Error): void
  child(component: string): Logger
  isLevelEnabled(level: string): boolean
}

/**
 * Format structured fields into a compact key=value suffix.
 * Applies redaction + truncation to all string values.
 */
function formatFields(fields: LogFields | Error | undefined): string {
  if (!fields) return ''
  if (fields instanceof Error) {
    return ` err=${fields.message}${fields.stack ? '\n' + fields.stack : ''}`
  }
  const parts: string[] = []
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue
    let formatted: string
    if (typeof value === 'string') {
      formatted = redactSecrets(truncateField(value, 2048))
    } else if (value instanceof Error) {
      formatted = value.message
    } else {
      try {
        formatted = JSON.stringify(value)
      } catch {
        formatted = String(value)
      }
    }
    parts.push(`${key}=${formatted}`)
  }
  return parts.length > 0 ? ' ' + parts.join(' ') : ''
}

/**
 * Electron-log adapter that implements the SDK Logger interface.
 * Instances are created per-component via child().
 */
class ElectronLogAdapter implements Logger {
  constructor(private readonly component: string) {}

  isLevelEnabled(level: string): boolean {
    return (LEVEL_PRIORITY[level] ?? 0) >= (LEVEL_PRIORITY[_currentLevel] ?? 0)
  }

  debug(message: string, fields?: LogFields): void {
    if (!this.isLevelEnabled('debug')) return
    const line = `[${this.component}] ${redactSecrets(message)}${formatFields(fields)}`
    sdkLog.debug(line)
  }

  info(message: string, fields?: LogFields): void {
    if (!this.isLevelEnabled('info')) return
    const line = `[${this.component}] ${redactSecrets(message)}${formatFields(fields)}`
    sdkLog.info(line)
  }

  warn(message: string, fields?: LogFields | Error): void {
    if (!this.isLevelEnabled('warn')) return
    const line = `[${this.component}] ${redactSecrets(message)}${formatFields(fields)}`
    sdkLog.warn(line)
  }

  error(message: string, fields?: LogFields | Error): void {
    if (!this.isLevelEnabled('error')) return
    const line = `[${this.component}] ${redactSecrets(message)}${formatFields(fields)}`
    sdkLog.error(line)
  }

  child(childComponent: string): Logger {
    return new ElectronLogAdapter(`${this.component}:${childComponent}`)
  }
}

// ============================================================================
// Public API
// ============================================================================

/** Root logger instance for the SDK transport. */
const rootLogger = new ElectronLogAdapter('SDK')

/**
 * Install the SDK logger by calling the SDK's setLogger function.
 *
 * @param setLoggerFn - The SDK's setLogger() export. Typed as generic function
 *   to avoid compile-time dependency on the SDK package.
 */
export function installSdkLogger(setLoggerFn: (logger: Logger) => void): void {
  setLoggerFn(rootLogger)
  const filePath = getSdkLogFilePath()
  console.log(`[SdkTransport] halo-sdk.log installed → ${filePath}`)
}

/**
 * Resolve the SDK log file path for display purposes.
 */
function getSdkLogFilePath(): string {
  try {
    const file = sdkLog.transports.file.getFile()
    return file?.path ?? 'halo-sdk.log'
  } catch {
    return 'halo-sdk.log'
  }
}
