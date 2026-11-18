/**
 * SDK Logger — Hexagonal Port
 *
 * Provides structured logging for the Agent SDK runtime.
 * Follows the Port/Adapter pattern:
 *
 *   - Port: Logger interface + setLogger/getLogger registry
 *   - Default adapter: console-based (works in any Node environment)
 *   - Host adapter: host-supplied file transport (injected at startup)
 *
 * Contract:
 *   - Logger is always available (never null). Default adapter is active from
 *     module load time — no initialization ceremony required.
 *   - setLogger() can be called at any time; subsequent getLogger() calls
 *     return children of the new logger. Existing child references are NOT
 *     retroactively updated (they continue using the old logger until re-fetched).
 *   - isLevelEnabled() must be O(1) — callers use it to skip expensive formatting.
 *   - Zero external dependencies.
 *
 * Usage within the SDK:
 *   import { getLogger } from '../utils/logger.js';
 *   const log = getLogger('MCP:Connection');
 *   log.info('connected', { server: name, tools: count });
 *   if (log.isLevelEnabled('debug')) {
 *     log.debug('full response', { body: truncateField(rawBody) });
 *   }
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Supported log levels in ascending priority.
 * 'silent' suppresses all output.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

/**
 * Structured fields attached to a log entry.
 * Values are serialized as key=value pairs by the adapter.
 */
export interface LogFields {
  [key: string]: unknown;
}

/**
 * The Logger interface that SDK code programs against.
 * Adapters (console, file transport, test capture) implement this.
 */
export interface Logger {
  /** Log at debug level (verbose trace, hot paths guarded by isLevelEnabled). */
  debug(message: string, fields?: LogFields): void;
  /** Log at info level (lifecycle events, summaries, milestones). */
  info(message: string, fields?: LogFields): void;
  /** Log at warn level (non-fatal issues, degraded behavior). */
  warn(message: string, fields?: LogFields | Error): void;
  /** Log at error level (failures, exceptions with stack). */
  error(message: string, fields?: LogFields | Error): void;
  /** Create a child logger with a component prefix. */
  child(component: string): Logger;
  /** O(1) check whether a given level would produce output. */
  isLevelEnabled(level: LogLevel): boolean;
}

// ============================================================================
// Level utilities
// ============================================================================

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

/** Resolve the effective level from environment or fallback. */
function resolveDefaultLevel(): LogLevel {
  const env = (typeof process !== 'undefined' && process.env?.AGENT_SDK_LOG_LEVEL) || 'info';
  if (env in LEVEL_PRIORITY) return env as LogLevel;
  return 'info';
}

// ============================================================================
// Default console adapter
// ============================================================================

/**
 * Minimal console-based logger. Used when no external adapter is injected.
 * Writes to stderr (console.error/warn/info/debug) so it doesn't interfere
 * with stdout-based protocols (MCP stdio transport, CLI output).
 */
class ConsoleLogger implements Logger {
  private readonly prefix: string;
  private readonly level: LogLevel;

  constructor(component: string, level?: LogLevel) {
    this.prefix = component ? `[${component}]` : '';
    this.level = level ?? resolveDefaultLevel();
  }

  isLevelEnabled(level: LogLevel): boolean {
    return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this.level];
  }

  debug(message: string, fields?: LogFields): void {
    if (!this.isLevelEnabled('debug')) return;
    console.debug(`${this.prefix} ${message}${this.formatFields(fields)}`);
  }

  info(message: string, fields?: LogFields): void {
    if (!this.isLevelEnabled('info')) return;
    console.info(`${this.prefix} ${message}${this.formatFields(fields)}`);
  }

  warn(message: string, fields?: LogFields | Error): void {
    if (!this.isLevelEnabled('warn')) return;
    console.warn(`${this.prefix} ${message}${this.formatFields(fields)}`);
  }

  error(message: string, fields?: LogFields | Error): void {
    if (!this.isLevelEnabled('error')) return;
    console.error(`${this.prefix} ${message}${this.formatFields(fields)}`);
  }

  child(component: string): Logger {
    const childPrefix = this.prefix ? `${this.prefix.slice(1, -1)}:${component}` : component;
    return new ConsoleLogger(childPrefix, this.level);
  }

  private formatFields(fields: LogFields | Error | undefined): string {
    if (!fields) return '';
    if (fields instanceof Error) {
      return ` err=${fields.message}`;
    }
    const parts: string[] = [];
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || value === null) continue;
      if (value instanceof Error) {
        parts.push(`${key}=${value.message}`);
      } else if (typeof value === 'string') {
        parts.push(`${key}=${value}`);
      } else {
        try { parts.push(`${key}=${JSON.stringify(value)}`); }
        catch { parts.push(`${key}=[unserializable]`); }
      }
    }
    return parts.length > 0 ? ' ' + parts.join(' ') : '';
  }
}

// ============================================================================
// Registry (module-level singleton)
// ============================================================================

/** The currently active root logger. */
let _rootLogger: Logger = new ConsoleLogger('SDK');

/** Cache of child loggers — invalidated on setLogger(). */
let _childCache = new Map<string, Logger>();

/**
 * Replace the active logger with a consumer-provided implementation.
 *
 * Typically called once at startup by the host application (e.g., the host injects
 * a file-transport adapter). Safe to call multiple times — last writer wins.
 *
 * @param logger - The new root logger. All subsequent getLogger() calls
 *   will create children from this instance.
 */
export function setLogger(logger: Logger): void {
  _rootLogger = logger;
  // Invalidate child cache so getLogger() creates fresh children from new root
  _childCache = new Map<string, Logger>();
}

/**
 * Get a logger for a specific component.
 *
 * Returns a cached child logger — safe to call repeatedly in hot paths.
 * Component naming convention: `Layer:Detail` (e.g., 'LLM:Anthropic', 'Tool:Bash').
 *
 * @param component - Logical component name for log prefix.
 */
export function getLogger(component: string): Logger {
  let cached = _childCache.get(component);
  if (!cached) {
    cached = _rootLogger.child(component);
    _childCache.set(component, cached);
  }
  return cached;
}

/**
 * Get the root logger directly (rare — prefer getLogger with a component name).
 */
export function getRootLogger(): Logger {
  return _rootLogger;
}
