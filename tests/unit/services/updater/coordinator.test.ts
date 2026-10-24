/**
 * Updater service tests
 *
 * Covers the contracts that previously failed silently in production:
 * the pinned update channel, and the guarantee that an announced update always
 * reaches the user — as an install prompt, or as a download link if applying it
 * failed. A regression in either is invisible at runtime, so it is pinned here.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const UPDATE_URL = 'http://update.internal:18080'

type Handler = (...args: unknown[]) => void

function register(registry: Map<string, Handler[]>) {
  return vi.fn((event: string, handler: Handler) => {
    registry.set(event, [...(registry.get(event) ?? []), handler])
  })
}

const listeners = new Map<string, Handler[]>()
const nativeListeners = new Map<string, Handler[]>()

const autoUpdater = {
  logger: null as unknown,
  autoDownload: false,
  autoInstallOnAppQuit: false,
  setFeedURL: vi.fn(),
  checkForUpdates: vi.fn(async () => null),
  downloadUpdate: vi.fn(async () => []),
  quitAndInstall: vi.fn(),
  on: register(listeners)
}

/** Electron's own updater, which is Squirrel.Mac on macOS. */
const nativeUpdater = { on: register(nativeListeners) }

vi.mock('electron-updater', () => ({ default: { autoUpdater } }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0' },
  ipcMain: { handle: vi.fn() },
  powerMonitor: { on: vi.fn() },
  autoUpdater: nativeUpdater
}))

const send = vi.fn()
vi.mock('../../../../src/main/foundation/window.service', () => ({
  getMainWindow: () => ({ isDestroyed: () => false, webContents: { send } })
}))

let productConfig: { updateConfig?: { provider: string; url?: string } } = {
  updateConfig: { provider: 'generic', url: UPDATE_URL }
}
vi.mock('../../../../src/main/foundation/product-config', () => ({
  loadProductConfig: () => productConfig,
  getUpdateChannel: () => 'stable',
  // These tests run on a non-Windows host, so the staged path is out of scope
  // here and is covered by its own unit tests.
  getWindowsUpdateMode: () => 'legacy',
  getUpdateManifestPublicKey: () => undefined
}))

/** Statuses pushed to the renderer over the `updater:status` channel. */
function statuses(): Array<Record<string, unknown>> {
  return send.mock.calls
    .filter(([channel]) => channel === 'updater:status')
    .map(([, payload]) => payload as Record<string, unknown>)
}

function fire(registry: Map<string, Handler[]>, event: string, payload?: unknown): void {
  const handlers = registry.get(event)
  if (!handlers?.length) throw new Error(`updater never registered a "${event}" listener`)
  for (const handler of handlers) handler(payload)
}

const emit = (event: string, payload?: unknown) => fire(listeners, event, payload)
const emitNative = (event: string) => fire(nativeListeners, event)

async function initUpdater() {
  const module = await import('../../../../src/main/services/updater')
  module.initAutoUpdater()
  return module
}

const realPlatform = process.platform
function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

