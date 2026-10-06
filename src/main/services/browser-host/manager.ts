import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { BrowserWindow, type WebContents, type WebPreferences } from 'electron'
import { isServerMode } from '../../foundation/runtime-mode'
import type { BrowserHostBounds, BrowserHostCommand, BrowserHostFailure, BrowserHostPage, BrowserHostFrameReady } from '../../../shared/types/browser-host'

const ATTACH_TIMEOUT_MS = 15000
const DEFAULT_BOUNDS: BrowserHostBounds = { x: 0, y: 0, width: 1280, height: 720 }

interface PageRecord {
  page: BrowserHostPage
  host: BrowserWindow
  contents: WebContents | null
  promise: Promise<WebContents>
  resolve: (contents: WebContents) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  attached: boolean
  frameLease?: { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout; release: () => void; acknowledged: boolean }
}

interface HostRecord {
  window: BrowserWindow
  ready: boolean
  recovering: boolean
  leases: number
  throttling?: boolean
}

/** Owns guest attachment; navigation and business state belong to the browser manager. */
class BrowserHostManager {
  private mainWindow: BrowserWindow | null = null
  private hiddenWindow: BrowserWindow | null = null
  private hosts = new Map<number, HostRecord>()
  private pages = new Map<string, PageRecord>()
  private tokens = new Map<string, PageRecord>()
  private attachingGuests = new Map<number, { contents: WebContents; host: BrowserWindow; timer: NodeJS.Timeout }>()
  private stateTimer: NodeJS.Timeout | null = null

  initialize(window: BrowserWindow): void {
    this.mainWindow = window
    this.registerHost(window)
  }

