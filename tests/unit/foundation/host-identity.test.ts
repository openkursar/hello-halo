/**
 * host-identity unit tests.
 *
 * Covers:
 *   - getHostIdentity() field composition (username/domain/hostname/interfaces)
 *   - degrade-to-undefined on os.userInfo()/os.hostname() throw, with env fallback
 *   - interface collection: keeps virtual adapters, drops internal/IPv6/null-MAC
 *   - getLocalIp() opposite selection goal: prefers physical, falls back to virtual
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const userInfoMock = vi.fn()
const hostnameMock = vi.fn()
const networkInterfacesMock = vi.fn()

vi.mock('os', () => ({
  userInfo: (...args: unknown[]) => userInfoMock(...args),
  hostname: (...args: unknown[]) => hostnameMock(...args),
  networkInterfaces: (...args: unknown[]) => networkInterfacesMock(...args),
}))

import { getHostIdentity, getLocalIp } from '../../../src/main/foundation/host-identity'

const ORIGINAL_ENV = { ...process.env }

describe('host-identity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    userInfoMock.mockReturnValue({ username: 'testuser' })
    hostnameMock.mockReturnValue('VDI-DEV-04217')
    networkInterfacesMock.mockReturnValue({})
    delete process.env.USERDOMAIN
    delete process.env.USERNAME
    delete process.env.USER
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  describe('getHostIdentity', () => {
    it('collects username, domain, hostname, and collectedAt', () => {
      process.env.USERDOMAIN = 'CORP'
      const before = Date.now()
      const identity = getHostIdentity()
      const after = Date.now()

      expect(identity.username).toBe('testuser')
      expect(identity.userDomain).toBe('CORP')
      expect(identity.hostname).toBe('VDI-DEV-04217')
      expect(identity.collectedAt).toBeGreaterThanOrEqual(before)
      expect(identity.collectedAt).toBeLessThanOrEqual(after)
    })

    it('omits userDomain on non-Windows (USERDOMAIN unset)', () => {
      const identity = getHostIdentity()
      expect(identity.userDomain).toBeUndefined()
    })

    it('falls back to process.env.USERNAME when os.userInfo() throws', () => {
      userInfoMock.mockImplementation(() => {
        throw new Error('no passwd entry')
      })
      process.env.USERNAME = 'env-fallback'
      const identity = getHostIdentity()
      expect(identity.username).toBe('env-fallback')
    })

    it('falls back to process.env.USER when os.userInfo() throws and USERNAME is unset', () => {
      userInfoMock.mockImplementation(() => {
        throw new Error('no passwd entry')
      })
      process.env.USER = 'unix-fallback'
      const identity = getHostIdentity()
      expect(identity.username).toBe('unix-fallback')
    })

    it('leaves username undefined when os.userInfo() throws and no env fallback exists', () => {
      userInfoMock.mockImplementation(() => {
        throw new Error('no passwd entry')
      })
      const identity = getHostIdentity()
      expect(identity.username).toBeUndefined()
    })

    it('leaves hostname undefined when os.hostname() throws', () => {
      hostnameMock.mockImplementation(() => {
        throw new Error('lookup failed')
      })
      const identity = getHostIdentity()
      expect(identity.hostname).toBeUndefined()
    })

    it('never throws even when every OS call fails, degrading each field independently', () => {
      userInfoMock.mockImplementation(() => {
        throw new Error('boom')
      })
      hostnameMock.mockImplementation(() => {
        throw new Error('boom')
      })
      networkInterfacesMock.mockImplementation(() => {
        throw new Error('boom')
      })

      let identity
      expect(() => {
        identity = getHostIdentity()
      }).not.toThrow()
      expect(identity!.username).toBeUndefined()
      expect(identity!.hostname).toBeUndefined()
      expect(identity!.interfaces).toEqual([])
    })
  })

  describe('interface collection (via getHostIdentity)', () => {
    it('includes virtual adapters — unlike getLocalIp, no filtering by name', () => {
      networkInterfacesMock.mockReturnValue({
        'vEthernet (Default Switch)': [
          { address: '172.28.16.1', mac: '00:15:5d:01:64:0a', family: 'IPv4', internal: false },
        ],
        'Ethernet': [
          { address: '10.107.55.183', mac: '00:50:56:a1:3f:c2', family: 'IPv4', internal: false },
        ],
      })
      const identity = getHostIdentity()
      expect(identity.interfaces).toHaveLength(2)
      expect(identity.interfaces).toContainEqual({
        name: 'vEthernet (Default Switch)',
        mac: '00:15:5d:01:64:0a',
        ipv4: '172.28.16.1',
      })
      expect(identity.interfaces).toContainEqual({
        name: 'Ethernet',
        mac: '00:50:56:a1:3f:c2',
        ipv4: '10.107.55.183',
      })
    })

    it('drops internal (loopback) interfaces', () => {
      networkInterfacesMock.mockReturnValue({
        lo0: [{ address: '127.0.0.1', mac: '00:00:00:00:00:00', family: 'IPv4', internal: true }],
      })
      expect(getHostIdentity().interfaces).toHaveLength(0)
    })

    it('drops IPv6 addresses', () => {
      networkInterfacesMock.mockReturnValue({
        en0: [{ address: 'fe80::1', mac: 'aa:bb:cc:dd:ee:ff', family: 'IPv6', internal: false }],
      })
      expect(getHostIdentity().interfaces).toHaveLength(0)
    })

    it('drops the null MAC (unbound adapter, pure noise)', () => {
      networkInterfacesMock.mockReturnValue({
        eth1: [{ address: '10.0.0.5', mac: '00:00:00:00:00:00', family: 'IPv4', internal: false }],
      })
      expect(getHostIdentity().interfaces).toHaveLength(0)
    })
  })

  describe('getLocalIp', () => {
    it('prefers a physical interface over a virtual one', () => {
      networkInterfacesMock.mockReturnValue({
        docker0: [{ address: '172.17.0.1', mac: '02:42:ac:11:00:01', family: 'IPv4', internal: false }],
        en0: [{ address: '192.168.1.50', mac: '4c:20:b8:e7:ae:f7', family: 'IPv4', internal: false }],
      })
      expect(getLocalIp()).toBe('192.168.1.50')
    })

    it('falls back to a virtual interface when no physical one is present', () => {
      networkInterfacesMock.mockReturnValue({
        docker0: [{ address: '172.17.0.1', mac: '02:42:ac:11:00:01', family: 'IPv4', internal: false }],
      })
      expect(getLocalIp()).toBe('172.17.0.1')
    })

    it('returns null when no usable interface exists', () => {
      networkInterfacesMock.mockReturnValue({
        lo0: [{ address: '127.0.0.1', mac: '00:00:00:00:00:00', family: 'IPv4', internal: true }],
      })
      expect(getLocalIp()).toBeNull()
    })
  })
})
