/**
 * Browser Policy Unit Tests
 *
 * Covers isUrlAllowedByPolicy, focusing on the IPv4 CIDR matching added for
 * private/intranet deployments where bare-IP services must be reachable
 * alongside domain allowlist entries.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock the product config loader so each test controls the browser policy.
vi.mock('../../../src/main/foundation/product-config', () => ({
  loadProductConfig: vi.fn(),
}))

import { loadProductConfig } from '../../../src/main/foundation/product-config'
import { isUrlAllowedByPolicy } from '../../../src/main/services/browser-policy.service'

const mockLoadProductConfig = vi.mocked(loadProductConfig)

function setPolicy(policy: unknown): void {
  mockLoadProductConfig.mockReturnValue({ browserPolicy: policy } as never)
}

describe('isUrlAllowedByPolicy', () => {
  beforeEach(() => {
    mockLoadProductConfig.mockReset()
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
