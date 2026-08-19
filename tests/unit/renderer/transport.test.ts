/**
 * Unit tests for the pure platform-detection + URL-derivation helpers in
 * renderer/api/transport.ts.
 *
 * Scope is limited to isElectron / isCapacitor / isRemoteClient and
 * getRemoteServerUrl derivation. The WebSocket lifecycle is out of scope.
 *
 * The test env is node, so window/document/Capacitor are stubbed on globalThis
 * per-test and torn down afterwards. The module reads these globals at call
 * time (not import time), so a plain static import is sufficient.
 */

import { describe, it, expect, afterEach } from 'vitest'
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
  for (const key of installed) {
    delete (globalThis as Record<string, unknown>)[key]
  }
  installed.clear()
  // Reset the module's pending-URL singleton so tests don't leak state.
  clearServerUrl()
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
