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
  })
}

vi.mock('electron-updater', () => ({ default: { autoUpdater } }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

const send = vi.fn()
vi.mock('../../../src/main/foundation/window.service', () => ({
  getMainWindow: () => ({ isDestroyed: () => false, webContents: { send } })
}))

let productConfig: { updateConfig?: { provider: string; url?: string } } = {
  updateConfig: { provider: 'generic', url: UPDATE_URL }
}
vi.mock('../../../src/main/foundation/product-config', () => ({
  loadProductConfig: () => productConfig
}))

/** Statuses pushed to the renderer over the `updater:status` channel. */
function statuses(): Array<Record<string, unknown>> {
  return send.mock.calls
    .filter(([channel]) => channel === 'updater:status')
    .map(([, payload]) => payload as Record<string, unknown>)
}

function emit(event: string, payload?: unknown): void {
  const handler = listeners.get(event)
  if (!handler) throw new Error(`updater never registered a "${event}" listener`)
  handler(payload)
}

async function initUpdater() {
  const module = await import('../../../src/main/services/updater.service')
  module.initAutoUpdater()
  return module
}

describe('updater.service', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    vi.resetModules()
    listeners.clear()
    send.mockClear()
    autoUpdater.setFeedURL.mockClear()
    autoUpdater.checkForUpdates.mockClear()
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    productConfig = { updateConfig: { provider: 'generic', url: UPDATE_URL } }
  })

  afterEach(() => {
    vi.useRealTimers()
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
      expect(downloaded).toMatchObject({ status: 'downloaded', version: '9.9.9' })
      expect(downloaded.installMode).toBe(process.platform === 'win32' ? 'installer' : 'restart')
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

    it('does not reuse a resolved update for a later unrelated failure', async () => {
      await initUpdater()

      emit('update-available', { version: '9.9.9', releaseNotes: '- notes' })
      emit('update-downloaded', { version: '9.9.9', releaseNotes: '- notes' })
      send.mockClear()
      emit('error', new Error('later network blip'))

      expect(statuses()).toEqual([expect.objectContaining({ status: 'error' })])
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
})