  private registerHost(window: BrowserWindow): void {
    const contents = window.webContents
    if (this.hosts.has(contents.id)) return
    this.hosts.set(contents.id, { window, ready: false, recovering: false, leases: 0 })

    contents.on('will-attach-webview', (event, preferences, params) => {
      const token = this.tokenFromSource(params.src)
      const record = token ? this.tokens.get(token) : undefined
      if (!record || record.host !== window || record.attached || params.partition !== 'persist:browser') {
        event.preventDefault()
        console.warn('[BrowserHost] Rejected unauthorized guest attachment', { hostId: contents.id })
        return
      }
      record.attached = true
      this.securePreferences(preferences, record)
    })

    contents.on('did-attach-webview', (_event, guest) => {
      const timer = setTimeout(() => {
        this.attachingGuests.delete(guest.id)
        if (!guest.isDestroyed()) {
          console.warn('[BrowserHost] Closing guest without an initial document', { hostId: contents.id, guestId: guest.id })
          guest.close({ waitForBeforeUnload: false })
        }
      }, ATTACH_TIMEOUT_MS)
      this.attachingGuests.set(guest.id, { contents: guest, host: window, timer })
      const accept = () => {
        clearTimeout(timer)
        this.attachingGuests.delete(guest.id)
        const token = this.tokenFromSource(guest.getURL())
        const record = token ? this.tokens.get(token) : undefined
        if (!record || record.host !== window || record.contents) {
          console.warn('[BrowserHost] Closing unrecognized attached guest', { hostId: contents.id, guestId: guest.id })
          guest.close({ waitForBeforeUnload: false })
          return
        }
        record.contents = guest
        guest.once('destroyed', () => this.releaseRecord(record, new Error('Browser guest was destroyed')))
        guest.on('render-process-gone', (_event, details) => {
          if (this.pages.get(record.page.id) !== record) return
          console.warn('[BrowserHost] Guest process lost', { pageId: record.page.id, reason: details.reason })
        })
        clearTimeout(record.timer)
        record.resolve(guest)
      }
      guest.once('dom-ready', accept)
      guest.once('destroyed', () => {
        clearTimeout(timer)
        this.attachingGuests.delete(guest.id)
      })
    })

    contents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (!isMainFrame || isInPlace || !this.hosts.get(contents.id)?.ready) return
      this.resetHost(contents, 'Host navigated')
    })
    contents.on('render-process-gone', (_event, details) => this.resetHost(contents, `Host process lost: ${details.reason}`))
    window.once('closed', () => {
      this.resetHost(contents, 'Host closed')
      this.hosts.delete(contents.id)
      if (this.hiddenWindow === window) this.hiddenWindow = null
      if (this.mainWindow === window) this.mainWindow = null
    })
  }

  private securePreferences(preferences: WebPreferences, record: PageRecord): void {
    delete preferences.preload
    Object.assign(preferences, {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
      plugins: true,
      partition: 'persist:browser',
      scrollBounce: true,
      zoomFactor: 1,
      transparent: false,
      backgroundThrottling: record.host !== this.hiddenWindow,
    })
  }

  private tokenFromSource(source: unknown): string | null {
    if (typeof source !== 'string' || !source.startsWith('about:blank#halo-browser-')) return null
    return source.slice('about:blank#halo-browser-'.length)
  }

  private getHiddenWindow(): BrowserWindow {
    if (this.hiddenWindow && !this.hiddenWindow.isDestroyed()) return this.hiddenWindow
    const window = new BrowserWindow({
      show: false,
      width: DEFAULT_BOUNDS.width,
      height: DEFAULT_BOUNDS.height,
      skipTaskbar: true,
      webPreferences: {
        preload: join(__dirname, '../preload/browser-host.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: true,
        backgroundThrottling: false,
      },
    })
    this.hiddenWindow = window
    this.registerHost(window)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const load = process.env.ELECTRON_RENDERER_URL
      ? window.loadURL(`${process.env.ELECTRON_RENDERER_URL}/browser-host.html`)
      : window.loadFile(join(__dirname, '../renderer/browser-host.html'))
    void load.catch(error => {
      console.error('[BrowserHost] Hidden host failed to load', error)
      this.resetHost(window.webContents, 'Hidden host failed to load')
      if (!window.isDestroyed()) window.destroy()
    })
    return window
  }

  create(id: string, background: boolean): Promise<WebContents> {
    const existing = this.pages.get(id)
    if (existing) return existing.promise
    const backgroundHost = background || isServerMode()
    const host = backgroundHost ? this.getHiddenWindow() : this.mainWindow
    if (!host || host.isDestroyed()) {
      console.warn('[BrowserHost] Page creation refused: host unavailable', { pageId: id, background: backgroundHost })
      return Promise.reject(new Error('Browser host is unavailable'))
    }
    if (this.hosts.get(host.webContents.id)?.recovering) {
      console.warn('[BrowserHost] Page creation refused during host recovery', { pageId: id, background: backgroundHost })
      return Promise.reject(new Error('Browser host is restarting'))
    }
    const token = randomUUID()
    let resolve!: (contents: WebContents) => void
    let reject!: (error: Error) => void
    const promise = new Promise<WebContents>((accept, fail) => { resolve = accept; reject = fail })
    const record: PageRecord = {
      page: { id, token, src: `about:blank#halo-browser-${token}`, bounds: { ...DEFAULT_BOUNDS }, visible: false },
      host,
      contents: null,
      promise,
      resolve,
      reject,
      attached: false,
      timer: setTimeout(() => {
        console.warn('[BrowserHost] Guest attachment timed out', { pageId: id, hostId: host.webContents.id })
        this.releaseRecord(record, new Error('Browser guest attachment timed out'))
      }, ATTACH_TIMEOUT_MS),
    }
    this.pages.set(id, record)
    this.tokens.set(token, record)
    this.startStateReporting()
    this.send(record, { type: 'upsert', page: this.snapshot(record) })
    return promise
  }

  ready(sender: WebContents): BrowserHostPage[] {
    const host = this.hosts.get(sender.id)
    if (!host || host.window.isDestroyed()) {
      console.warn('[BrowserHost] Ready rejected from unknown host', { hostId: sender.id })
      throw new Error('Unrecognized browser host')
    }
    host.ready = true
    host.recovering = false
    return [...this.pages.values()].filter(record => record.host === host.window).map(record => this.snapshot(record))
  }

  failed(sender: WebContents, failure: BrowserHostFailure): void {
    const record = this.pages.get(failure.id)
    if (!record || record.host.isDestroyed() || record.host.webContents !== sender || record.page.token !== failure.token) return
    console.warn('[BrowserHost] Renderer failed to attach guest', { pageId: failure.id, error: failure.error.slice(0, 500) })
    this.releaseRecord(record, new Error('Browser renderer failed to attach guest'))
  }

  present(id: string, bounds: BrowserHostBounds, visible: boolean, viewportWidth?: number): boolean {
    const record = this.pages.get(id)
    if (!record || !record.contents || record.contents.isDestroyed()) return false
    if (visible && record.host !== this.mainWindow) {
      console.warn('[BrowserHost] Cannot display a background-only page', { pageId: id })
      return false
    }
    const previous = record.page
    const nextBounds = {
      x: Number.isFinite(bounds.x) ? bounds.x : 0,
      y: Number.isFinite(bounds.y) ? bounds.y : 0,
      width: Math.max(1, Number.isFinite(bounds.width) ? bounds.width : DEFAULT_BOUNDS.width),
      height: Math.max(1, Number.isFinite(bounds.height) ? bounds.height : DEFAULT_BOUNDS.height),
    }
    if (previous.visible === visible && previous.viewportWidth === viewportWidth && Object.keys(nextBounds).every(key => previous.bounds[key as keyof BrowserHostBounds] === nextBounds[key as keyof BrowserHostBounds])) return true
    record.page = { ...previous, bounds: nextBounds, visible, viewportWidth }
    this.send(record, { type: 'upsert', page: this.snapshot(record) })
    return true
  }

  isVisible(id: string): boolean { return this.pages.get(id)?.page.visible === true }

  async prepareFrames(contents: WebContents, timeoutMs = 5000, signal?: AbortSignal): Promise<() => void> {
    const cancellationError = () => signal?.reason instanceof Error ? signal.reason : new Error('Browser frame preparation was cancelled')
    if (signal?.aborted) throw cancellationError()
    let record: PageRecord | undefined
    for (const candidate of this.pages.values()) {
      if (candidate.contents === contents) { record = candidate; break }
    }
    if (!record) return () => {}
    if (record.host.isDestroyed() || contents.isDestroyed()) throw new Error('Browser page closed before capture')
    if (record.frameLease) throw new Error('Browser frame preparation is already in progress')
    const host = this.hosts.get(record.host.webContents.id)
    if (!host || !host.ready) throw new Error('Browser host is unavailable during capture')
    if (!host.leases) {
      host.throttling = record.host.webContents.getBackgroundThrottling()
      if (host.throttling) record.host.webContents.setBackgroundThrottling(false)
    }
    host.leases++
    const page = record
    const frameLeaseId = randomUUID()
    let released = false
    const onAbort = () => release(cancellationError())
    const release = (reason = new Error('Browser frame preparation was released')) => {
      if (released) return
      released = true
      signal?.removeEventListener('abort', onAbort)
      if (page.frameLease) {
        clearTimeout(page.frameLease.timer)
        page.frameLease.reject(reason)
        page.frameLease = undefined
      }
      try {
        if (this.pages.get(page.page.id) === page) {
          page.page = { ...page.page, frameLeaseId: undefined }
          this.send(page, { type: 'upsert', page: this.snapshot(page) })
        }
      } catch (error) {
        console.warn('[BrowserHost] Failed to park a released frame lease', { pageId: page.page.id }, error)
      } finally {
        host.leases--
        if (!host.leases && host.throttling && !host.window.isDestroyed()) {
          try { host.window.webContents.setBackgroundThrottling(true) } catch (error) {
            console.warn('[BrowserHost] Failed to restore host throttling', { hostId: host.window.id }, error)
          }
        }
      }
    }
    try {
      await new Promise<void>((resolve, reject) => {
        page.frameLease = {
          resolve,
          reject,
          release,
          acknowledged: false,
          timer: setTimeout(() => reject(new Error('Browser frame preparation timed out')), timeoutMs),
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        if (signal?.aborted) {
          onAbort()
          return
        }
        page.page = { ...page.page, frameLeaseId }
        this.send(page, { type: 'upsert', page: this.snapshot(page) })
      })
      return release
    } catch (error) {
      release()
      throw error
    }
  }

  framesReady(sender: WebContents, ready: BrowserHostFrameReady): void {
    const record = this.pages.get(ready.id)
    if (!record || record.host.isDestroyed() || record.host.webContents !== sender || record.page.token !== ready.token || record.page.frameLeaseId !== ready.frameLeaseId) return
    if (record.frameLease) {
      record.frameLease.acknowledged = true
      clearTimeout(record.frameLease.timer)
      record.frameLease.resolve()
    }
  }

  destroy(id: string): void {
    const record = this.pages.get(id)
    if (record) this.releaseRecord(record, new Error('Browser page closed'))
  }

  destroyAll(): void {
    for (const record of [...this.pages.values()]) this.releaseRecord(record, new Error('Browser host shut down'))
    if (this.hiddenWindow && !this.hiddenWindow.isDestroyed()) this.hiddenWindow.destroy()
    this.hiddenWindow = null
  }

  private resetHost(sender: WebContents, reason: string): void {
    const host = this.hosts.get(sender.id)
    if (!host) return
    host.ready = false
    host.recovering = true
    const records = [...this.pages.values()].filter(record => record.host === host.window)
    if (records.length) console.warn('[BrowserHost] Releasing host pages', { hostId: sender.id, pages: records.length, reason })
    for (const record of records) this.releaseRecord(record, new Error(reason))
    for (const [id, attaching] of this.attachingGuests) {
      if (attaching.host !== host.window) continue
      clearTimeout(attaching.timer)
      this.attachingGuests.delete(id)
      if (!attaching.contents.isDestroyed()) attaching.contents.close({ waitForBeforeUnload: false })
    }
  }

  private releaseRecord(record: PageRecord, error: Error): void {
    if (this.pages.get(record.page.id) !== record) return
    this.pages.delete(record.page.id)
    this.tokens.delete(record.page.token)
    clearTimeout(record.timer)
    record.frameLease?.release()
    record.reject(error)
    this.send(record, { type: 'remove', id: record.page.id, token: record.page.token })
    if (record.contents && !record.contents.isDestroyed()) record.contents.close({ waitForBeforeUnload: false })
    if (!this.pages.size && this.stateTimer) {
      clearInterval(this.stateTimer)
      this.stateTimer = null
    }
  }

  private snapshot(record: PageRecord): BrowserHostPage {
    return { ...record.page, bounds: { ...record.page.bounds } }
  }

  private send(record: PageRecord, command: BrowserHostCommand): void {
    if (record.host.isDestroyed()) return
    const contents = record.host.webContents
    if (contents.isDestroyed() || !this.hosts.get(contents.id)?.ready) return
    contents.send('browser:host-command', command)
  }

  private startStateReporting(): void {
    if (this.stateTimer) return
    this.stateTimer = setInterval(() => {
      console.log('[BrowserHost] State', {
        hosts: this.hosts.size,
        pages: this.pages.size,
        pending: [...this.pages.values()].filter(record => !record.contents).length,
        visible: [...this.pages.values()].filter(record => record.page.visible).length,
        attaching: this.attachingGuests.size,
        frameLeases: [...this.hosts.values()].reduce((count, host) => count + host.leases, 0),
        waitingFrames: [...this.pages.values()].filter(record => record.frameLease && !record.frameLease.acknowledged).length,
      })
    }, 300000)
    this.stateTimer.unref()
  }
}

export const browserHostManager = new BrowserHostManager()
