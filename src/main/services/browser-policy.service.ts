/**
 * Browser Policy Service — single source of truth for browser network
 * access control.
 *
 * Two layers compose the effective allowlist:
 *   1. Built-in policy from product.json (`browserPolicy`) — immutable for
 *      the process lifetime, defines the security baseline (mode + patterns).
 *   2. User custom allowlist from config.json (`browser.customAllowlist`) —
 *      mutable at runtime, can only WIDEN an allowlist (never change mode,
 *      never remove built-in entries), and is only honored when the build
 *      opts in via `browserPolicy.userExtensible: true`.
 *
 * Consumers:
 *   - browser-view.service.ts — navigation enforcement (create / navigate /
 *     window.open / will-navigate / will-redirect)
 *   - ai-browser/tools/download.ts — direct download URL check
 *   - main/index.ts — certificate trust for allowlisted intranet hosts
 *   - ipc/browser-policy.ts — settings UI and blocked-page "allow and retry"
 */

import { loadProductConfig } from '../foundation/product-config'
import { getConfig, saveConfig } from '../foundation/config.service'
import { isBrowserAllowlistUserExtensible } from './security-policy'

// ============================================
// Pattern matching
// ============================================

/**
 * Parse a dotted-quad IPv4 string into a 32-bit unsigned integer.
 * Returns null for anything that is not a strictly-formatted IPv4 address,
 * so callers can cleanly distinguish IPs from hostnames.
 */
function parseIPv4(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null

  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = value * 256 + octet
  }
  return value >>> 0 // force unsigned 32-bit
}

/**
 * Match an IPv4 hostname against a CIDR pattern (e.g. "10.0.0.0/8").
 * Returns false for any malformed pattern or non-IPv4 hostname, never throws.
 *
 * - `/0` matches every IPv4 address.
 * - `/32` requires an exact address match.
 */
function matchCidr(hostname: string, pattern: string): boolean {
  const slashIndex = pattern.indexOf('/')
  if (slashIndex === -1) return false

  const prefixText = pattern.slice(slashIndex + 1)
  if (!/^\d{1,2}$/.test(prefixText)) return false
  const prefix = Number(prefixText)
  if (prefix > 32) return false

  const hostInt = parseIPv4(hostname)
  const baseInt = parseIPv4(pattern.slice(0, slashIndex))
  if (hostInt === null || baseInt === null) return false

  if (prefix === 0) return true
  const mask = (0xffffffff << (32 - prefix)) >>> 0
  return ((hostInt & mask) >>> 0) === ((baseInt & mask) >>> 0)
}

/**
 * Match a hostname against a domain or IP pattern.
 *
 * Supported patterns:
 * - "*.example.com"  → matches "example.com" and any subdomain (e.g. "app.example.com")
 * - "example.com"    → exact hostname match
 * - "10.0.0.0/8"     → IPv4 CIDR range (only matches IPv4 hostnames)
 * - "192.168.1.1"    → exact IPv4 match (handled by the exact-match branch)
 */
function matchDomainPattern(hostname: string, pattern: string): boolean {
  const lowerHost = hostname.toLowerCase()
  const lowerPattern = pattern.toLowerCase()

  // CIDR ranges only make sense for IPv4 hostnames; matchCidr safely rejects
  // hostname-vs-CIDR and IP-vs-domain mismatches.
  if (lowerPattern.includes('/')) {
    return matchCidr(lowerHost, lowerPattern)
  }

  if (lowerPattern.startsWith('*.')) {
    const baseDomain = lowerPattern.slice(2) // "example.com"
    return lowerHost === baseDomain || lowerHost.endsWith('.' + baseDomain)
  }

  return lowerHost === lowerPattern
}

// ============================================
// User custom allowlist
// ============================================

/**
 * In-memory cache of `browser.customAllowlist` from config.json.
 *
 * The list sits on the navigation hot path (will-navigate / will-redirect
 * fire on every main-frame hop), so we must not re-read and re-parse the
 * config file per check. All mutations go through addCustomAllowlistEntry /
 * removeCustomAllowlistEntry which keep this cache coherent; direct edits
 * to config.json while the app is running are picked up on next start.
 */
