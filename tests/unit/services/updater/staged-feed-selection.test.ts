/**
 * Which feed a staged Windows build follows.
 *
 * GitHub builds used to be unable to take the staged path at all — it asked for
 * a release-server URL they do not have — so every Windows user of those builds
 * stayed on the installer path however the build was configured.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const autoUpdater = {
  logger: null as unknown,
  autoDownload: false,
  autoInstallOnAppQuit: false,
  setFeedURL: vi.fn(),
  checkForUpdates: vi.fn(async () => null),
  quitAndInstall: vi.fn(),
  on: vi.fn(),
}
vi.mock('electron-updater', () => ({ default: { autoUpdater } }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('../../../../src/main/foundation/window.service', () => ({
  getMainWindow: () => ({ isDestroyed: () => false, webContents: { send: vi.fn() } }),
}))

let updateConfig: Record<string, unknown> = {}
let channel = 'stable'
let windowsMode = 'staged'
vi.mock('../../../../src/main/foundation/product-config', () => ({
  loadProductConfig: () => ({ updateConfig }),
  getUpdateChannel: () => channel,
  getWindowsUpdateMode: () => windowsMode,
  getUpdateManifestPublicKey: () => 'a-key',
}))

const checkForStagedUpdate = vi.fn(async (_feed: unknown) => null)
vi.mock('../../../../src/main/services/updater/staged', () => ({
  checkForStagedUpdate: (feed: unknown) => checkForStagedUpdate(feed),
  prepareStagedUpdate: vi.fn(),
  applyStagedUpdate: vi.fn(),
  discardStagedUpdate: vi.fn(async () => undefined),
  reconcileStagedUpdateOnStartup: vi.fn(async () => undefined),
}))

const GITHUB = { provider: 'github', owner: 'openkursar', repo: 'hello-halo' }
const realPlatform = process.platform

async function checkOnce(): Promise<void> {
  const updater = await import('../../../../src/main/services/updater')
  updater.initAutoUpdater()
  await updater.manualCheckForUpdates()
}

describe('staged feed selection', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    vi.resetModules()
    checkForStagedUpdate.mockClear()
    autoUpdater.checkForUpdates.mockClear()
    updateConfig = GITHUB
    channel = 'stable'
    windowsMode = 'staged'
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
  })

  it('leaves a Windows build without staged updates exactly on the installer path', async () => {
    // What every build gets unless product.json opts in (an unset mode, or
    // staged without a public key, both resolve to legacy).
    windowsMode = 'legacy'
    await checkOnce()

    expect(checkForStagedUpdate).not.toHaveBeenCalled()
    expect(autoUpdater.checkForUpdates).toHaveBeenCalled()
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true)
  })

  it('reads a GitHub stable build from its repository', async () => {
    await checkOnce()

    expect(checkForStagedUpdate).toHaveBeenCalledWith({ kind: 'github', owner: 'openkursar', repo: 'hello-halo' })
    // electron-updater stays the fallback, but must not install on quit.
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false)
  })

  it('keeps a GitHub preview build on the installer path', async () => {
    channel = 'experience'
    await checkOnce()

    // "Latest release" never points at a prerelease, where preview builds live.
    expect(checkForStagedUpdate).not.toHaveBeenCalled()
    expect(autoUpdater.checkForUpdates).toHaveBeenCalled()
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true)
  })

  it('reads a release-server build from that server', async () => {
    updateConfig = { provider: 'generic', url: 'http://updates.example:18080' }
    channel = 'experience'
    await checkOnce()

    expect(checkForStagedUpdate).toHaveBeenCalledWith({ kind: 'generic', url: 'http://updates.example:18080' })
  })
})
