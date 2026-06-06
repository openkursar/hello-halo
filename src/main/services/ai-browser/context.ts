/**
 * Browser Context - Core context manager for AI Browser
 *
 * The BrowserContext is the central manager for AI Browser operations.
 * It provides:
 * - Access to the active BrowserView's WebContents
 * - CDP command execution with automatic timeout protection
 * - Accessibility snapshot management
 * - Network and console monitoring
 * - Element interaction operations
 * - Emulation and performance tracing
 *
 * All AI Browser tools operate through this context.
 */

import * as path from 'path'
import * as fs from 'fs'
import { BrowserWindow, nativeImage, app } from 'electron'
import { browserViewManager } from '../browser-view.service'
import {
  createAccessibilitySnapshot,
  getElementBoundingBox,
  scrollIntoView,
  focusElement
} from './snapshot'
import {
  registerWebContentsForDownload,
  unregisterWebContentsForDownload
} from './download-handler'
import { sanitizeFilename, resolveUniquePath } from '../../foundation/file-naming'
import type {
  BrowserContextInterface,
  AccessibilitySnapshot,
  AccessibilityNode,
  NetworkRequest,
  ConsoleMessage,
  DialogInfo,
  DownloadInfo,
  DownloadState
} from './types'

// Default timeout for CDP commands (ms)
const CDP_TIMEOUT = 15_000
// Default timeout for navigation operations (ms)
const NAVIGATION_TIMEOUT = 30_000
// Default timeout for element wait operations (ms)
const WAIT_TIMEOUT = 30_000

/**
 * Wrap a promise with a timeout. Rejects with a clear error if the promise
 * does not settle within `ms` milliseconds.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label = 'Operation'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`))
    }, ms)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) }
    )
  })
}

/**
 * BrowserContext - Manages the browser state for AI operations
 */
export class BrowserContext implements BrowserContextInterface {
  /**
   * Working directory for resolving relative paths (e.g. browser_run scripts).
   * Set by createAIBrowserMcpServer() at server creation time.
   */
  workDir: string | undefined = undefined

  private mainWindow: BrowserWindow | null = null
  private activeViewId: string | null = null
  private lastSnapshot: AccessibilitySnapshot | null = null

  // Network monitoring state
  private networkRequests: Map<string, NetworkRequest> = new Map()
  private networkEnabled: boolean = false
  private networkRequestCounter: number = 0

  // Console monitoring state
  private consoleMessages: ConsoleMessage[] = []
  private consoleEnabled: boolean = false
  private consoleMessageCounter: number = 0

  // Dialog handling state
  private pendingDialog: DialogInfo | null = null
  private dialogResolver: ((result: { accept: boolean; promptText?: string }) => void) | null = null
  private pageEnabled: boolean = false

  // Download tracking state (capped at MAX_DOWNLOAD_HISTORY to prevent unbounded growth)
  private static readonly MAX_DOWNLOAD_HISTORY = 500
  private downloads: Map<string, DownloadInfo> = new Map()
  private downloadCounter: number = 0
  private downloadDirCreated: boolean = false
  private pendingDownloadResolvers: Array<{
    resolve: (info: DownloadInfo) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
  }> = []

  // Performance tracing state
  private isTracing: boolean = false
  private traceStartTime: number = 0

  // View tracking for scoped cleanup
  private ownedViewIds: Set<string> = new Set()

  // Whether this is a scoped context (used for automation isolation).
  // Scoped contexts create BrowserViews on the offscreen host window instead
  // of the main window, preventing lifecycle conflicts with user-visible views.
  private _isScoped: boolean = false

  /** Whether this context is scoped (automation) vs the global singleton (interactive). */
  get isScoped(): boolean {
    return this._isScoped
  }

  /** Mark this context as scoped. Called by createScopedBrowserContext(). */
  markAsScoped(): void {
    this._isScoped = true
  }

  /**
   * Initialize the context with the main window
   */
  initialize(mainWindow: BrowserWindow): void {
    this.mainWindow = mainWindow
    console.log('[BrowserContext] Initialized')
  }

  /**
   * Get the currently active view ID
   */
  getActiveViewId(): string | null {
    return this.activeViewId
  }

  /**
   * Set the active browser view
   * Also notifies the renderer process of the new active view ID
   */
  setActiveViewId(viewId: string): void {
    // If changing views, disable monitoring on old view
    if (this.activeViewId && this.activeViewId !== viewId) {
      this.disableMonitoring()
    }

    this.activeViewId = viewId
    console.log(`[BrowserContext] Active view set to: ${viewId}`)

    // Enable monitoring on new view
    this.enableMonitoring()

    // Notify renderer of active view change for BrowserTaskCard "View Live" functionality
    this.notifyActiveViewChange(viewId)
  }