let cachedCustomAllowlist: string[] | null = null

export function getCustomAllowlist(): readonly string[] {
  if (cachedCustomAllowlist === null) {
    const list = getConfig().browser?.customAllowlist
    cachedCustomAllowlist = Array.isArray(list)
      ? list.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
      : []
  }
  return cachedCustomAllowlist
}

/**
 * Normalize raw user input into a canonical allowlist pattern.
 *
 * Accepted forms (case-insensitive, surrounding whitespace ignored):
 *   - Full URL ("https://app.example.com/path") → hostname ("app.example.com")
 *   - Hostname with path ("app.example.com/login") → hostname
 *   - Bare hostname ("app.example.com", single-label intranet names allowed)
 *   - Wildcard ("*.example.com")
 *   - IPv4 ("10.1.2.3") and IPv4 CIDR ("10.0.0.0/8")
 *
 * Returns the normalized pattern, or null when the input cannot be a valid
 * pattern (unsupported scheme, illegal hostname characters, malformed CIDR).
 */
export function normalizeAllowlistInput(input: string): string | null {
  let value = input.trim().toLowerCase()
  if (!value) return null

  if (value.includes('://')) {
    try {
      const parsed = new URL(value)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
      value = parsed.hostname
    } catch {
      return null
    }
  }

  if (value.includes('/')) {
    // Either an IPv4 CIDR pattern, or a hostname with a path pasted without scheme.
    if (/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(value)) {
      const slashIndex = value.indexOf('/')
      if (Number(value.slice(slashIndex + 1)) > 32) return null
      if (parseIPv4(value.slice(0, slashIndex)) === null) return null
      return value
    }
    try {
      value = new URL('https://' + value).hostname
    } catch {
      return null
    }
  }

  if (value.endsWith('.')) value = value.slice(0, -1)
  if (parseIPv4(value) !== null) return value

  const host = value.startsWith('*.') ? value.slice(2) : value
  if (host.length === 0 || host.length > 253) return null
  for (const label of host.split('.')) {
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) return null
  }
  return value
}

/** Stable error codes for the IPC boundary (renderer maps them to localized text). */
export const BROWSER_ALLOWLIST_NOT_EDITABLE = 'BROWSER_ALLOWLIST_NOT_EDITABLE'
export const BROWSER_ALLOWLIST_INVALID_PATTERN = 'BROWSER_ALLOWLIST_INVALID_PATTERN'

class BrowserAllowlistError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'BrowserAllowlistError'
  }
}

function assertEditable(): void {
  if (!isBrowserAllowlistUserExtensible()) {
    throw new BrowserAllowlistError(
      BROWSER_ALLOWLIST_NOT_EDITABLE,
      'Custom browser allowlist is not enabled in this build',
    )
  }
}

/**
 * Validate, normalize, persist and activate a user allowlist entry.
 * Returns the normalized pattern that was stored (or that already existed —
 * adding a duplicate is a no-op, not an error).
 */
export function addCustomAllowlistEntry(input: string): string {
  assertEditable()

  const pattern = normalizeAllowlistInput(input)
  if (!pattern) {
    throw new BrowserAllowlistError(
      BROWSER_ALLOWLIST_INVALID_PATTERN,
      `Not a valid domain, IP or CIDR pattern: ${input}`,
    )
  }

  const current = getCustomAllowlist()
  if (current.includes(pattern)) return pattern

  const next = [...current, pattern]
  saveConfig({ browser: { customAllowlist: next } })
  cachedCustomAllowlist = next
  console.log(`[BrowserPolicy] Custom allowlist entry added: ${pattern} (total: ${next.length})`)
  return pattern
}

