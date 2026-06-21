/**
 * URL Utilities
 *
 * URL helpers for API endpoint handling and normalization.
 */

/**
 * Extract base URL (protocol + host) from endpoint URL
 */
export function extractBaseUrl(endpointUrl: string): string {
  const url = new URL(endpointUrl)
  return `${url.protocol}//${url.host}`
}

/**
 * Hosts that serve genuine first-party Anthropic responses (well-formed native
 * SSE). This is the Claude API endpoint used by both API-key and OAuth
 * ("Claude auth") sources.
 */
const NATIVE_ANTHROPIC_HOSTS = new Set<string>([
  'api.anthropic.com'
])

/**
 * Whether an upstream URL points at a genuine first-party Anthropic endpoint.
 *
 * Drives the streaming choice in handleAnthropicPassthrough: native hosts are
 * piped verbatim, while third-party Anthropic-compatible providers (GLM, etc.)
 * go through the re-serialization repair pipeline. The repair pipeline's
 * one-shot reasoning state machine drops interleaved `thinking` text, so it
 * must be bypassed for native streams.
 *
 * Unparseable URLs are treated as non-native (safe default: keep repair).
 */
export function isNativeAnthropicHost(url: string): boolean {
  try {
    return NATIVE_ANTHROPIC_HOSTS.has(new URL(url).host)
  } catch {
    return false
  }
}

/**
 * Normalize API URL based on wire format
 *
 * Ensures URLs are in the correct format expected by the router:
 * - 'anthropic'              — base URL only (Claude Agent SDK appends /v1/messages natively)
 * - 'anthropic_passthrough'  — full URL with /v1/messages suffix (router POSTs as-is)
 * - 'openai'                 — full URL with /chat/completions suffix
 *
 * For `anthropic_passthrough` the router's handleAnthropicPassthrough sends
 * the body to backendUrl verbatim, so callers must supply the complete
 * endpoint. claude.provider.ts builds it inline; this function gives the
 * generic API-key path the same composition.
 *
 * @param apiUrl - User-provided URL (may be incomplete)
 * @param provider - Wire format
 * @returns Normalized URL ready for use
 */
export function normalizeApiUrl(
  apiUrl: string,
  provider: 'anthropic' | 'anthropic_passthrough' | 'openai'
): string {
  const trimSlash = (s: string) => s.replace(/\s/g, '').replace(/\/+$/, '')
  let normalized = trimSlash(apiUrl)

  if (provider === 'anthropic') {
    // Anthropic: just trim trailing slashes
    return normalized
  }

  if (provider === 'anthropic_passthrough') {
    if (/\/v1\/messages$/.test(normalized)) {
      return normalized
    }
    return `${normalized}/v1/messages`
  }

  // OpenAI compatible: ensure URL ends with valid endpoint
  // Already has full endpoint? Return as-is
  if (normalized.endsWith('/chat/completions') || normalized.endsWith('/responses')) {
    return normalized
  }

  // Strip incomplete path suffix
  if (normalized.endsWith('/chat')) {
    normalized = normalized.slice(0, -5)
  }

  // Host-only URL defaults to OpenAI's /v1 API base.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]+$/.test(normalized)) {
    normalized = `${normalized}/v1`
  }

  return `${normalized}/chat/completions`
}
