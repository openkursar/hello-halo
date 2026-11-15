import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from 'electron'
import { chromiumUserAgent, configureChromiumIdentity } from '../../../src/main/foundation/chromium-user-agent'

const runtime = vi.hoisted(() => ({ userAgentFallback: '' }))
vi.mock('electron', () => ({ app: runtime }))

import { configureBrowserSession, H5_USER_AGENT, resolveUserAgent } from '../../../src/main/services/user-agent-resolver'

const native = (platform: string, version: string) =>
  `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) halo/3.2.0 Chrome/${version} Electron/43.7.7 Safari/537.36`

beforeEach(() => { runtime.userAgentFallback = native('Macintosh; Intel Mac OS X 10_15_7', '150.0.7871.250') })

describe('native Chromium identity', () => {
  it.each([
    ['Macintosh; Intel Mac OS X 10_15_7', '150.0.7871.250'],
    ['Windows NT 10.0; Win64; x64', '151.0.1234.56'],
    ['X11; Linux x86_64', '152.0.9876.54'],
    ['X11; Linux aarch64', '153.0.1111.22'],
  ])('retains the actual platform %s and version %s', (platform, version) => {
    expect(chromiumUserAgent(native(platform, version))).toBe(
      `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`
    )
  })

  it('removes embedding-product names without changing the native platform comment', () => {
    expect(chromiumUserAgent(native('X11; Linux x86_64', '155.0.0.0').replace('halo/3.2.0', 'Halo-Enterprise/3.2.0')))
      .toBe('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36')
  })

  it.each([undefined, '', '   \t  '])('uses the current native identity when custom is %s', custom => {
    expect(resolveUserAgent(custom, 'pc')).toBe(chromiumUserAgent(runtime.userAgentFallback))
    runtime.userAgentFallback = native('Windows NT 10.0; Win64; x64', '160.0.7777.12')
    expect(resolveUserAgent(custom, 'pc')).toContain('Chrome/160.0.7777.12')
    expect(resolveUserAgent(custom, 'pc')).toContain('Windows NT 10.0')
  })

  it.each(['pc', 'h5'] as const)('preserves explicit custom identity in %s mode', mode => {
    expect(resolveUserAgent('  My test browser/1.0  ', mode)).toBe('My test browser/1.0')
  })

  it('keeps mobile emulation opt-in and restores native desktop identity', () => {
    expect(resolveUserAgent(undefined, 'h5')).toBe(H5_USER_AGENT)
    expect(resolveUserAgent(undefined, 'pc')).not.toContain('iPhone')
    expect(resolveUserAgent(undefined, 'pc', native('X11; Linux x86_64', '154.0.0.0'))).toContain('Chrome/154.0.0.0')
  })

  it('initializes the native fallback without applying a custom browser identity globally', () => {
    const expected = chromiumUserAgent(runtime.userAgentFallback)
    expect(configureChromiumIdentity()).toBe(expected)
    expect(runtime.userAgentFallback).toBe(expected)
    const browserSession = { getUserAgent: () => expected, setUserAgent: vi.fn() }
    configureBrowserSession(browserSession as unknown as Session, 'Custom/1')
    expect(browserSession.setUserAgent).toHaveBeenCalledWith('Custom/1')
    expect(runtime.userAgentFallback).toBe(expected)
  })

  it('explicitly initializes a native session even when its fallback already reads as clean', () => {
    const expected = chromiumUserAgent(runtime.userAgentFallback)
    const browserSession = { getUserAgent: () => expected, setUserAgent: vi.fn() }
    configureBrowserSession(browserSession as unknown as Session, undefined)
    configureBrowserSession(browserSession as unknown as Session, undefined)
    expect(browserSession.setUserAgent).toHaveBeenCalledTimes(1)
    expect(browserSession.setUserAgent).toHaveBeenCalledWith(expected)
  })

  it('applies the session identity once and can restore it after a custom override', () => {
    let userAgent = runtime.userAgentFallback
    const browserSession = {
      getUserAgent: () => userAgent,
      setUserAgent: vi.fn((value: string) => { userAgent = value }),
    }
    configureBrowserSession(browserSession as unknown as Session, undefined)
    configureBrowserSession(browserSession as unknown as Session, undefined)
    expect(browserSession.setUserAgent).toHaveBeenCalledTimes(1)
    expect(userAgent).toBe(chromiumUserAgent(runtime.userAgentFallback))
    configureBrowserSession(browserSession as unknown as Session, 'Custom/1')
    expect(userAgent).toBe('Custom/1')
    configureBrowserSession(browserSession as unknown as Session, '')
    expect(userAgent).toBe(chromiumUserAgent(runtime.userAgentFallback))
  })
})