describe('updater coordinator', () => {
  beforeEach(async () => {
    // macOS behaves differently and has its own block below; everything else
    // runs as Linux so the outcome does not depend on the machine running it.
    setPlatform('linux')
    vi.useFakeTimers()
    vi.resetModules()
    listeners.clear()
    nativeListeners.clear()
    send.mockClear()
    autoUpdater.setFeedURL.mockClear()
    autoUpdater.checkForUpdates.mockClear()
    autoUpdater.downloadUpdate.mockClear()
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    productConfig = { updateConfig: { provider: 'generic', url: UPDATE_URL } }
  })

  afterEach(() => {
    vi.useRealTimers()
    setPlatform(realPlatform)
  })

  describe('feed configuration', () => {
    it('pins the channel to latest so the internal server can resolve it', async () => {
      await initUpdater()

      expect(autoUpdater.setFeedURL).toHaveBeenCalledWith({
        provider: 'generic',
        url: UPDATE_URL,
        channel: 'latest'
      })
    })

    it('stays disabled when no update url is configured', async () => {
      productConfig = { updateConfig: { provider: 'generic', url: '' } }
      await initUpdater()

      expect(autoUpdater.setFeedURL).not.toHaveBeenCalled()
      expect(listeners.size).toBe(0)
    })

    it('downloads in the background on every platform', async () => {
      await initUpdater()

      expect(autoUpdater.autoDownload).toBe(true)
      expect(autoUpdater.autoInstallOnAppQuit).toBe(true)
    })
  })

  describe('update lifecycle', () => {
    it('reports progress and then how the update will be applied', async () => {
      await initUpdater()

      emit('update-available', { version: '9.9.9', releaseNotes: '- notes' })
      emit('download-progress', { percent: 42, bytesPerSecond: 1, transferred: 1, total: 2 })
      emit('update-downloaded', { version: '9.9.9', releaseNotes: '- notes' })

      const [available, downloading, downloaded] = statuses()
      expect(available).toMatchObject({ status: 'available', version: '9.9.9' })
      expect(downloading).toMatchObject({ status: 'downloading', percent: 42 })
      expect(downloaded).toMatchObject({ status: 'downloaded', version: '9.9.9', installMode: 'restart' })
      // Electron's own updater is Squirrel, which exists only on macOS and Windows.
      expect(nativeListeners.size).toBe(0)
    })

    it('records the restart click with the version it applies', async () => {
      const module = await initUpdater()
      emit('update-available', { version: '9.9.9' })
      emit('update-downloaded', { version: '9.9.9' })
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

      module.quitAndInstall()

      expect(log).toHaveBeenCalledWith(expect.stringContaining('9.9.9'))
      log.mockRestore()
    })

    it('falls back to the download page when an announced update fails', async () => {
      await initUpdater()

      emit('update-available', { version: '9.9.9', releaseNotes: '- notes' })
      send.mockClear()
      emit('error', new Error('ENOENT: app-update.yml'))

      expect(statuses()).toEqual([
        expect.objectContaining({
          status: 'manual-download',
          version: '9.9.9',
          downloadUrl: UPDATE_URL
        })
      ])
    })

    it('reports a plain error when the check itself fails', async () => {
      await initUpdater()

      emit('error', new Error('getaddrinfo ENOTFOUND'))

      expect(statuses()).toEqual([
        expect.objectContaining({ status: 'error', message: 'getaddrinfo ENOTFOUND' })
      ])
    })

    it('falls back to the download page when applying a downloaded update fails', async () => {
      const module = await initUpdater()

      emit('update-available', { version: '9.9.9', releaseNotes: '- notes' })
      emit('update-downloaded', { version: '9.9.9', releaseNotes: '- notes' })
      module.quitAndInstall()
      send.mockClear()
      emit('error', new Error('Could not get code signature for running application'))

      expect(statuses()).toEqual([
        expect.objectContaining({
          status: 'manual-download',
          version: '9.9.9',
          downloadUrl: UPDATE_URL
        })
      ])
    })

    it('does not reuse a resolved update for a later unrelated failure', async () => {
      await initUpdater()

      emit('update-available', { version: '9.9.9', releaseNotes: '- notes' })
      emit('update-downloaded', { version: '9.9.9', releaseNotes: '- notes' })
      send.mockClear()
      emit('error', new Error('later network blip'))

      expect(statuses()).toEqual([expect.objectContaining({ status: 'error' })])
    })
  })

  describe('mandatory releases', () => {
    it('carries the feed flag to the install prompt', async () => {
      await initUpdater()

      emit('update-available', { version: '9.9.9', mandatory: true })
      emit('update-downloaded', { version: '9.9.9', mandatory: true })

      expect(statuses().at(-1)).toMatchObject({ status: 'downloaded', mandatory: true })
    })

    it('keeps the flag on the manual-download fallback', async () => {
      await initUpdater()

      emit('update-available', { version: '9.9.9', mandatory: true })
      send.mockClear()
      emit('error', new Error('staging failed'))

      expect(statuses()).toEqual([
        expect.objectContaining({ status: 'manual-download', mandatory: true })
      ])
    })

    it('treats anything but a literal true as deferrable', async () => {
      await initUpdater()

      emit('update-downloaded', { version: '9.9.9', mandatory: 'true' })

      expect(statuses().at(-1)).toMatchObject({ status: 'downloaded', mandatory: false })
    })

    it('leaves an unmarked release deferrable', async () => {
      await initUpdater()

      emit('update-downloaded', { version: '9.9.9' })

      expect(statuses().at(-1)).toMatchObject({ status: 'downloaded', mandatory: false })
    })
  })

  describe('manual check', () => {
    it('keeps background downloading enabled', async () => {
      const module = await initUpdater()

      await module.manualCheckForUpdates()

      expect(autoUpdater.checkForUpdates).toHaveBeenCalled()
      expect(autoUpdater.autoDownload).toBe(true)
    })

    it('surfaces nothing extra when the check rejects — the error event owns that', async () => {
      const module = await initUpdater()
      autoUpdater.checkForUpdates.mockRejectedValueOnce(new Error('offline'))

      await expect(module.manualCheckForUpdates()).resolves.toBeUndefined()
      expect(statuses()).toEqual([])
    })
  })

  // electron-updater reports "downloaded" when its own download finishes, but
  // on macOS Squirrel.Mac still has to verify the update before it can be
  // installed. A restart offered before that check could do nothing at all.
  describe('macOS', () => {
    beforeEach(() => setPlatform('darwin'))

    function downloadRelease(version: string): void {
      emit('update-available', { version, releaseNotes: '- notes' })
      emit('update-downloaded', { version, releaseNotes: '- notes' })
    }

    /** Takes a release to where Squirrel.Mac holds it, ready to install. */
    async function holdVerifiedUpdate(version = '9.9.9') {
      const module = await initUpdater()
      downloadRelease(version)
      emitNative('update-downloaded')
      send.mockClear()
      return module
    }

    it('offers the restart only once macOS has verified the update', async () => {
      await initUpdater()
      downloadRelease('9.9.9')

      expect(statuses().at(-1)).toMatchObject({ status: 'staging', version: '9.9.9' })
      expect(statuses().some((s) => s.status === 'downloaded')).toBe(false)

      emitNative('update-downloaded')

      expect(statuses().at(-1)).toMatchObject({
        status: 'downloaded',
        version: '9.9.9',
        releaseNotes: '- notes',
        installMode: 'restart',
        mandatory: false
      })
    })

    it('offers the download page when macOS rejects the update', async () => {
      await initUpdater()
      downloadRelease('9.9.9')
      send.mockClear()

      // What Squirrel.Mac reports for an update signed differently from the
      // running app — every update, for a locally built (ad-hoc signed) app.
      emit('error', new Error('Code signature at URL file:///tmp/Halo.app/ did not pass validation'))

      expect(statuses()).toEqual([
        expect.objectContaining({ status: 'manual-download', version: '9.9.9', downloadUrl: UPDATE_URL })
      ])
    })

    it('leaves a check to the verification already running', async () => {
      const module = await initUpdater()
      downloadRelease('9.9.9')
      autoUpdater.checkForUpdates.mockClear()

      await module.manualCheckForUpdates()

      expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled()
    })

    it('repeats the prompt for a verified update instead of handing it to macOS again', async () => {
      const module = await holdVerifiedUpdate()
      let autoDownloadDuringCheck: boolean | undefined
      autoUpdater.checkForUpdates.mockImplementationOnce(async () => {
        autoDownloadDuringCheck = autoUpdater.autoDownload
        return null
      })

      await module.manualCheckForUpdates()
      emit('update-available', { version: '9.9.9', releaseNotes: '- notes' })

      expect(autoDownloadDuringCheck).toBe(false)
      expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled()
      expect(statuses()).toEqual([
        expect.objectContaining({ status: 'downloaded', version: '9.9.9', installMode: 'restart' })
      ])
    })

    it('still picks up a mandatory flag added after the user deferred', async () => {
      const module = await holdVerifiedUpdate()

      await module.manualCheckForUpdates()
      emit('update-available', { version: '9.9.9', mandatory: true })

      expect(statuses().at(-1)).toMatchObject({ status: 'downloaded', version: '9.9.9', mandatory: true })
    })

    it('replaces a held update when a newer release appears', async () => {
      const module = await holdVerifiedUpdate('9.9.9')

      await module.manualCheckForUpdates()
      emit('update-available', { version: '10.0.0' })

      expect(statuses().at(-1)).toMatchObject({ status: 'available', version: '10.0.0' })
      expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1)

      emit('update-downloaded', { version: '10.0.0' })
      emitNative('update-downloaded')

      expect(statuses().at(-1)).toMatchObject({ status: 'downloaded', version: '10.0.0' })
    })

    it('downloads in the background again for the next check after a rejection', async () => {
      const module = await initUpdater()
      downloadRelease('9.9.9')
      emit('error', new Error('did not pass validation'))

      await module.manualCheckForUpdates()

      expect(autoUpdater.checkForUpdates).toHaveBeenCalled()
      expect(autoUpdater.autoDownload).toBe(true)
    })
  })
})
