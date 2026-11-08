/**
 * Unit tests for platform detection, URL derivation and Git repository API
 * routing through the desktop, remote-browser and Capacitor transports.
 * The WebSocket lifecycle is out of scope.
 *
 * The test env is node, so window/document/Capacitor are stubbed on globalThis
 * per-test and torn down afterwards. The module reads these globals at call
 * time (not import time), so a plain static import is sufficient.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { gitApi } from '../../../src/renderer/api/git.api'
import {
  isElectron,
  isCapacitor,
  isRemoteClient,
  getRemoteServerUrl,
  setServerUrl,
  clearServerUrl,
} from '../../../src/renderer/api/transport'

// Track which globals a test installed so afterEach can remove them cleanly.
const installed = new Set<string>()

function setGlobal(key: string, value: unknown): void {
  installed.add(key)
  ;(globalThis as Record<string, unknown>)[key] = value
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const key of installed) {
    delete (globalThis as Record<string, unknown>)[key]
  }
  installed.clear()
  // Reset the module's pending-URL singleton so tests don't leak state.
  clearServerUrl()
})

describe('Git repository API routing', () => {
  const operations = [
    { method: 'gitDiscoverRepository', route: 'discover-repository', field: 'filePath' },
    { method: 'gitOpenRepository', route: 'open-repository', field: 'repoRoot' },
    { method: 'gitForgetRepository', route: 'forget-repository', field: 'repoRoot' },
  ] as const

  it.each(operations)('routes $method directly through the desktop bridge', async ({ method }) => {
    const response = { success: false, code: 'GIT_INVALID_ARGUMENT', error: 'Invalid path' }
    const invoke = vi.fn().mockResolvedValue(response)
    setGlobal('window', { halo: { [method]: invoke } })
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    expect(await gitApi[method]('s', '/host/repo with spaces')).toBe(response)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('s', '/host/repo with spaces')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  describe.each(['remote', 'capacitor'] as const)('%s', (mode) => {
    it.each(operations)('posts $method with host paths and preserves error codes', async ({ method, route, field }) => {
      setGlobal('window', mode === 'capacitor' ? { Capacitor: { isNativePlatform: () => true } } : {})
      setGlobal('document', { baseURI: 'https://remote.example.com/halo/' })
      setGlobal('localStorage', { getItem: () => 'test-token' })
      if (mode === 'capacitor') setServerUrl('https://desktop.example.com')
      const response = { success: false, code: 'GIT_NOT_A_REPOSITORY', error: 'Not a repository' }
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(response)))
      expect(await gitApi[method]('s', '/host/repo with spaces')).toEqual(response)
      const base = mode === 'capacitor' ? 'https://desktop.example.com' : 'https://remote.example.com/halo'
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(fetchSpy).toHaveBeenCalledWith(`${base}/api/git/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
        body: JSON.stringify({ spaceId: 's', [field]: '/host/repo with spaces' }),
      })
    })
  })
})

describe('isElectron', () => {
  it('is true only when window.halo is present', () => {
    setGlobal('window', { halo: {} })
    expect(isElectron()).toBe(true)
  })

  it('is false when window exists without halo', () => {
    setGlobal('window', {})
    expect(isElectron()).toBe(false)
  })

  it('is false when window is undefined (SSR/node)', () => {
    expect(isElectron()).toBe(false)
  })
})

describe('isCapacitor', () => {
  it('is true when the Capacitor bridge reports a native platform', () => {
    setGlobal('window', { Capacitor: { isNativePlatform: () => true } })
    expect(isCapacitor()).toBe(true)
  })

  it('is false when the bridge reports a non-native platform', () => {
    setGlobal('window', { Capacitor: { isNativePlatform: () => false } })
    expect(isCapacitor()).toBe(false)
  })

  it('is false when no Capacitor bridge is injected', () => {
    setGlobal('window', {})
    expect(isCapacitor()).toBe(false)
  })

  it('is false when window is undefined', () => {
    expect(isCapacitor()).toBe(false)
  })
})

describe('isRemoteClient', () => {
  it('is true when neither Electron nor Capacitor', () => {
    setGlobal('window', {})
    expect(isRemoteClient()).toBe(true)
  })

  it('is false in Electron', () => {
    setGlobal('window', { halo: {} })
    expect(isRemoteClient()).toBe(false)
  })

  it('is false in Capacitor', () => {
    setGlobal('window', { Capacitor: { isNativePlatform: () => true } })
    expect(isRemoteClient()).toBe(false)
  })
})

describe('getRemoteServerUrl', () => {
  it('returns the configured server URL in Capacitor mode', () => {
    setGlobal('window', { Capacitor: { isNativePlatform: () => true } })
    setServerUrl('https://desktop.example.com/')
    expect(getRemoteServerUrl()).toBe('https://desktop.example.com')
  })

  it('returns empty string in Capacitor mode when no server URL is configured', () => {
    setGlobal('window', { Capacitor: { isNativePlatform: () => true } })
    expect(getRemoteServerUrl()).toBe('')
  })

  it('derives the mount directory from document.baseURI in remote mode (no trailing slash)', () => {
    setGlobal('window', {})
    setGlobal('document', { baseURI: 'https://host.example.com/fc-xxx/' })
    expect(getRemoteServerUrl()).toBe('https://host.example.com/fc-xxx')
  })

  it('derives the origin for a root-mounted remote app', () => {
    setGlobal('window', {})
    setGlobal('document', { baseURI: 'https://host.example.com/' })
    expect(getRemoteServerUrl()).toBe('https://host.example.com')
  })
})
