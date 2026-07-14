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

vi.mock('../../../src/main/services/remote.service', () => ({
  enableRemoteAccess: vi.fn(),
}))

vi.mock('../../../src/main/foundation/env-config', () => ({
  applyEnvConfig: vi.fn(),
}))

import { installServerSignalHandlers } from '../../../src/main/bootstrap/server-mode'

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
})
