/**
 * Browser Policy Unit Tests
 *
 * Covers browser-policy.service.ts:
 *   - isUrlAllowedByPolicy (modes, wildcard/exact/CIDR matching)
 *   - user-extensible custom allowlist (gating, normalization, persistence)
 *   - certificate trust for allowlisted hosts
 *
 * config.service runs for real against the per-test temp home dir from
 * tests/unit/setup.ts, so add/remove also exercise persistence.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock the product config loader so each test controls the browser policy.
// config.service also imports getDataFolderName from this module.
vi.mock('../../../src/main/foundation/product-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/foundation/product-config')>()
  return {
    ...actual,
    loadProductConfig: vi.fn(() => ({})),
    getDataFolderName: vi.fn(() => 'halo'),
  }
})

import { loadProductConfig } from '../../../src/main/foundation/product-config'
import {
  isUrlAllowedByPolicy,
  isHostnameTrustedForCertificates,
  normalizeAllowlistInput,
  getCustomAllowlist,
  addCustomAllowlistEntry,
  removeCustomAllowlistEntry,
  getBrowserPolicyView,
  BROWSER_ALLOWLIST_NOT_EDITABLE,
  BROWSER_ALLOWLIST_INVALID_PATTERN,
} from '../../../src/main/services/browser-policy.service'

const mockLoadProductConfig = vi.mocked(loadProductConfig)

function setPolicy(policy: unknown): void {
  mockLoadProductConfig.mockReturnValue({ browserPolicy: policy } as never)
}

/**
 * The custom-allowlist cache lives for the module's lifetime while setup.ts
 * gives every test a fresh temp config dir — drain entries through the
 * service's own API so cache and (current) disk state stay coherent.
 */
function clearCustomAllowlist(): void {
  setPolicy({ mode: 'allowlist', allowlist: [], userExtensible: true })
  for (const entry of [...getCustomAllowlist()]) {
    removeCustomAllowlistEntry(entry)
  }
}

describe('isUrlAllowedByPolicy', () => {
  beforeEach(() => {
    setPolicy(undefined)
  })

  describe('default / non-restricting policies', () => {
    it('allows everything when no policy is configured', () => {
      setPolicy(undefined)
      expect(isUrlAllowedByPolicy('http://10.0.0.10:8080/')).toBe(true)
      expect(isUrlAllowedByPolicy('https://anything.example.com')).toBe(true)
    })

    it('allows everything in unrestricted mode', () => {
      setPolicy({ mode: 'unrestricted' })
      expect(isUrlAllowedByPolicy('http://192.168.1.5/')).toBe(true)
    })

    it('always permits non-HTTP(S) URLs regardless of policy', () => {
      setPolicy({ mode: 'allowlist', allowlist: ['*.example.com'] })
      expect(isUrlAllowedByPolicy('about:blank')).toBe(true)
      expect(isUrlAllowedByPolicy('file:///tmp/x.html')).toBe(true)
    })
  })

  describe('allowlist mode with CIDR ranges', () => {
    beforeEach(() => {
      setPolicy({
        mode: 'allowlist',
        allowlist: ['*.example.com', '10.0.0.0/8', '192.168.0.0/16'],
      })
    })

    it('allows a bare IP inside a CIDR range (with port)', () => {
      expect(isUrlAllowedByPolicy('http://10.0.0.10:8080/')).toBe(true)
      expect(isUrlAllowedByPolicy('http://10.1.2.3/')).toBe(true)
      expect(isUrlAllowedByPolicy('http://192.168.1.1/')).toBe(true)
    })

    it('blocks an IP outside every CIDR range', () => {
      expect(isUrlAllowedByPolicy('http://11.1.2.3/')).toBe(false)
      expect(isUrlAllowedByPolicy('http://172.16.0.1/')).toBe(false)
    })

    it('still matches domain wildcards', () => {
      expect(isUrlAllowedByPolicy('https://app.example.com')).toBe(true)
      expect(isUrlAllowedByPolicy('https://example.com')).toBe(true)
    })

    it('does not let an IP slip through a domain wildcard', () => {
      setPolicy({ mode: 'allowlist', allowlist: ['*.example.com'] })
      expect(isUrlAllowedByPolicy('http://192.168.1.1/')).toBe(false)
    })

    it('does not treat a hostname as matching a CIDR pattern', () => {
      setPolicy({ mode: 'allowlist', allowlist: ['10.0.0.0/8'] })
      expect(isUrlAllowedByPolicy('https://example.com')).toBe(false)
    })
  })

  describe('CIDR boundary handling', () => {
    it('treats /0 as matching all IPv4 addresses', () => {
      setPolicy({ mode: 'allowlist', allowlist: ['0.0.0.0/0'] })
      expect(isUrlAllowedByPolicy('http://8.8.8.8/')).toBe(true)
      expect(isUrlAllowedByPolicy('http://192.168.1.1/')).toBe(true)
    })

    it('treats /32 as an exact address match', () => {
      setPolicy({ mode: 'allowlist', allowlist: ['10.0.0.5/32'] })
      expect(isUrlAllowedByPolicy('http://10.0.0.5/')).toBe(true)
      expect(isUrlAllowedByPolicy('http://10.0.0.6/')).toBe(false)
    })

    it('ignores malformed CIDR patterns instead of throwing', () => {
      setPolicy({ mode: 'allowlist', allowlist: ['10.0.0.0/33', '10.0.0.0/', '999.0.0.0/8'] })
      expect(isUrlAllowedByPolicy('http://10.0.0.1/')).toBe(false)
    })
  })

  describe('blocklist mode with CIDR ranges', () => {
    beforeEach(() => {
      setPolicy({ mode: 'blocklist', blocklist: ['10.0.0.0/8'] })
    })

    it('blocks IPs inside the CIDR range', () => {
      expect(isUrlAllowedByPolicy('http://10.5.5.5/')).toBe(false)
    })

    it('allows IPs outside the CIDR range and unrelated domains', () => {
      expect(isUrlAllowedByPolicy('http://11.5.5.5/')).toBe(true)
      expect(isUrlAllowedByPolicy('https://example.com')).toBe(true)
    })
  })
})

