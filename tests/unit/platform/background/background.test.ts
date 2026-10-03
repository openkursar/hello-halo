/**
 * Unit tests for platform/background
 *
 * Tests:
 * - Domain extraction and partition naming
 * - KeepAlive manager (register, unregister, TTL pruning)
 *
 * Note: Tray and DaemonBrowser are Electron-dependent and tested
 * via manual/integration tests. These unit tests cover the pure logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { extractMainDomain, extractPartition } from '../../../../src/main/platform/background/partition'
import { KeepAliveManager } from '../../../../src/main/platform/background/keep-alive'

// ============================================================================
// extractMainDomain
// ============================================================================

describe('extractMainDomain', () => {
  it('should extract main domain from subdomain', () => {
    expect(extractMainDomain('item.jd.com')).toBe('jd.com')
    expect(extractMainDomain('www.taobao.com')).toBe('taobao.com')
    expect(extractMainDomain('api.sub.example.com')).toBe('example.com')
  })

  it('should return two-label domains as-is', () => {
    expect(extractMainDomain('jd.com')).toBe('jd.com')
    expect(extractMainDomain('google.com')).toBe('google.com')
  })

  it('should handle two-part TLDs', () => {
    expect(extractMainDomain('example.co.uk')).toBe('example.co.uk')
    expect(extractMainDomain('shop.example.co.uk')).toBe('example.co.uk')
    expect(extractMainDomain('www.example.com.au')).toBe('example.com.au')
  })

  it('should handle IP addresses', () => {
    expect(extractMainDomain('192.168.1.1')).toBe('192.168.1.1')
    expect(extractMainDomain('10.0.0.1')).toBe('10.0.0.1')
  })

  it('should handle IPv6 addresses', () => {
    expect(extractMainDomain('::1')).toBe('::1')
    expect(extractMainDomain('2001:db8::1')).toBe('2001:db8::1')
  })

  it('should handle localhost', () => {
    expect(extractMainDomain('localhost')).toBe('localhost')
  })

  it('should strip www prefix', () => {
    expect(extractMainDomain('www.jd.com')).toBe('jd.com')
    expect(extractMainDomain('www.example.co.uk')).toBe('example.co.uk')
  })
})

// ============================================================================
// extractPartition
// ============================================================================

describe('extractPartition', () => {
  it('should produce persist:automation-{domain} format', () => {
    expect(extractPartition('https://item.jd.com/12345')).toBe('persist:automation-jd.com')
    expect(extractPartition('https://www.taobao.com/search')).toBe('persist:automation-taobao.com')
    expect(extractPartition('http://192.168.1.1:8080/api')).toBe('persist:automation-192.168.1.1')
    expect(extractPartition('https://shop.example.co.uk/foo')).toBe('persist:automation-example.co.uk')
  })

  it('should return fallback for invalid URLs', () => {
    expect(extractPartition('not-a-url')).toBe('persist:automation-unknown')
    expect(extractPartition('')).toBe('persist:automation-unknown')
  })

  it('should handle URLs with non-standard ports', () => {
    expect(extractPartition('https://example.com:8443/path')).toBe('persist:automation-example.com')
  })
})

// ============================================================================
// KeepAliveManager
// ============================================================================

describe('KeepAliveManager', () => {
  let manager: KeepAliveManager

  beforeEach(() => {
    // Use short TTL for testing
    manager = new KeepAliveManager(5000) // 5 second TTL
  })

  it('should start with no active reasons', () => {
    expect(manager.shouldKeepAlive()).toBe(false)
    expect(manager.getActiveCount()).toBe(0)
    expect(manager.getActiveReasons()).toEqual([])
  })

  it('should register and track reasons', () => {
    manager.register('app:price-checker')
    manager.register('app:email-monitor')

    expect(manager.shouldKeepAlive()).toBe(true)
    expect(manager.getActiveCount()).toBe(2)
    expect(manager.getActiveReasons()).toContain('app:price-checker')
    expect(manager.getActiveReasons()).toContain('app:email-monitor')
  })

  it('should unregister via disposer function', () => {
    const dispose = manager.register('app:test')
    expect(manager.shouldKeepAlive()).toBe(true)

    dispose()
    expect(manager.shouldKeepAlive()).toBe(false)
    expect(manager.getActiveCount()).toBe(0)
  })

  it('should be safe to call disposer multiple times', () => {
    const dispose = manager.register('app:test')
    dispose()
    dispose() // Should not throw or double-decrement
    expect(manager.getActiveCount()).toBe(0)
  })

  it('should refresh timestamp on re-registration', () => {
    manager.register('app:test')
    const reasons1 = manager.getActiveReasons()
    expect(reasons1).toContain('app:test')

    // Re-register same reason
    manager.register('app:test')
    expect(manager.getActiveCount()).toBe(1) // Still 1, not 2
  })

  it('should auto-prune expired entries', () => {
    // Register with short TTL manager
    manager.register('app:old')

    // Fast-forward past TTL
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000) // 10s later, past 5s TTL

    expect(manager.shouldKeepAlive()).toBe(false) // Pruned during check
    expect(manager.getActiveCount()).toBe(0)

    vi.restoreAllMocks()
  })

  it('never prunes a reason registered without expiry', () => {
    manager.register('app:activated', { ttlMs: Infinity })
    manager.register('app:crashy')
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3 * 24 * 3600_000)

    expect(manager.getActiveReasons()).toEqual(['app:activated'])

    vi.restoreAllMocks()
  })

  it('should clearAll reasons', () => {
    manager.register('app:a')
    manager.register('app:b')
    manager.register('app:c')
    expect(manager.getActiveCount()).toBe(3)

    manager.clearAll()
    expect(manager.getActiveCount()).toBe(0)
    expect(manager.shouldKeepAlive()).toBe(false)
  })
})
