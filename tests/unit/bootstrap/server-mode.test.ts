/**
 * server-mode unit tests.
 *
 * Focuses on installServerSignalHandlers: SIGTERM/SIGINT must route to
 * app.quit() via one-shot process handlers. Heavy sibling imports (service
 * bootstrap, remote access) are mocked so importing the module is side-effect free.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { App } from 'electron'

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

import { bootServerMode, installServerSignalHandlers } from '../../../src/main/bootstrap/server-mode'
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

    await bootServerMode()

    expect(initAnalytics).toHaveBeenCalledTimes(1)
    expect(enableRemoteAccess).toHaveBeenCalledWith(8080)
  })
})
