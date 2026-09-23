/**
 * When the staged path declines, the check must still reach a conclusion.
 *
 * Declining is the ordinary case, not an error: already up to date, nothing
 * published for this platform, helper unavailable. The check then falls
 * through to electron-updater — but its event handlers were gated on whether
 * the staged path was *configured*, which muted them for the fallback too. The
 * check completed and the user was left watching "checking" forever.
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

/** The staged path declines every check in these tests. */
const checkForStagedUpdate = vi.fn(async () => null)
vi.mock('../../../../src/main/services/updater/staged', () => ({
  checkForStagedUpdate: (...args: unknown[]) => checkForStagedUpdate(...(args as [])),
  prepareStagedUpdate: vi.fn(),
  applyStagedUpdate: vi.fn(),
  discardStagedUpdate: vi.fn(async () => undefined),
  reconcileStagedUpdateOnStartup: vi.fn(async () => undefined),
}))

function statuses(): Array<Record<string, unknown>> {
  return send.mock.calls
    .filter(([channel]) => channel === 'updater:status')
    .map(([, payload]) => payload as Record<string, unknown>)
}

const realPlatform = process.platform

describe('staged path declines', () => {
  beforeEach(async () => {
    // The staged path only exists on Windows; these tests are about what
    // happens there, so the platform has to say so.
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    vi.resetModules()
    listeners.clear()
    send.mockClear()
    autoUpdater.checkForUpdates.mockClear()
    checkForStagedUpdate.mockClear()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
  })

  it('still lets electron-updater report the outcome', async () => {
    const updater = await import('../../../../src/main/services/updater')
    updater.initAutoUpdater()

    await updater.manualCheckForUpdates()

    // The staged path was asked, and passed.
    expect(checkForStagedUpdate).toHaveBeenCalled()
    expect(autoUpdater.checkForUpdates).toHaveBeenCalled()

    // Whatever electron-updater then finds must reach the renderer; before the
    // fix this event was swallowed and the UI never left 'checking'.
    listeners.get('update-not-available')?.({ version: '2.1.16' })

    const seen = statuses().map((s) => s.status)
    expect(seen).toContain('checking')
    expect(seen).toContain('not-available')
  })

  it('reports an available update found by the fallback', async () => {
    const updater = await import('../../../../src/main/services/updater')
    updater.initAutoUpdater()
    await updater.manualCheckForUpdates()

    listeners.get('update-downloaded')?.({ version: '2.1.17', releaseNotes: null })

    const downloaded = statuses().find((s) => s.status === 'downloaded')
    expect(downloaded, 'a fallback download must still prompt the user').toBeDefined()
    // Windows without the staged path applies through the installer, and the
    // prompt has to say so rather than promising a quick restart.
    expect(downloaded?.installMode).toBe('installer')
  })
})
