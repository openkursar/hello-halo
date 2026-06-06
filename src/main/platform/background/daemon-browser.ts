/**
 * platform/background/daemon-browser -- Hidden BrowserWindow manager
 *
 * Provides a shared hidden BrowserWindow for automation tasks.
 * Features:
 * - Domain-level session isolation via `persist:automation-{domain}` partitions
 * - Stealth script injection (reuses services/stealth)
 * - FIFO task queue (V1: single window, sequential access)
 * - Safety timeout for hung callers
 */

import * as path from 'path'
import * as fs from 'fs'
import { BrowserWindow, session, app, type WebContents } from 'electron'
import { extractPartition } from './partition'
import { sanitizeFilename, resolveUniquePath } from '../../foundation/file-naming'

/**
 * Anti-detection stealth injection is browser-domain behavior (lives in
 * `services/stealth`), which sits ABOVE this platform module. Rather than
 * import upward, the daemon browser exposes an injector seam that bootstrap
 * wires from services at startup (`setDaemonStealthInjector`). Injection is
 * best-effort: if the seam is unset, the daemon window simply runs without it.
 */
type StealthInjector = (webContents: WebContents) => Promise<void>
let stealthInjector: StealthInjector | null = null
export function setDaemonStealthInjector(injector: StealthInjector): void {
  stealthInjector = injector
}

/**
 * Default user agent matching a real Chrome browser.
 * This is used to avoid detection as an Electron app.
 */
const CHROME_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/**
 * Maximum time (ms) a caller can hold the daemon browser before auto-release.
 * Default: 5 minutes. This prevents a hung caller from permanently blocking
 * the queue.
 */
const AUTO_RELEASE_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Queued request waiting for the daemon browser.
 */
interface QueueEntry {
  url: string
  resolve: (win: BrowserWindow) => void
  reject: (error: Error) => void
}

/**
 * DaemonBrowserManager manages a single shared hidden BrowserWindow
 * for automation tasks.
 *
 * V1 design: One window, sequential access, FIFO queue.
 * Future: Could be extended to a window pool.
 */
export class DaemonBrowserManager {
  private daemonWindow: BrowserWindow | null = null
  private currentPartition: string | null = null
  private isInUse = false
  private queue: QueueEntry[] = []
  private releaseTimer: ReturnType<typeof setTimeout> | null = null
  private isShuttingDown = false
  private stealthInjected = false
  /** Tracks partitions that already have a will-download handler to avoid duplicate registration. */
  private downloadHandlerPartitions = new Set<string>()

  /**
   * Acquire the daemon BrowserWindow for a given URL.
   *
   * If the window is currently in use, the request is queued.
   * The URL determines the session partition. If the partition differs
   * from the current one, the window is reconfigured.
   *
   * @param url - Target URL (used to derive the partition)
   * @returns The hidden BrowserWindow ready for use
   */
  async getDaemonBrowserWindow(url: string): Promise<BrowserWindow> {
    if (this.isShuttingDown) {
      throw new Error('[DaemonBrowser] Service is shutting down')
    }

    const partition = extractPartition(url)

    // If the window is currently in use, queue this request
    if (this.isInUse) {
      return new Promise<BrowserWindow>((resolve, reject) => {
        this.queue.push({ url, resolve, reject })
        console.log(`[DaemonBrowser] Request queued (queue depth: ${this.queue.length})`)
      })
    }

    // Mark as in use and serve the request
    this.isInUse = true
    try {
      return await this.prepareWindow(url, partition)
    } catch (err) {
      this.isInUse = false
      throw err
    }
  }

  /**
   * Release the daemon BrowserWindow after use.
   * Serves the next queued request if any.
   */
  releaseDaemonBrowserWindow(): void {
    this.clearReleaseTimer()

    if (!this.isInUse) {
      console.warn('[DaemonBrowser] Release called but window is not in use')
      return
    }

    console.log('[DaemonBrowser] Window released')

    // Serve next queued request
    if (this.queue.length > 0) {
      const next = this.queue.shift()!
      const partition = extractPartition(next.url)
      console.log(`[DaemonBrowser] Serving next queued request (remaining: ${this.queue.length})`)

      this.prepareWindow(next.url, partition)
        .then(next.resolve)
        .catch((err) => {
          this.isInUse = false
          next.reject(err)
          // Try to serve the next queued request
          this.drainQueue()
        })
    } else {
      this.isInUse = false
    }
  }

  /**
   * Try to serve the next queued request after a failure.
   */
  private drainQueue(): void {
    if (this.queue.length > 0 && !this.isInUse) {
      const next = this.queue.shift()!
      const partition = extractPartition(next.url)
      this.isInUse = true
      this.prepareWindow(next.url, partition)
        .then(next.resolve)
        .catch((err) => {
          this.isInUse = false
          next.reject(err)
          this.drainQueue()
        })
    }
  }