describe('normalizeAllowlistInput', () => {
  it('accepts plain hostnames and lowercases them', () => {
    expect(normalizeAllowlistInput('Example.COM')).toBe('example.com')
    expect(normalizeAllowlistInput('  app.example.com  ')).toBe('app.example.com')
  })

  it('accepts single-label intranet hostnames', () => {
    expect(normalizeAllowlistInput('oa')).toBe('oa')
  })

  it('accepts wildcard patterns', () => {
    expect(normalizeAllowlistInput('*.example.com')).toBe('*.example.com')
  })

  it('extracts the hostname from full URLs', () => {
    expect(normalizeAllowlistInput('https://orders.vendor.example.cn/list')).toBe('orders.vendor.example.cn')
    expect(normalizeAllowlistInput('http://app.example.com:8080/path?q=1')).toBe('app.example.com')
  })

  it('extracts the hostname from scheme-less URLs with a path', () => {
    expect(normalizeAllowlistInput('portal.example.net.cn/login')).toBe('portal.example.net.cn')
  })

  it('accepts IPv4 addresses and CIDR ranges', () => {
    expect(normalizeAllowlistInput('10.1.2.3')).toBe('10.1.2.3')
    expect(normalizeAllowlistInput('10.0.0.0/8')).toBe('10.0.0.0/8')
  })

  it('rejects malformed CIDR ranges', () => {
    expect(normalizeAllowlistInput('10.0.0.0/33')).toBeNull()
    expect(normalizeAllowlistInput('999.0.0.0/8')).toBeNull()
  })

  it('rejects unsupported schemes and garbage', () => {
    expect(normalizeAllowlistInput('javascript://evil')).toBeNull()
    expect(normalizeAllowlistInput('file:///etc/passwd')).toBeNull()
    expect(normalizeAllowlistInput('')).toBeNull()
    expect(normalizeAllowlistInput('has space.com')).toBeNull()
    expect(normalizeAllowlistInput('bad_underscore.com')).toBeNull()
  })
})

