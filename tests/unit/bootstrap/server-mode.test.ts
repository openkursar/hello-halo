/**
 * server-mode unit tests.
 *
 * Covers installServerSignalHandlers (SIGTERM/SIGINT must route to app.quit()
 * via one-shot process handlers) and assertDisplayAvailable (boot must refuse a
 * display setup in which the first AI browser window would crash the process).
 * Heavy sibling imports (service bootstrap, remote access) are mocked so
 * importing the module is side-effect free.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { app as electronApp, type App } from 'electron'
import { existsSync } from 'fs'

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, existsSync: vi.fn(actual.existsSync) }
})

vi.mock('../../../src/main/bootstrap/index', () => ({
  initializeEssentialServices: vi.fn(),
  initializeExtendedServices: vi.fn(),
}))

vi.mock('../../../src/main/services/remote', () => ({
  enableRemoteAccess: vi.fn(async () => ({ server: { port: 8080, token: '' } })),
}))

vi.mock('../../../src/main/ipc/browser-host', () => ({
  registerBrowserHostHandlers: vi.fn(),
}))

vi.mock('../../../src/main/services/analytics', () => ({
  initAnalytics: vi.fn(async () => {}),
}))

vi.mock('../../../src/main/foundation/env-config', () => ({
  applyEnvConfig: vi.fn(),
}))

import { assertDisplayAvailable, bootServerMode, installServerSignalHandlers } from '../../../src/main/bootstrap/server-mode'
import { initAnalytics } from '../../../src/main/services/analytics'
import { enableRemoteAccess } from '../../../src/main/services/remote'

function makeApp(): { app: App; quit: ReturnType<typeof vi.fn> } {
  const quit = vi.fn()
  return { app: { quit } as unknown as App, quit }
}

describe('server-mode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('maps SIGTERM to app.quit via a one-shot handler', () => {
    const handlers: Record<string, () => void> = {}
    const onceSpy = vi.spyOn(process, 'once').mockImplementation(((sig: string, fn: () => void) => {
      handlers[sig] = fn
      return process
    }) as never)

    const { app, quit } = makeApp()
    installServerSignalHandlers(app)

    expect(onceSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function))
    handlers.SIGTERM()
    expect(quit).toHaveBeenCalledTimes(1)

    onceSpy.mockRestore()
  })

  it('maps SIGINT to app.quit via a one-shot handler', () => {
    const handlers: Record<string, () => void> = {}
    const onceSpy = vi.spyOn(process, 'once').mockImplementation(((sig: string, fn: () => void) => {
      handlers[sig] = fn
      return process
    }) as never)

    const { app, quit } = makeApp()
    installServerSignalHandlers(app)

    expect(onceSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function))
    handlers.SIGINT()
    expect(quit).toHaveBeenCalledTimes(1)

    onceSpy.mockRestore()
  })

  it('starts analytics on the headless boot without waiting for it', async () => {
    // A backend that never answers must not keep the server from listening.
    vi.mocked(initAnalytics).mockReturnValueOnce(new Promise(() => {}))
    ;(electronApp as unknown as { commandLine: unknown }).commandLine = {
      getSwitchValue: (name: string) => (name === 'ozone-platform' ? 'x11' : ''),
    }
    vi.mocked(existsSync).mockReturnValue(true)
    vi.stubEnv('DISPLAY', ':99')

    await bootServerMode()
    vi.unstubAllEnvs()

    expect(initAnalytics).toHaveBeenCalledTimes(1)
    expect(enableRemoteAccess).toHaveBeenCalledWith(8080)
  })
})

describe('assertDisplayAvailable', () => {
  let ozonePlatform: string
  const exists = vi.mocked(existsSync)

  beforeEach(() => {
    ozonePlatform = 'x11'
    // The shared electron mock has no commandLine; the check reads the real one.
    ;(electronApp as unknown as { commandLine: unknown }).commandLine = {
      getSwitchValue: (name: string) => (name === 'ozone-platform' ? ozonePlatform : ''),
    }
    exists.mockReset().mockReturnValue(true)
    vi.stubEnv('DISPLAY', ':99')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('passes with x11 and a live local X socket', () => {
    expect(() => assertDisplayAvailable('linux')).not.toThrow()
    expect(exists).toHaveBeenCalledWith('/tmp/.X11-unix/X99')
  })

  it('refuses the headless Ozone platform', () => {
    ozonePlatform = 'headless'
    expect(() => assertDisplayAvailable('linux')).toThrow(/ozone-platform=headless/)
  })

  it('refuses to boot without DISPLAY', () => {
    vi.stubEnv('DISPLAY', '')
    expect(() => assertDisplayAvailable('linux')).toThrow(/DISPLAY is not set/)
  })

  it('refuses a local display with no X server socket', () => {
    vi.stubEnv('DISPLAY', ':99.0')
    exists.mockReturnValue(false)
    expect(() => assertDisplayAvailable('linux')).toThrow(/X99 does not exist/)
  })

  it('leaves a remote display to Chromium', () => {
    vi.stubEnv('DISPLAY', 'xserver.example:0')
    exists.mockReturnValue(false)
    expect(() => assertDisplayAvailable('linux')).not.toThrow()
    expect(exists).not.toHaveBeenCalled()
  })
})