  /**
   * Destroy the daemon window and reject all queued requests.
   * Called during shutdown.
   */
  destroy(): void {
    this.isShuttingDown = true
    this.clearReleaseTimer()

    // Reject all queued requests
    for (const entry of this.queue) {
      entry.reject(new Error('[DaemonBrowser] Service is shutting down'))
    }
    this.queue = []

    // Destroy the window
    if (this.daemonWindow && !this.daemonWindow.isDestroyed()) {
      try {
        this.daemonWindow.destroy()
        console.log('[DaemonBrowser] Window destroyed')
      } catch (error) {
        console.error('[DaemonBrowser] Error destroying window:', error)
      }
    }

    this.daemonWindow = null
    this.currentPartition = null
    this.isInUse = false
    this.stealthInjected = false
  }

  /**
   * Check if the daemon window currently exists.
   */
  hasWindow(): boolean {
    return this.daemonWindow !== null && !this.daemonWindow.isDestroyed()
  }

  /**
   * Prepare the daemon window for a request.
   * Creates the window if needed, reconfigures the partition if different,
   * and injects stealth scripts.
   */
  private async prepareWindow(url: string, partition: string): Promise<BrowserWindow> {
    // Start the auto-release safety timer
    this.startReleaseTimer()

    // If partition changed or window does not exist, (re)create the window
    if (!this.daemonWindow || this.daemonWindow.isDestroyed() || this.currentPartition !== partition) {
      await this.createWindow(partition)
    }

    return this.daemonWindow!
  }

  /**
   * Create (or recreate) the hidden daemon BrowserWindow with the given partition.
   */
  private async createWindow(partition: string): Promise<void> {
    // Destroy existing window if any
    if (this.daemonWindow && !this.daemonWindow.isDestroyed()) {
      this.daemonWindow.destroy()
      this.stealthInjected = false
    }

    // Ensure the partition session exists
    const sess = session.fromPartition(partition, { cache: true })

    // Set a realistic user agent on the session
    sess.setUserAgent(CHROME_USER_AGENT)

    // Silent download handler: daemon browser is always automation,
    // so all downloads are saved without prompting the user.
    // Guard: session.fromPartition() returns a singleton per partition, so we must
    // only register the handler once per partition to avoid listener accumulation.
    if (!this.downloadHandlerPartitions.has(partition)) {
      this.downloadHandlerPartitions.add(partition)
      sess.on('will-download', (_event, item) => {
        const downloadDir = path.join(app.getPath('downloads'), 'halo-daemon')
        fs.mkdirSync(downloadDir, { recursive: true })
        const safeName = sanitizeFilename(item.getFilename())
        const savePath = resolveUniquePath(downloadDir, safeName)
        item.setSavePath(savePath)
        console.log(`[DaemonBrowser] Silent download: ${path.basename(savePath)} -> ${downloadDir}`)
      })
    }

    this.daemonWindow = new BrowserWindow({
      show: false,
      width: 1920,
      height: 1080,
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // Offscreen rendering is not needed; we just need a hidden window
        // that can load and interact with web pages via CDP.
        webSecurity: true,
        allowRunningInsecureContent: false
      }
    })

    this.currentPartition = partition

    // Prevent the daemon window from appearing in the taskbar / dock
    this.daemonWindow.setSkipTaskbar(true)

    // Handle unexpected close
    this.daemonWindow.on('closed', () => {
      this.daemonWindow = null
      this.currentPartition = null
      this.stealthInjected = false
    })

    // Inject stealth scripts via CDP (best-effort; injector wired by bootstrap)
    if (!this.stealthInjected && stealthInjector) {
      try {
        await stealthInjector(this.daemonWindow.webContents)
        this.stealthInjected = true
        console.log(`[DaemonBrowser] Stealth scripts injected (partition: ${partition})`)
      } catch (error) {
        console.error('[DaemonBrowser] Stealth injection failed:', error)
        // Continue anyway -- stealth is best-effort for the daemon window.
        // The window is still usable without it.
      }
    }

    console.log(`[DaemonBrowser] Window created (partition: ${partition})`)
  }

  /**
   * Start the safety timer that auto-releases the window if the caller
   * does not release it within AUTO_RELEASE_TIMEOUT_MS.
   */
  private startReleaseTimer(): void {
    this.clearReleaseTimer()
    this.releaseTimer = setTimeout(() => {
      if (this.isInUse) {
        console.warn(
          `[DaemonBrowser] Auto-releasing after ${AUTO_RELEASE_TIMEOUT_MS / 1000}s timeout`
        )
        this.releaseDaemonBrowserWindow()
      }
    }, AUTO_RELEASE_TIMEOUT_MS)
  }

  /**
   * Clear the safety release timer.
   */
  private clearReleaseTimer(): void {
    if (this.releaseTimer) {
      clearTimeout(this.releaseTimer)
      this.releaseTimer = null
    }
  }
}
