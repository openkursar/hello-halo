/**
 * URL Utilities
 *
 * Simple URL helpers. No normalization or inference - URL is used as-is.
 */

/**
 * Extract base URL (protocol + host) from endpoint URL
 */
export function extractBaseUrl(endpointUrl: string): string {
  const url = new URL(endpointUrl)
  return `${url.protocol}//${url.host}`
}