  /**
   * Notify renderer process of active view ID change
   * Used by BrowserTaskCard to show the correct AI-controlled browser
   */
  private notifyActiveViewChange(viewId: string): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      const state = browserViewManager.getState(viewId)
      this.mainWindow.webContents.send('ai-browser:active-view-changed', {
        viewId,
        url: state?.url || null,
        title: state?.title || null,
      })
      console.log(`[BrowserContext] Notified renderer of active view: ${viewId}`)
    }
  }

  /**
   * Get the WebContents of the active BrowserView
   */
  getWebContents(): Electron.WebContents | null {
    if (!this.activeViewId) {
      console.warn('[BrowserContext] No active view ID')
      return null
    }

    const state = browserViewManager.getState(this.activeViewId)
    if (!state) {
      console.warn(`[BrowserContext] No state for view: ${this.activeViewId}`)
      return null
    }

    // Access the BrowserView's webContents through the manager
    // We need to extend browserViewManager to expose this
    return (browserViewManager as any).getWebContents(this.activeViewId)
  }

  /**
   * Ensure the CDP debugger is attached to the active webContents.
   * Safe to call repeatedly - silently ignores "already attached" errors.
   */
  private ensureDebuggerAttached(webContents: Electron.WebContents): void {
    try {
      webContents.debugger.attach('1.3')
    } catch (_e) {
      // Already attached - this is expected
    }
  }

  /**
   * Send a CDP command to the active browser with automatic timeout protection.
   * Every CDP call is guarded by a configurable timeout (default: 15s) to
   * prevent the tool from hanging indefinitely if the page becomes unresponsive.
   */
  async sendCDPCommand<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeout: number = CDP_TIMEOUT
  ): Promise<T> {
    const webContents = this.getWebContents()
    if (!webContents) {
      throw new Error('No active browser view')
    }

    this.ensureDebuggerAttached(webContents)

    return withTimeout(
      webContents.debugger.sendCommand(method, params) as Promise<T>,
      timeout,
      `CDP ${method}`
    )
  }

  // ============================================
  // Accessibility Snapshot
  // ============================================

  /**
   * Create a new accessibility snapshot
   */
  async createSnapshot(verbose: boolean = false): Promise<AccessibilitySnapshot> {
    const webContents = this.getWebContents()
    if (!webContents) {
      throw new Error('No active browser view')
    }

    this.lastSnapshot = await createAccessibilitySnapshot(webContents, verbose)
    return this.lastSnapshot
  }

  /**
   * Get the last created snapshot
   */
  getLastSnapshot(): AccessibilitySnapshot | null {
    return this.lastSnapshot
  }

  /**
   * Get an element by its UID from the last snapshot
   */
  getElementByUid(uid: string): AccessibilityNode | null {
    if (!this.lastSnapshot) {
      return null
    }
    return this.lastSnapshot.idToNode.get(uid) || null
  }

  // ============================================
  // Network Monitoring
  // ============================================

  /**
   * Enable network monitoring
   */
  private async enableNetworkMonitoring(): Promise<void> {
    const webContents = this.getWebContents()
    if (!webContents || this.networkEnabled) return

    try {
      // Ensure debugger is attached
      try {
        webContents.debugger.attach('1.3')
      } catch (e) {
        // Already attached
      }

      // Enable network domain
      await webContents.debugger.sendCommand('Network.enable')

      // Listen for network events
      webContents.debugger.on('message', this.handleCDPMessage)

      this.networkEnabled = true
      console.log('[BrowserContext] Network monitoring enabled')
    } catch (error) {
      console.error('[BrowserContext] Failed to enable network monitoring:', error)
    }
  }

  /**
   * Handle CDP messages for network monitoring
   */
  private handleCDPMessage = (
    event: Electron.Event,
    method: string,
    params: Record<string, unknown>
  ): void => {
    switch (method) {
      case 'Network.requestWillBeSent':
        this.handleNetworkRequest(params)
        break
      case 'Network.responseReceived':
        this.handleNetworkResponse(params)
        break
      case 'Network.loadingFailed':
        this.handleNetworkError(params)
        break
      case 'Runtime.consoleAPICalled':
        this.handleConsoleMessage(params)
        break
      case 'Page.javascriptDialogOpening':
        this.handleDialogOpening(params)
        break
    }
  }

  private handleNetworkRequest(params: Record<string, unknown>): void {
    const requestId = params.requestId as string
    const request = params.request as {
      url: string
      method: string
      headers?: Record<string, string>
      postData?: string
    }
    const resourceType = params.type as string

    const id = `req_${++this.networkRequestCounter}`
    this.networkRequests.set(requestId, {
      id,
      url: request.url,
      method: request.method,
      resourceType,
      requestHeaders: request.headers,
      requestBody: request.postData,
      timing: {
        requestTime: Date.now(),
        responseTime: 0,
        duration: 0
      }
    })
  }

  private handleNetworkResponse(params: Record<string, unknown>): void {
    const requestId = params.requestId as string
    const response = params.response as {
      url: string
      status: number
      statusText: string
      headers?: Record<string, string>
      mimeType?: string
    }

    const request = this.networkRequests.get(requestId)
    if (request) {
      request.status = response.status
      request.statusText = response.statusText
      request.responseHeaders = response.headers
      request.mimeType = response.mimeType
      if (request.timing) {
        request.timing.responseTime = Date.now()
        request.timing.duration = request.timing.responseTime - request.timing.requestTime
      }
    }
  }

  private handleNetworkError(params: Record<string, unknown>): void {
    const requestId = params.requestId as string
    const errorText = params.errorText as string

    const request = this.networkRequests.get(requestId)
    if (request) {
      request.error = errorText
    }
  }

  /**
   * Get all network requests
   * @param includePreserved If true, includes preserved requests from previous navigations
   */
  getNetworkRequests(includePreserved: boolean = false): NetworkRequest[] {
    // Note: For now, we return all requests. In the future, we can track
    // navigation boundaries and filter based on includePreserved
    return Array.from(this.networkRequests.values())
  }

  /**
   * Get a specific network request by ID
   */
  getNetworkRequest(id: string): NetworkRequest | undefined {
    const requests = Array.from(this.networkRequests.values())
    return requests.find(r => r.id === id)
  }

  /**
   * Get the response body of a network request by its display ID (e.g., "req_1").
   * Uses CDP Network.getResponseBody with the original CDP requestId.
   */
  async getNetworkResponseBody(id: string): Promise<string | undefined> {
    for (const [cdpRequestId, request] of this.networkRequests.entries()) {
      if (request.id === id) {
        try {
          const result = await this.sendCDPCommand<{ body: string; base64Encoded: boolean }>(
            'Network.getResponseBody',
            { requestId: cdpRequestId }
          )
          return result.base64Encoded
            ? Buffer.from(result.body, 'base64').toString()
            : result.body
        } catch {
          return undefined
        }
      }
    }
    return undefined
  }

  /**
   * Get the currently selected network request (if DevTools integration is available)
   */
  getSelectedNetworkRequest(): NetworkRequest | undefined {
    // For now, return undefined. This can be implemented when
    // we have DevTools panel integration
    return undefined
  }

  /**
   * Clear network requests
   */
  clearNetworkRequests(): void {
    this.networkRequests.clear()
    this.networkRequestCounter = 0
  }

  // ============================================
  // Console Monitoring
  // ============================================

  /**
   * Enable console monitoring
   */
  private async enableConsoleMonitoring(): Promise<void> {
    const webContents = this.getWebContents()
    if (!webContents || this.consoleEnabled) return

    try {
      // Ensure debugger is attached
      try {
        webContents.debugger.attach('1.3')
      } catch (e) {
        // Already attached
      }

      // Enable Runtime domain for console events
      await webContents.debugger.sendCommand('Runtime.enable')

      this.consoleEnabled = true
      console.log('[BrowserContext] Console monitoring enabled')
    } catch (error) {
      console.error('[BrowserContext] Failed to enable console monitoring:', error)
    }
  }

  /**
   * Enable Page domain for dialog event capture.
   * Without Page.enable, the CDP event Page.javascriptDialogOpening is never
   * dispatched, making browser_handle_dialog unable to intercept dialogs.
   */
  private async enablePageDomain(): Promise<void> {
    const webContents = this.getWebContents()
    if (!webContents || this.pageEnabled) return

    try {
      try {
        webContents.debugger.attach('1.3')
      } catch (e) {
        // Already attached
      }

      await webContents.debugger.sendCommand('Page.enable')

      this.pageEnabled = true
      console.log('[BrowserContext] Page domain enabled (dialog interception active)')
    } catch (error) {
      console.error('[BrowserContext] Failed to enable Page domain:', error)
    }
  }

  private handleConsoleMessage(params: Record<string, unknown>): void {
    const type = params.type as string
    const args = params.args as Array<{ type: string; value?: unknown; description?: string }>
    const stackTrace = params.stackTrace as { callFrames?: Array<{ url: string; lineNumber: number }> }

    // Convert args to string representation
    const text = args
      .map(arg => {
        if (arg.value !== undefined) return String(arg.value)
        if (arg.description) return arg.description
        return '[Object]'
      })
      .join(' ')

    const id = `msg_${++this.consoleMessageCounter}`
    const message: ConsoleMessage = {
      id,
      type: type as ConsoleMessage['type'],
      text,
      timestamp: Date.now(),
      args: args.map(a => a.value)
    }

    // Add stack trace info if available
    if (stackTrace?.callFrames?.[0]) {
      const frame = stackTrace.callFrames[0]
      message.url = frame.url
      message.lineNumber = frame.lineNumber
    }

    this.consoleMessages.push(message)

    // Keep only last 1000 messages
    if (this.consoleMessages.length > 1000) {
      this.consoleMessages = this.consoleMessages.slice(-1000)
    }
  }

  /**
   * Get all console messages
   * @param includePreserved If true, includes preserved messages from previous navigations
   */
  getConsoleMessages(includePreserved: boolean = false): ConsoleMessage[] {
    // Note: For now, we return all messages. In the future, we can track
    // navigation boundaries and filter based on includePreserved
    return this.consoleMessages
  }

  /**
   * Get a specific console message by ID
   */
  getConsoleMessage(id: string): ConsoleMessage | undefined {
    return this.consoleMessages.find(m => m.id === id)
  }

  /**
   * Clear console messages
   */
  clearConsoleMessages(): void {
    this.consoleMessages = []
    this.consoleMessageCounter = 0
  }

  // ============================================
  // Dialog Handling
  // ============================================

  private handleDialogOpening(params: Record<string, unknown>): void {
    this.pendingDialog = {
      type: params.type as DialogInfo['type'],
      message: params.message as string,
      defaultPrompt: params.defaultPrompt as string | undefined
    }
  }

  /**
   * Get pending dialog
   */
  getPendingDialog(): DialogInfo | null {
    return this.pendingDialog
  }

  /**
   * Handle a dialog (accept or dismiss)
   */
  async handleDialog(accept: boolean, promptText?: string): Promise<void> {
    try {
      await this.sendCDPCommand('Page.handleJavaScriptDialog', {
        accept,
        promptText
      })
      this.pendingDialog = null
    } catch (error) {
      console.error('[BrowserContext] Failed to handle dialog:', error)
    }
  }

  // ============================================
  // Download Handling
  // ============================================

  /**
   * Get the download directory for this context.
   * Scoped contexts use {workDir}/downloads/, global singleton uses system Downloads/halo-ai/.
   */
  getDownloadDir(): string {
    const dir = this.workDir
      ? path.join(this.workDir, 'downloads')
      : path.join(app.getPath('downloads'), 'halo-ai')
    if (!this.downloadDirCreated) {
      fs.mkdirSync(dir, { recursive: true })
      this.downloadDirCreated = true
    }
    return dir
  }

  /**
   * Get all tracked downloads.
   */
  getDownloads(): DownloadInfo[] {
    return Array.from(this.downloads.values())
  }

  /**
   * Get a download by ID.
   */
  getDownload(id: string): DownloadInfo | undefined {
    return this.downloads.get(id)
  }

  /**
   * Register a new download. Called by the session-level will-download handler.
   * Sanitizes the filename, resolves a unique path, and creates a tracking entry.
   */
  registerDownload(
    url: string,
    suggestedFilename: string,
    totalBytes: number,
    mimeType: string
  ): { id: string; resolvedPath: string } {
    this.downloadCounter++
    const id = `dl_${this.downloadCounter}`
    const sanitized = sanitizeFilename(suggestedFilename)
    const downloadDir = this.getDownloadDir()
    const resolvedPath = resolveUniquePath(downloadDir, sanitized)

    const info: DownloadInfo = {
      id,
      url,
      filename: path.basename(resolvedPath),
      savePath: resolvedPath,
      state: 'pending',
      totalBytes,
      receivedBytes: 0,
      mimeType,
      startTime: Date.now(),
    }

    this.downloads.set(id, info)

    // Evict oldest consumed/completed entries if over capacity
    if (this.downloads.size > BrowserContext.MAX_DOWNLOAD_HISTORY) {
      for (const [oldId, oldInfo] of this.downloads) {
        if (oldInfo.consumed && (oldInfo.state === 'completed' || oldInfo.state === 'failed' || oldInfo.state === 'cancelled')) {
          this.downloads.delete(oldId)
          if (this.downloads.size <= BrowserContext.MAX_DOWNLOAD_HISTORY) break
        }
      }
    }

    return { id, resolvedPath }
  }

  /**
   * Update download progress. Resolves waitForDownload() promises on terminal states.
   */
  updateDownloadProgress(id: string, receivedBytes: number, state: DownloadState, error?: string): void {
    const info = this.downloads.get(id)
    if (!info) return

    info.receivedBytes = receivedBytes
    info.state = state
    if (error) info.error = error

    // Terminal state: set end time and resolve any pending waiters
    if (state === 'completed' || state === 'failed' || state === 'cancelled') {
      info.endTime = Date.now()

      // Resolve the oldest pending waiter (FIFO) and mark as consumed
      if (this.pendingDownloadResolvers.length > 0) {
        const waiter = this.pendingDownloadResolvers.shift()!
        clearTimeout(waiter.timer)
        info.consumed = true
        waiter.resolve(info)
      }
    }
  }

  /**
   * Wait for the next download to reach a terminal state.
   * Returns a promise that resolves with the DownloadInfo.
   *
   * If a download has already completed since the last call to waitForDownload,
   * resolves immediately.
   */
  waitForDownload(timeout: number = 60_000): Promise<DownloadInfo> {
    // Check if there's already a completed download that hasn't been consumed.
    // No time window restriction — relies solely on the `consumed` flag to prevent
    // double-consumption. This handles the common case where AI clicks a download
    // button and the file completes before the next tool call arrives (LLM latency).
    for (const [, info] of this.downloads) {
      if ((info.state === 'completed' || info.state === 'failed' || info.state === 'cancelled')
          && !info.consumed) {
        info.consumed = true
        return Promise.resolve(info)
      }
    }

    return new Promise<DownloadInfo>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.pendingDownloadResolvers.findIndex(w => w.resolve === resolve)
        if (idx !== -1) this.pendingDownloadResolvers.splice(idx, 1)
        reject(new Error(`No download completed within ${timeout}ms`))
      }, timeout)

      this.pendingDownloadResolvers.push({ resolve, reject, timer })
    })
  }

  // ============================================
  // Element Operations
  // ============================================

  /**
   * Click an element by UID
   */
  async clickElement(uid: string, options?: { dblClick?: boolean }): Promise<void> {
    const element = this.getElementByUid(uid)
    if (!element) {
      throw new Error(`Element not found: ${uid}`)
    }

    const webContents = this.getWebContents()
    if (!webContents) {
      throw new Error('No active browser view')
    }

    // Scroll element into view
    await scrollIntoView(webContents, element.backendNodeId)

    // Get element bounding box
    const box = await getElementBoundingBox(webContents, element.backendNodeId)
    if (!box) {
      throw new Error(`Could not get bounding box for element: ${uid}`)
    }

    // Calculate center point
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2

    // Perform click using CDP
    if (options?.dblClick) {
      // Double-click requires two full click cycles.
      // First click (clickCount 1)
      await this.sendCDPCommand('Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button: 'left', clickCount: 1
      })
      await this.sendCDPCommand('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button: 'left', clickCount: 1
      })
      // Brief pause between clicks — mirrors real user behavior and gives
      // Electron's event loop time to process the first click.
      await new Promise(r => setTimeout(r, 50))
      // Second click (clickCount 2 signals the OS-level dblclick)
      await this.sendCDPCommand('Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button: 'left', clickCount: 2
      })
      await this.sendCDPCommand('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button: 'left', clickCount: 2
      })
    } else {
      await this.sendCDPCommand('Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button: 'left', clickCount: 1
      })
      await this.sendCDPCommand('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button: 'left', clickCount: 1
      })
    }
  }

  /**
   * Hover over an element by UID
   */
  async hoverElement(uid: string): Promise<void> {
    const element = this.getElementByUid(uid)
    if (!element) {
      throw new Error(`Element not found: ${uid}`)
    }

    const webContents = this.getWebContents()
    if (!webContents) {
      throw new Error('No active browser view')
    }

    // Scroll element into view
    await scrollIntoView(webContents, element.backendNodeId)

    // Get element bounding box
    const box = await getElementBoundingBox(webContents, element.backendNodeId)
    if (!box) {
      throw new Error(`Could not get bounding box for element: ${uid}`)
    }

    // Move mouse to element center
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2

    await this.sendCDPCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y
    })
  }

  /**
   * Fill an input element with text
   */
  async fillElement(uid: string, value: string): Promise<void> {
    const element = this.getElementByUid(uid)
    if (!element) {
      throw new Error(`Element not found: ${uid}`)
    }

    const webContents = this.getWebContents()
    if (!webContents) {
      throw new Error('No active browser view')
    }

    // Focus the element
    await focusElement(webContents, element.backendNodeId)

    // Clear existing content
    // Use platform-specific modifier: macOS uses Command (Meta=4), others use Ctrl (2)
    const selectAllModifier = process.platform === 'darwin' ? 4 : 2
    await this.sendCDPCommand('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'a',
      code: 'KeyA',
      modifiers: selectAllModifier
    })
    await this.sendCDPCommand('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'a',
      code: 'KeyA',
      modifiers: selectAllModifier
    })

    // Delete selection
    await this.sendCDPCommand('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Backspace',
      code: 'Backspace'
    })
    await this.sendCDPCommand('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Backspace',
      code: 'Backspace'
    })

    // Insert new text
    await this.sendCDPCommand('Input.insertText', { text: value })
  }

  /**
   * Select an option from a combobox/select element
   * Aligned with chrome-devtools-mcp: selectOption in input.ts
   *
   * For combobox/select elements, the value is the text content of the option.
   * We need to find the matching option and get its actual DOM value.
   */
  async selectOption(uid: string, value: string): Promise<void> {
    const element = this.getElementByUid(uid)
    if (!element) {
      throw new Error(`Element not found: ${uid}`)
    }

    if (element.role !== 'combobox' && element.role !== 'listbox') {
      throw new Error(`Element is not a select/combobox: ${element.role}`)
    }

    // Find the option with matching text
    let optionFound = false
    for (const child of element.children || []) {
      if (child.role === 'option' && child.name === value) {
        optionFound = true

        // Get the option's DOM value via CDP
        const webContents = this.getWebContents()
        if (!webContents) {
          throw new Error('No active browser view')
        }

        try {
          // Resolve the option node to get its value property
          const resolveResponse = await this.sendCDPCommand<{
            object?: { objectId?: string }
          }>('DOM.resolveNode', {
            backendNodeId: child.backendNodeId
          })

          if (resolveResponse?.object?.objectId) {
            // Get the option's value property
            const valueResponse = await this.sendCDPCommand<{
              result?: { value?: string }
            }>('Runtime.callFunctionOn', {
              objectId: resolveResponse.object.objectId,
              functionDeclaration: 'function() { return this.value; }',
              returnByValue: true
            })

            const optionValue = valueResponse?.result?.value || value

            // Set the select element's value
            const parentResolve = await this.sendCDPCommand<{
              object?: { objectId?: string }
            }>('DOM.resolveNode', {
              backendNodeId: element.backendNodeId
            })

            if (parentResolve?.object?.objectId) {
              await this.sendCDPCommand('Runtime.callFunctionOn', {
                objectId: parentResolve.object.objectId,
                functionDeclaration: `function(val) {
                  this.value = val;
                  this.dispatchEvent(new Event('change', { bubbles: true }));
                  this.dispatchEvent(new Event('input', { bubbles: true }));
                }`,
                arguments: [{ value: optionValue }],
                awaitPromise: true
              })
            }
          }
        } catch (error) {
          console.error('[BrowserContext] Failed to select option:', error)
          throw error
        }
        break
      }
    }

    if (!optionFound) {
      throw new Error(`Could not find option with text "${value}"`)
    }
  }

  /**
   * Drag an element to another element
   */
  async dragElement(fromUid: string, toUid: string): Promise<void> {
    const fromElement = this.getElementByUid(fromUid)
    const toElement = this.getElementByUid(toUid)

    if (!fromElement) {
      throw new Error(`Source element not found: ${fromUid}`)
    }
    if (!toElement) {
      throw new Error(`Target element not found: ${toUid}`)
    }

    const webContents = this.getWebContents()
    if (!webContents) {
      throw new Error('No active browser view')
    }

    // Get bounding boxes
    const fromBox = await getElementBoundingBox(webContents, fromElement.backendNodeId)
    const toBox = await getElementBoundingBox(webContents, toElement.backendNodeId)

    if (!fromBox || !toBox) {
      throw new Error('Could not get element positions')
    }

    const fromX = fromBox.x + fromBox.width / 2
    const fromY = fromBox.y + fromBox.height / 2
    const toX = toBox.x + toBox.width / 2
    const toY = toBox.y + toBox.height / 2

    // Move to source element first so the browser registers hover state.
    // Without this, Electron's CDP bridge may not correctly associate the
    // subsequent mousePressed with the source element.
    await this.sendCDPCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: fromX, y: fromY
    })

    // Press on source
    await this.sendCDPCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: fromX, y: fromY, button: 'left', clickCount: 1
    })

    // Move in steps for smooth drag.
    // A small delay between steps prevents Electron's CDP pipeline from
    // stalling when many Input.dispatchMouseEvent calls are queued rapidly.
    const steps = 10
    const stepDelay = 16 // ~one frame at 60fps
    for (let i = 1; i <= steps; i++) {
      const x = fromX + (toX - fromX) * (i / steps)
      const y = fromY + (toY - fromY) * (i / steps)
      await this.sendCDPCommand('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x, y, button: 'left'
      })
      if (i < steps) {
        await new Promise(r => setTimeout(r, stepDelay))
      }
    }

    await this.sendCDPCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: toX, y: toY, button: 'left', clickCount: 1
    })
  }

  // ============================================
  // Keyboard Input
  // ============================================

  /**
   * Press a keyboard key
   */
  async pressKey(key: string): Promise<void> {
    const keyInfo = parseKey(key)

    await this.sendCDPCommand('Input.dispatchKeyEvent', {
      type: 'keyDown',
      ...keyInfo
    })

    await this.sendCDPCommand('Input.dispatchKeyEvent', {
      type: 'keyUp',
      ...keyInfo
    })
  }

  /**
   * Type text character by character
   */
  async typeText(text: string): Promise<void> {
    await this.sendCDPCommand('Input.insertText', { text })
  }

  // ============================================
  // Screenshot
  // ============================================

  // Claude Vision recommended max dimension (aligned with renderer imageProcessor.ts)
  private static readonly SCREENSHOT_MAX_DIMENSION = 1568
  // Default JPEG quality for API transmission (balanced size vs clarity)
  private static readonly SCREENSHOT_DEFAULT_QUALITY = 80

  /**
   * Capture a screenshot with automatic compression for API transmission.
   *
   * Compression pipeline:
   *   1. CDP captures as JPEG by default (not PNG) with quality 80
   *   2. If the captured image exceeds 1568px on either axis, it is
   *      resized via Electron nativeImage to fit within that bound
   *   3. Output is always JPEG unless the caller explicitly requests PNG
   *
   * This keeps each screenshot at ~150-400KB instead of 1-3MB,
   * preventing Anthropic API 6MB request-body limit from being hit.
   */
  async captureScreenshot(options?: {
    format?: 'png' | 'jpeg' | 'webp'
    quality?: number
    fullPage?: boolean
    uid?: string
  }): Promise<{ data: string; mimeType: string }> {
    // Default to jpeg for much smaller payloads (was 'png')
    const format = options?.format || 'jpeg'
    // Quality only applies to jpeg and webp, not png
    const quality = format === 'png'
      ? undefined
      : (options?.quality || BrowserContext.SCREENSHOT_DEFAULT_QUALITY)

    // If uid provided, capture specific element
    if (options?.uid) {
      const element = this.getElementByUid(options.uid)
      if (!element) {
        throw new Error(`Element not found: ${options.uid}`)
      }

      const webContents = this.getWebContents()
      if (!webContents) {
        throw new Error('No active browser view')
      }

      await scrollIntoView(webContents, element.backendNodeId)
      const box = await getElementBoundingBox(webContents, element.backendNodeId)

      if (box) {
        const response = await this.sendCDPCommand<{ data: string }>('Page.captureScreenshot', {
          format,
          quality,
          clip: {
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
            scale: 1
          }
        })

        return this.compressScreenshot(response.data, format)
      }
    }

    // Full page or viewport screenshot
    const params: Record<string, unknown> = { format, quality }

    if (options?.fullPage) {
      // Get full page dimensions
      const metrics = await this.sendCDPCommand<{
        contentSize: { width: number; height: number }
      }>('Page.getLayoutMetrics')

      params.clip = {
        x: 0,
        y: 0,
        width: metrics.contentSize.width,
        height: metrics.contentSize.height,
        scale: 1
      }
      params.captureBeyondViewport = true
    }

    const response = await this.sendCDPCommand<{ data: string }>('Page.captureScreenshot', params)

    return this.compressScreenshot(response.data, format)
  }

  /**
   * Compress a raw CDP screenshot to fit within API size constraints.
   *
   * - Resizes if either dimension exceeds SCREENSHOT_MAX_DIMENSION (1568px)
   * - Converts to JPEG for consistent, compact output
   * - Falls back to original data if nativeImage processing fails
   */
  private compressScreenshot(
    base64Data: string,
    requestedFormat: string
  ): { data: string; mimeType: string } {
    try {
      const buf = Buffer.from(base64Data, 'base64')
      const img = nativeImage.createFromBuffer(buf)

      if (img.isEmpty()) {
        // nativeImage couldn't decode — return original data as-is
        return { data: base64Data, mimeType: this.getMimeType(requestedFormat) }
      }

      const { width, height } = img.getSize()
      const maxDim = BrowserContext.SCREENSHOT_MAX_DIMENSION
      const needsResize = width > maxDim || height > maxDim

      if (needsResize) {
        const ratio = Math.min(maxDim / width, maxDim / height)
        const resized = img.resize({
          width: Math.round(width * ratio),
          height: Math.round(height * ratio),
          quality: 'better'
        })
        const jpegBuf = resized.toJPEG(BrowserContext.SCREENSHOT_DEFAULT_QUALITY)
        return { data: jpegBuf.toString('base64'), mimeType: 'image/jpeg' }
      }

      // No resize needed — still convert to JPEG if not already
      if (requestedFormat !== 'jpeg') {
        const jpegBuf = img.toJPEG(BrowserContext.SCREENSHOT_DEFAULT_QUALITY)
        return { data: jpegBuf.toString('base64'), mimeType: 'image/jpeg' }
      }

      // Already JPEG and within size — return as-is
      return { data: base64Data, mimeType: 'image/jpeg' }
    } catch (error) {
      // Compression failed — return original to avoid breaking the tool
      console.warn('[AI Browser] Screenshot compression failed, using original:', error)
      return { data: base64Data, mimeType: this.getMimeType(requestedFormat) }
    }
  }

  private getMimeType(format: string): string {
    switch (format) {
      case 'jpeg': return 'image/jpeg'
      case 'webp': return 'image/webp'
      default: return 'image/png'
    }
  }

  // ============================================
  // Script Execution
  // ============================================

  /**
   * Evaluate JavaScript in the browser context
   */
  async evaluateScript<T = unknown>(script: string, args?: unknown[], timeout?: number): Promise<T> {
    // Always wrap script in a function call so arrow functions are invoked
    let expression: string
    if (args && args.length > 0) {
      const argsStr = args.map(a => JSON.stringify(a)).join(', ')
      expression = `(${script})(${argsStr})`
    } else {
      expression = `(${script})()`
    }

    const response = await this.sendCDPCommand<{
      result: { value?: T; type: string; description?: string }
      exceptionDetails?: { exception?: { description?: string } }
    }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    }, timeout ?? CDP_TIMEOUT)

    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description || 'Script execution failed'
      )
    }

    return response.result.value as T
  }

  // ============================================
  // Page State
  // ============================================

  /**
   * Get current page information
   */
  async getPageInfo(): Promise<{
    url: string
    title: string
    viewport: { width: number; height: number }
  }> {
    const webContents = this.getWebContents()
    if (!webContents) {
      throw new Error('No active browser view')
    }

    const metrics = await this.sendCDPCommand<{
      layoutViewport: { clientWidth: number; clientHeight: number }
    }>('Page.getLayoutMetrics')

    return {
      url: webContents.getURL(),
      title: webContents.getTitle(),
      viewport: {
        width: metrics.layoutViewport.clientWidth,
        height: metrics.layoutViewport.clientHeight
      }
    }
  }

  // ============================================
  // Wait Utilities
  // ============================================

  /**
   * Wait for text to appear on the page.
   * Uses polling with an overall timeout guard.
   */
  async waitForText(text: string, timeout: number = WAIT_TIMEOUT): Promise<void> {
    const deadline = Date.now() + timeout
    const pollInterval = 500

    while (Date.now() < deadline) {
      try {
        const snapshot = await withTimeout(
          this.createSnapshot(),
          Math.min(CDP_TIMEOUT, deadline - Date.now()),
          'waitForText snapshot'
        )
        if (snapshot.format().includes(text)) {
          return
        }
      } catch (_e) {
        // Snapshot may fail if page is navigating; ignore and retry
      }

      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      await new Promise(resolve => setTimeout(resolve, Math.min(pollInterval, remaining)))
    }

    throw new Error(`Timeout waiting for text: "${text}"`)
  }

  /**
   * Wait for an element matching a selector.
   * Uses polling with an overall timeout guard.
   */
  async waitForElement(selector: string, timeout: number = WAIT_TIMEOUT): Promise<void> {
    const deadline = Date.now() + timeout
    const pollInterval = 500

    while (Date.now() < deadline) {
      try {
        const result = await withTimeout(
          this.evaluateScript<boolean>(
            `!!document.querySelector("${selector.replace(/"/g, '\\"')}")`
          ),
          Math.min(CDP_TIMEOUT, deadline - Date.now()),
          'waitForElement evaluate'
        )
        if (result) {
          return
        }
      } catch (_e) {
        // Ignore and retry
      }

      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      await new Promise(resolve => setTimeout(resolve, Math.min(pollInterval, remaining)))
    }

    throw new Error(`Timeout waiting for element: "${selector}"`)
  }

  /**
   * Wait for the active page to finish loading.
   * Uses event-based waiting instead of a busy-wait polling loop.
   */
  async waitForNavigation(timeout: number = NAVIGATION_TIMEOUT): Promise<void> {
    const viewId = this.activeViewId
    if (!viewId) throw new Error('No active browser view')

    const state = browserViewManager.getState(viewId)
    if (state && !state.isLoading) return

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        // Resolve instead of reject - the page may still be usable
        resolve()
      }, timeout)

      const check = () => {
        const s = browserViewManager.getState(viewId)
        if (!s || !s.isLoading) {
          cleanup()
          resolve()
        }
      }

      const interval = setInterval(check, 200)

      const cleanup = () => {
        clearTimeout(timer)
        clearInterval(interval)
      }
    })
  }

  // ============================================
  // Emulation
  // ============================================

  /**
   * Set viewport size via CDP Emulation domain
   */
  async setViewportSize(width: number, height: number): Promise<void> {
    await this.sendCDPCommand('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: width,
      screenHeight: height
    })
  }

  // ============================================
  // Performance Tracing
  // ============================================

  // Standard trace categories (aligned with chrome-devtools-mcp)
  private static readonly TRACE_CATEGORIES = [
    '-*',
    'blink.console',
    'blink.user_timing',
    'devtools.timeline',
    'disabled-by-default-devtools.screenshot',
    'disabled-by-default-devtools.timeline',
    'disabled-by-default-devtools.timeline.invalidationTracking',
    'disabled-by-default-devtools.timeline.frame',
    'disabled-by-default-devtools.timeline.stack',
    'disabled-by-default-v8.cpu_profiler',
    'disabled-by-default-v8.cpu_profiler.hires',
    'latencyInfo',
    'loading',
    'disabled-by-default-lighthouse',
    'v8.execute',
    'v8'
  ]

  /**
   * Start performance tracing on the active page
   */
  async startPerformanceTrace(): Promise<void> {
    if (this.isTracing) {
      throw new Error('A performance trace is already running. Stop it first.')
    }
    await this.sendCDPCommand('Tracing.start', {
      categories: BrowserContext.TRACE_CATEGORIES.join(',')
    })
    this.isTracing = true
    this.traceStartTime = Date.now()
  }

  /**
   * Stop performance tracing and return duration + metrics
   */
  async stopPerformanceTrace(): Promise<{ duration: number; metrics: Record<string, number> }> {
    if (!this.isTracing) {
      throw new Error('No performance trace is running.')
    }
    await this.sendCDPCommand('Tracing.end')
    this.isTracing = false
    const duration = Date.now() - this.traceStartTime
    const metrics = await this.getPerformanceMetrics()
    return { duration, metrics }
  }

  /**
   * Whether a trace is currently running
   */
  isPerformanceTracing(): boolean {
    return this.isTracing
  }

  /**
   * Get CDP Performance.getMetrics as a key-value map
   */
  async getPerformanceMetrics(): Promise<Record<string, number>> {
    try {
      const result = await this.sendCDPCommand<{
        metrics: Array<{ name: string; value: number }>
      }>('Performance.getMetrics')
      const map: Record<string, number> = {}
      for (const m of result.metrics) {
        map[m.name] = m.value
      }
      return map
    } catch {
      return {}
    }
  }

  /**
   * Get the current page URL
   */
  getPageUrl(): string {
    const webContents = this.getWebContents()
    if (!webContents) throw new Error('No active browser view')
    return webContents.getURL()
  }

  // ============================================
  // Monitoring Control
  // ============================================

  /**
   * Enable all monitoring features
   */
  private async enableMonitoring(): Promise<void> {
    await this.enableNetworkMonitoring()
    await this.enableConsoleMonitoring()
    await this.enablePageDomain()
  }

  /**
   * Disable all monitoring features and cleanup debugger resources
   */
  private disableMonitoring(): void {
    const webContents = this.getWebContents()
    if (webContents && !webContents.isDestroyed()) {
      try {
        webContents.debugger.off('message', this.handleCDPMessage)
      } catch (_e) {
        // Listener may already be removed
      }

      try {
        if (this.networkEnabled) {
          webContents.debugger.sendCommand('Network.disable').catch(() => {})
        }
        if (this.consoleEnabled) {
          webContents.debugger.sendCommand('Runtime.disable').catch(() => {})
        }
        if (this.pageEnabled) {
          webContents.debugger.sendCommand('Page.disable').catch(() => {})
        }
      } catch (_e) {
        // Ignore errors during domain disable
      }

      try {
        webContents.debugger.detach()
      } catch (_e) {
        // Already detached or not attached
      }
    }

    this.networkEnabled = false
    this.consoleEnabled = false
    this.pageEnabled = false
    this.isTracing = false
    this.clearNetworkRequests()
    this.clearConsoleMessages()
  }

  /**
   * Register a view as owned by this context (for scoped cleanup).
   * Only applies to scoped (automation) contexts — the global singleton
   * used for interactive browsing is intentionally excluded so that
   * normal user browsing is unaffected.
   *
   * Automation views are muted, have autoplay blocked, and report
   * visibilityState='visible' regardless of the parent window's actual
   * visibility. This prevents sites like Xiaohongshu from detecting the
   * Electron window is in the background and auto-closing UI overlays
   * (e.g. comment input popups) via visibilitychange events.
   *
   * Two-layer media suppression (per-WebContents, not session-wide):
   *   1. Document layer — Page.addScriptToEvaluateOnNewDocument runs before any page
   *                       script, locking down HTMLMediaElement.autoplay and pausing
   *                       media on DOMContentLoaded (no race condition)
   *   2. Audio layer    — setAudioMuted(true) silences any audio that slips through
   */
  trackView(viewId: string): void {
    this.ownedViewIds.add(viewId)

    const wc = browserViewManager.getWebContents(viewId)
    if (!wc) return

    // Register webContents for download routing (both scoped and global contexts).
    // This enables the session-level will-download handler to route AI downloads
    // to the correct BrowserContext for silent saving.
    registerWebContentsForDownload(wc.id, this)

    // Guard: media suppression is only for automation (scoped) contexts.
    // The global singleton serves the user's interactive browser and must
    // not interfere with normal autoplay behaviour.
    if (!this._isScoped) return

    // Layer 2: mute audio output
    wc.setAudioMuted(true)

    // Layer 1: document-level startup script (no race condition).
    // Page.addScriptToEvaluateOnNewDocument executes before any page JS on
    // every navigation, so autoplay is blocked from the very first frame.
    const startupScript = `
      (function() {
        // Visibility: report 'visible' so sites don't collapse UI overlays
        // when the Electron window is in the background.
        Object.defineProperty(document, 'visibilityState', { get: function() { return 'visible'; }, configurable: true });
        Object.defineProperty(document, 'hidden', { get: function() { return false; }, configurable: true });

        // Autoplay: intercept the property at the prototype level so that any
        // assignment of autoplay=true on any current or future media element
        // is silently dropped.
        Object.defineProperty(HTMLMediaElement.prototype, 'autoplay', {
          get: function() { return false; },
          set: function() { /* block all autoplay */ },
          configurable: true
        });

        // Pause any media that already exists or gets added to the DOM.
        function pauseAll(root) {
          root.querySelectorAll('video, audio').forEach(function(el) { el.pause(); });
        }
        document.addEventListener('DOMContentLoaded', function() { pauseAll(document); }, true);
        var obs = new MutationObserver(function(mutations) {
          mutations.forEach(function(m) {
            m.addedNodes.forEach(function(n) {
              if (n.nodeType !== 1) return;
              if (n.tagName === 'VIDEO' || n.tagName === 'AUDIO') n.pause();
              else if (n.querySelectorAll) pauseAll(n);
            });
          });
        });
        // Observer starts immediately; document.body may not exist yet in
        // very early scripts, so defer to documentElement as fallback.
        var target = document.body || document.documentElement;
        if (target) obs.observe(target, { childList: true, subtree: true });
      })();
    `

    try { wc.debugger.attach('1.3') } catch (_) { /* already attached */ }
    wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: startupScript }).catch(() => {})
    // Apply immediately for the page that is already loaded when trackView is called.
    wc.executeJavaScript(startupScript).catch(() => {})
  }

  /**
   * Cleanup when context is destroyed.
   * Also destroys any BrowserViews created during this context's lifetime.
   */
  destroy(): void {
    this.disableMonitoring()

    // Unregister webContents from download routing before destroying views
    for (const viewId of this.ownedViewIds) {
      const wc = browserViewManager.getWebContents(viewId)
      if (wc && !wc.isDestroyed()) {
        unregisterWebContentsForDownload(wc.id)
      }
    }

    // Reject any pending download waiters
    for (const waiter of this.pendingDownloadResolvers) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('Context destroyed'))
    }
    this.pendingDownloadResolvers = []
    this.downloads.clear()

    // Destroy owned views (scoped contexts only -- singleton has no owned views)
    for (const viewId of this.ownedViewIds) {
      try {
        browserViewManager.destroy(viewId)
      } catch (_e) {
        // View may already be destroyed
      }
    }
    this.ownedViewIds.clear()

    this.activeViewId = null
    this.lastSnapshot = null
    this.mainWindow = null
    this.workDir = undefined
  }
}

