/**
 * A version that already failed to start here must not be offered again.
 *
 * The drill that prompted this showed the loop: the broken release rolled back
 * correctly, and forty seconds later the app downloaded and staged the very
 * same release. Nothing about that cycle ever ends on its own.
 *
 * It must also not reach the installer fallback — that path has no rollback,
 * so it would leave the user on a version that cannot start.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const UPDATE_URL = 'http://update.internal:18085'
const listeners = new Map<string, (...args: unknown[]) => void>()
const autoUpdater = {
  logger: null as unknown,
  autoDownload: false,
  autoInstallOnAppQuit: false,
  setFeedURL: vi.fn(),
  checkForUpdates: vi.fn(async () => null),
  quitAndInstall: vi.fn(),
  on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    listeners.set(event, handler)
  }),
}
vi.mock('electron-updater', () => ({ default: { autoUpdater } }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

const send = vi.fn()
vi.mock('../../../../src/main/foundation/window.service', () => ({
  getMainWindow: () => ({ isDestroyed: () => false, webContents: { send } }),
}))
vi.mock('../../../../src/main/foundation/product-config', () => ({
  loadProductConfig: () => ({ updateConfig: { provider: 'generic', url: UPDATE_URL } }),
  getUpdateChannel: () => 'experience',
  getWindowsUpdateMode: () => 'staged',
  getUpdateManifestPublicKey: () => 'a-key',
}))

class VersionKnownBadError extends Error {
  readonly version: string
  constructor(version: string) {
    super(version)
    this.name = 'VersionKnownBadError'
    this.version = version
  }
}
const checkForStagedUpdate = vi.fn(async () => {
  throw new VersionKnownBadError('2.1.18')
})
vi.mock('../../../../src/main/services/updater/staged', () => ({
  VersionKnownBadError,
  checkForStagedUpdate: () => checkForStagedUpdate(),
  prepareStagedUpdate: vi.fn(),
  applyStagedUpdate: vi.fn(),
  discardStagedUpdate: vi.fn(async () => undefined),
  reconcileStagedUpdateOnStartup: vi.fn(async () => undefined),
}))

const realPlatform = process.platform

describe('a version that already failed here', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    vi.resetModules()
    listeners.clear()
    send.mockClear()
    autoUpdater.checkForUpdates.mockClear()
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
  })

  it('is not retried, and is not pushed through the installer either', async () => {
    const updater = await import('../../../../src/main/services/updater')
    updater.initAutoUpdater()
    await updater.manualCheckForUpdates()

    // The installer path must stay out of it; it cannot roll back.
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()

    const statuses = send.mock.calls
      .filter(([channel]) => channel === 'updater:status')
      .map(([, payload]) => (payload as { status: string }).status)
    expect(statuses).toContain('not-available')
  })
})
