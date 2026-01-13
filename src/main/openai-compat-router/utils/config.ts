/**
 * Backend Configuration Utilities
 */

import type { BackendConfig } from '../types'

/**
 * Encode backend configuration to base64 string
 */
export function encodeBackendConfig(config: BackendConfig): string {
  return Buffer.from(JSON.stringify(config)).toString('base64')
}

/**
 * Decode backend configuration from base64 string
 * Returns null if decoding fails or config is invalid
 */
export function decodeBackendConfig(encoded: string): BackendConfig | null {
  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8')
    const parsed = JSON.parse(decoded) as BackendConfig
    // Validate required fields
    if (parsed?.url && parsed?.key) {
      return parsed
    }
  } catch {
    // Ignore decoding errors
  }
  return null
}

/**
 * Validate backend configuration
 */
export function isValidBackendConfig(config: unknown): config is BackendConfig {
  if (!config || typeof config !== 'object') return false
  const cfg = config as Record<string, unknown>
  return typeof cfg.url === 'string' && typeof cfg.key === 'string'
}