// ============================================
// Key Parsing Utility
// ============================================

/**
 * Parse a key string into CDP key event parameters
 */
function parseKey(key: string): {
  key: string
  code: string
  modifiers?: number
  text?: string
} {
  // Handle special keys
  const specialKeys: Record<string, { key: string; code: string }> = {
    'Enter': { key: 'Enter', code: 'Enter' },
    'Tab': { key: 'Tab', code: 'Tab' },
    'Escape': { key: 'Escape', code: 'Escape' },
    'Backspace': { key: 'Backspace', code: 'Backspace' },
    'Delete': { key: 'Delete', code: 'Delete' },
    'ArrowUp': { key: 'ArrowUp', code: 'ArrowUp' },
    'ArrowDown': { key: 'ArrowDown', code: 'ArrowDown' },
    'ArrowLeft': { key: 'ArrowLeft', code: 'ArrowLeft' },
    'ArrowRight': { key: 'ArrowRight', code: 'ArrowRight' },
    'Home': { key: 'Home', code: 'Home' },
    'End': { key: 'End', code: 'End' },
    'PageUp': { key: 'PageUp', code: 'PageUp' },
    'PageDown': { key: 'PageDown', code: 'PageDown' },
    'Space': { key: ' ', code: 'Space' },
  }

  // Check for modifier+key combinations (e.g., "Control+a", "Shift+Tab")
  const parts = key.split('+')
  let modifiers = 0
  let actualKey = key

  if (parts.length > 1) {
    actualKey = parts[parts.length - 1]
    for (let i = 0; i < parts.length - 1; i++) {
      const mod = parts[i].toLowerCase()
      if (mod === 'control' || mod === 'ctrl') modifiers |= 2
      if (mod === 'shift') modifiers |= 8
      if (mod === 'alt') modifiers |= 1
      if (mod === 'meta' || mod === 'cmd' || mod === 'command') modifiers |= 4
    }
  }

  if (specialKeys[actualKey]) {
    return {
      ...specialKeys[actualKey],
      modifiers: modifiers || undefined
    }
  }

  // Regular character key
  return {
    key: actualKey,
    code: actualKey.length === 1 ? `Key${actualKey.toUpperCase()}` : actualKey,
    text: actualKey,
    modifiers: modifiers || undefined
  }
}

/**
 * Create a scoped BrowserContext for automation runs.
 *
 * A scoped context has its own activeViewId tracking (isolated from the global
 * singleton and other scoped contexts) but shares the same browserViewManager
 * and therefore the same Electron session (persist:browser) and cookies.
 *
 * Lifecycle: create before the run, call `destroy()` after the run.
 * `destroy()` also cleans up any BrowserViews created during the scope.
 */
export function createScopedBrowserContext(mainWindow: BrowserWindow | null): BrowserContext {
  const scoped = new BrowserContext()
  scoped.markAsScoped()
  if (mainWindow) {
    scoped.initialize(mainWindow)
  }
  return scoped
}

// Singleton instance (used for interactive user-facing browser)
export const browserContext = new BrowserContext()