export function removeCustomAllowlistEntry(pattern: string): void {
  assertEditable()

  const current = getCustomAllowlist()
  const next = current.filter(entry => entry !== pattern)
  if (next.length === current.length) return

  saveConfig({ browser: { customAllowlist: next } })
  cachedCustomAllowlist = next
  console.log(`[BrowserPolicy] Custom allowlist entry removed: ${pattern} (total: ${next.length})`)
}

/** Renderer-facing snapshot of the effective policy for the settings UI. */
export interface BrowserPolicyView {
  /** True when the user may add/remove custom entries in this build. */
  editable: boolean
  /** Read-only patterns from product.json (empty when no allowlist policy). */
  builtinPatterns: string[]
  /** User-managed patterns (empty when not editable). */
  customPatterns: string[]
}

export function getBrowserPolicyView(): BrowserPolicyView {
  const policy = loadProductConfig().browserPolicy
  const editable = isBrowserAllowlistUserExtensible()
  return {
    editable,
    builtinPatterns: policy?.mode === 'allowlist' ? [...(policy.allowlist ?? [])] : [],
    customPatterns: editable ? [...getCustomAllowlist()] : [],
  }
}

// ============================================
// Policy enforcement
// ============================================

/**
 * Check whether a URL is permitted by the browser policy from product.json.
 *
 * - No policy configured → always allowed (open-source default).
 * - Non-HTTP(S) URLs (about:blank, file://, etc.) → always allowed.
 * - Allowlist mode → URL must match a built-in pattern, or (when the build
 *   enables `userExtensible`) a user custom allowlist entry.
 * - Blocklist mode → URL must NOT match any pattern.
 */
export function isUrlAllowedByPolicy(url: string): boolean {
  const policy = loadProductConfig().browserPolicy
  if (!policy || policy.mode === 'unrestricted') return true

  // Always permit non-HTTP(S) URLs (about:blank, devtools, file, etc.)
  let hostname: string
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true
    hostname = parsed.hostname
  } catch {
    // Malformed URL — let Chromium handle the error naturally
    return true
  }

  if (policy.mode === 'allowlist') {
    const patterns = policy.allowlist ?? []
    if (patterns.some(p => matchDomainPattern(hostname, p))) return true
    if (isBrowserAllowlistUserExtensible()) {
      return getCustomAllowlist().some(p => matchDomainPattern(hostname, p))
    }
    return false
  }

  if (policy.mode === 'blocklist') {
    const patterns = policy.blocklist
    if (!patterns || patterns.length === 0) return true // blocklist with no entries blocks nothing
    return !patterns.some(p => matchDomainPattern(hostname, p))
  }

  return true
}

/**
 * Certificate trust for allowlisted hosts (self-signed / private CA).
 *
 * Only consulted from the `certificate-error` app event, i.e. after Chromium
 * has already rejected the certificate — valid HTTPS traffic never reaches
 * this path.
 *
 * Deliberately NARROWER than navigation policy:
 *   - Built-in patterns only. User custom entries never gain certificate
 *     trust — "allow and retry" widens navigation, it must not silently
 *     disable TLS validation for that host. Intranet hosts that need a
 *     private CA belong in the product.json allowlist.
 *   - Domain patterns only (exact / "*."), never CIDR. A CIDR entry exists
 *     to permit navigation across an IP range, not to vouch for every
 *     certificate inside it.
 */
export function isHostnameTrustedForCertificates(url: string): boolean {
  const policy = loadProductConfig().browserPolicy
  if (policy?.mode !== 'allowlist') return false

  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    return false // Malformed URL — reject
  }

  return (policy.allowlist ?? []).some(
    p => !p.includes('/') && matchDomainPattern(hostname, p),
  )
}

/**
 * Get the default homepage URL for new browser tabs.
 *
 * - No browser policy → 'https://www.bing.com' (standard default)
 * - Policy with explicit homepage → that URL
 * - Policy without homepage → 'about:blank' (let user type an allowed URL)
 */
export function getDefaultBrowserHomepage(): string {
  const policy = loadProductConfig().browserPolicy
  if (!policy || policy.mode === 'unrestricted') return 'https://www.bing.com'
  return policy.homepage || 'about:blank'
}
