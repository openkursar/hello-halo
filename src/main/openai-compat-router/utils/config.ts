/**
 * Backend Configuration Utilities
 */

import type { BackendConfig } from '../types'

/**
 * Header carrying the backend config for delegated sources.
 *
 * Those requests come from a CLI subprocess that authenticates itself, so
 * `x-api-key` is absent and `Authorization` belongs to the upstream — leaving
 * no room for the encoded config on either standard channel.
 */
export const DELEGATED_ROUTING_HEADER = 'x-halo-backend'

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
    // Validate required fields. Delegated configs legitimately carry no key —
    // the caller's own Authorization header is the credential.
    if (parsed?.url && (parsed.key || parsed.delegatedAuth)) {
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
