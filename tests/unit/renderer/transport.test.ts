/**
 * Unit tests for platform detection, URL derivation, Git repository API routing
 * and HTTP error responses across desktop, remote-browser and Capacitor transports.
 * The WebSocket lifecycle is out of scope.
 *
 * The test env is node, so window/document/Capacitor are stubbed on globalThis
 * per-test and torn down afterwards. The module reads these globals at call
 * time (not import time), so a plain static import is sufficient.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { gitApi } from '../../../src/renderer/api/git.api'
import { teamApi } from '../../../src/renderer/api/team.api'

vi.mock('../../../src/renderer/i18n', () => ({ default: { t: (text: string) => text } }))
import {
  isElectron,
  isCapacitor,
  isRemoteClient,
  getRemoteServerUrl,
  setServerUrl,
  clearServerUrl,
  httpRequest,
} from '../../../src/renderer/api/transport'

// Track which globals a test installed so afterEach can remove them cleanly.
const installed = new Set<string>()

function setGlobal(key: string, value: unknown): void {
  installed.add(key)
  ;(globalThis as Record<string, unknown>)[key] = value
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  for (const key of installed) {
    delete (globalThis as Record<string, unknown>)[key]
  }
  installed.clear()
  // Reset the module's pending-URL singleton so tests don't leak state.
  clearServerUrl()
})

describe('work roster API routing', () => {
  it('uses the lightweight desktop bridge for the selected work', async () => {
    const response = { success: true, data: { members: [], roster: [] } }
    const invoke = vi.fn().mockResolvedValue(response)
    setGlobal('window', { halo: { teamEpochRoster: invoke } })
    expect(await teamApi.teamEpochRoster('team', 'work')).toBe(response)
    expect(invoke).toHaveBeenCalledWith({ teamId: 'team', epochId: 'work' })
  })

  it('uses the same scoped read remotely without fetching the full board', async () => {
    setGlobal('window', {})
    setGlobal('document', { baseURI: 'https://remote.example.com/halo/' })
    setGlobal('localStorage', { getItem: () => 'test-token' })
    const response = { success: true, data: { members: [], roster: [] } }
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(response)))
    expect(await teamApi.teamEpochRoster('team/x', 'work y')).toEqual(response)
    expect(fetchSpy).toHaveBeenCalledWith('https://remote.example.com/halo/api/teams/team%2Fx/epochs/work%20y/roster', {
      method: 'GET', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    })
  })
})

describe('Git repository API routing', () => {
  const operations = [
    { method: 'gitDiscoverRepository', route: 'discover-repository', field: 'filePath' },
    { method: 'gitOpenRepository', route: 'open-repository', field: 'repoRoot' },
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

describe('HTTP error responses', () => {
  it.each(['text/html', 'application/json'])('reports a %s chat 413 without mistaking HTML for JSON', async contentType => {
    setGlobal('window', {})
    setGlobal('document', { baseURI: 'http://remote.test/' })
    const response = new Response(contentType === 'text/html' ? '<html>Too large</html>' : '{"success":false,"code":"PAYLOAD_TOO_LARGE"}', {
      status: 413, headers: { 'Content-Type': contentType },
    })
    const json = vi.spyOn(response, 'json')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
    expect(await httpRequest('POST', '/api/agent/message', { images: [] })).toEqual({
      success: false, code: 'PAYLOAD_TOO_LARGE',
      error: 'Request is too large. Reduce the attachment size or shorten the text.',
    })
    expect(json).toHaveBeenCalledTimes(contentType === 'application/json' ? 1 : 0)
  })

  it('preserves other endpoints’ structured 413 errors', async () => {
    setGlobal('window', {})
    setGlobal('document', { baseURI: 'http://remote.test/' })
    const body = { success: false, code: 'TOO_LARGE', error: 'File too large' }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body, { status: 413 })))
    expect(await httpRequest('POST', '/api/other-import', {})).toEqual(body)
  })

  it('preserves successful responses and other JSON errors', async () => {
    setGlobal('window', {})
    setGlobal('document', { baseURI: 'http://remote.test/' })
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ success: true, data: { sent: true } }))
      .mockResolvedValueOnce(Response.json({ success: false, code: 'INVALID_JSON', error: 'Invalid JSON request body' }, { status: 400 }))
    vi.stubGlobal('fetch', fetch)
    expect(await httpRequest('POST', '/api/agent/message', { message: 'hello' })).toEqual({ success: true, data: { sent: true } })
    expect(await httpRequest('POST', '/api/agent/message', {})).toEqual({ success: false, code: 'INVALID_JSON', error: 'Invalid JSON request body' })
  })
})