describe('user-extensible custom allowlist', () => {
  beforeEach(() => {
    clearCustomAllowlist()
  })

  it('merges custom entries on top of the built-in allowlist', () => {
    setPolicy({ mode: 'allowlist', allowlist: ['*.builtin.com'], userExtensible: true })
    expect(isUrlAllowedByPolicy('https://app.partner.example.cn/x')).toBe(false)

    addCustomAllowlistEntry('app.partner.example.cn')
    expect(isUrlAllowedByPolicy('https://app.partner.example.cn/x')).toBe(true)
    expect(isUrlAllowedByPolicy('https://other.partner.example.cn/')).toBe(false) // exact host, not wildcard
    expect(isUrlAllowedByPolicy('https://app.builtin.com/')).toBe(true) // built-ins unaffected
  })

  it('ignores custom entries when userExtensible is off', () => {
    setPolicy({ mode: 'allowlist', allowlist: [], userExtensible: true })
    addCustomAllowlistEntry('custom.example.com')

    setPolicy({ mode: 'allowlist', allowlist: ['*.builtin.com'] })
    expect(isUrlAllowedByPolicy('https://custom.example.com/')).toBe(false)
  })

  it('rejects mutations when the build is not user-extensible', () => {
    setPolicy({ mode: 'allowlist', allowlist: ['*.builtin.com'] })
    expect(() => addCustomAllowlistEntry('x.com')).toThrowError(
      expect.objectContaining({ code: BROWSER_ALLOWLIST_NOT_EDITABLE }),
    )
    expect(() => removeCustomAllowlistEntry('x.com')).toThrowError(
      expect.objectContaining({ code: BROWSER_ALLOWLIST_NOT_EDITABLE }),
    )
  })

  it('rejects invalid patterns with a stable error code', () => {
    setPolicy({ mode: 'allowlist', allowlist: [], userExtensible: true })
    expect(() => addCustomAllowlistEntry('not a domain!!')).toThrowError(
      expect.objectContaining({ code: BROWSER_ALLOWLIST_INVALID_PATTERN }),
    )
  })

  it('normalizes URLs on add and deduplicates', () => {
    setPolicy({ mode: 'allowlist', allowlist: [], userExtensible: true })
    expect(addCustomAllowlistEntry('https://Portal.Example.net.cn/login')).toBe('portal.example.net.cn')
    expect(addCustomAllowlistEntry('portal.example.net.cn')).toBe('portal.example.net.cn')
    expect([...getCustomAllowlist()]).toEqual(['portal.example.net.cn'])
  })

  it('removes entries and stops allowing them', () => {
    setPolicy({ mode: 'allowlist', allowlist: [], userExtensible: true })
    addCustomAllowlistEntry('gone.example.com')
    expect(isUrlAllowedByPolicy('https://gone.example.com/')).toBe(true)

    removeCustomAllowlistEntry('gone.example.com')
    expect(isUrlAllowedByPolicy('https://gone.example.com/')).toBe(false)
    expect([...getCustomAllowlist()]).toEqual([])
  })

  it('exposes a renderer view with editable flag and both pattern lists', () => {
    setPolicy({ mode: 'allowlist', allowlist: ['*.builtin.com'], userExtensible: true })
    addCustomAllowlistEntry('user.example.com')
    expect(getBrowserPolicyView()).toEqual({
      editable: true,
      builtinPatterns: ['*.builtin.com'],
      customPatterns: ['user.example.com'],
    })

    setPolicy({ mode: 'allowlist', allowlist: ['*.builtin.com'] })
    expect(getBrowserPolicyView()).toEqual({
      editable: false,
      builtinPatterns: ['*.builtin.com'],
      customPatterns: [],
    })
  })
})

describe('isHostnameTrustedForCertificates', () => {
  beforeEach(() => {
    clearCustomAllowlist()
  })

  it('trusts hosts matching built-in domain patterns', () => {
    setPolicy({ mode: 'allowlist', allowlist: ['*.corp.internal'] })
    expect(isHostnameTrustedForCertificates('https://app.corp.internal/')).toBe(true)
    expect(isHostnameTrustedForCertificates('https://evil.com/')).toBe(false)
  })

  it('never trusts via CIDR entries (navigation-only patterns)', () => {
    setPolicy({ mode: 'allowlist', allowlist: ['10.0.0.0/8'] })
    expect(isUrlAllowedByPolicy('https://10.1.2.3/')).toBe(true) // navigation allowed
    expect(isHostnameTrustedForCertificates('https://10.1.2.3/')).toBe(false) // cert trust denied
  })

  it('never trusts user custom entries, even when user-extensible', () => {
    setPolicy({ mode: 'allowlist', allowlist: [], userExtensible: true })
    addCustomAllowlistEntry('self-signed.intranet')
    expect(isUrlAllowedByPolicy('https://self-signed.intranet/')).toBe(true) // navigation allowed
    expect(isHostnameTrustedForCertificates('https://self-signed.intranet/')).toBe(false) // cert trust denied
  })

  it('never trusts in blocklist or unrestricted mode', () => {
    setPolicy({ mode: 'blocklist', blocklist: [] })
    expect(isHostnameTrustedForCertificates('https://anything.com/')).toBe(false)
    setPolicy({ mode: 'unrestricted' })
    expect(isHostnameTrustedForCertificates('https://anything.com/')).toBe(false)
    setPolicy(undefined)
    expect(isHostnameTrustedForCertificates('https://anything.com/')).toBe(false)
  })
})
