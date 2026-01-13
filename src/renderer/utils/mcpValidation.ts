/**
 * MCP Server Configuration Validation
 * Validates MCP server config before saving to prevent runtime errors
 */

import type { McpServerConfig } from '../types'

/**
 * Validate a single MCP server configuration
 * @param config - The configuration object to validate
 * @returns Error message string if invalid, null if valid
 */
export function validateMcpServerConfig(config: unknown): string | null {
  // 1. Basic type check
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return 'Configuration must be an object'
  }

  const cfg = config as Record<string, unknown>

  // 2. Detect nested config error (user wrapped config in extra layer)
  // e.g., { "memory": { "command": "npx", ... } } instead of { "command": "npx", ... }
  const keys = Object.keys(cfg)
  for (const key of keys) {
    const value = cfg[key]
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = value as Record<string, unknown>
      if ('command' in nested || 'type' in nested) {
        return `Invalid format: detected nested "${key}". Configure command/args or type/url directly without extra nesting.`
      }
    }
  }

  // 3. stdio type validation (has 'command' field)
  if ('command' in cfg) {
    if (typeof cfg.command !== 'string' || !(cfg.command as string).trim()) {
      return 'command must be a non-empty string'
    }
    if (cfg.args !== undefined && !Array.isArray(cfg.args)) {
      return 'args must be an array'
    }
    if (cfg.args) {
      for (let i = 0; i < (cfg.args as unknown[]).length; i++) {
        if (typeof (cfg.args as unknown[])[i] !== 'string') {
          return `args[${i}] must be a string`
        }
      }
    }
    return null // Valid stdio config
  }

  // 4. http/sse type validation
  if (cfg.type === 'http' || cfg.type === 'sse') {
    if (typeof cfg.url !== 'string' || !(cfg.url as string).trim()) {
      return 'url must be a non-empty string'
    }
    // Basic URL format check
    try {
      new URL(cfg.url as string)
    } catch {
      return 'Invalid url format'
    }
    return null // Valid http/sse config
  }

  // 5. Unrecognized format
  return 'Invalid format: requires command (stdio) or type + url (http/sse)'
}

/**
 * Validate server name
 * @param name - The server name to validate
 * @param existingNames - List of existing server names (for duplicate check)
 * @param currentName - Current name if editing (to allow keeping same name)
 * @returns Error message string if invalid, null if valid
 */
export function validateMcpServerName(
  name: string,
  existingNames: string[],
  currentName?: string
): string | null {
  if (!name || !name.trim()) {
    return 'Server name is required'
  }

  // Check for invalid characters (only allow alphanumeric, dash, underscore)
  if (!/^[\w-]+$/.test(name)) {
    return 'Name can only include letters, numbers, underscore, and hyphen'
  }

  // Check for duplicates (excluding current name if editing)
  if (name !== currentName && existingNames.includes(name)) {
    return 'Name already exists'
  }

  return null
}
