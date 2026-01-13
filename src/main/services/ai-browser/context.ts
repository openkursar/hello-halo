/**
 * Browser Context - Core context manager for AI Browser
 *
 * The BrowserContext is the central manager for AI Browser operations.
 * It provides:
 * - Access to the active BrowserView's WebContents
 * - CDP command execution
 * - Accessibility snapshot management
 * - Network and console monitoring
 * - Element interaction operations
 *
 * All AI Browser tools operate through this context.
 */

import { BrowserWindow } from 'electron'
import { browserViewManager } from '../browser-view.service'
import {
  createAccessibilitySnapshot,
  getElementBoundingBox,
  scrollIntoView,
  focusElement
} from './snapshot'
import type {
  BrowserContextInterface,
  AccessibilitySnapshot,
  AccessibilityNode,
  NetworkRequest,
  ConsoleMessage,
  DialogInfo
} from './types'

/**
 * BrowserContext - Manages the browser state for AI operations
 */
export class BrowserContext implements BrowserContextInterface {
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
   * Send a CDP command to the active browser
   */
  async sendCDPCommand<T = unknown>(
    method: string,
    params?: Record<string, unknown>
  ): Promise<T> {
    const webContents = this.getWebContents()
    if (!webContents) {
      throw new Error('No active browser view')
    }

    // Ensure debugger is attached
    try {
      webContents.debugger.attach('1.3')
    } catch (e) {
      // Already attached
    }

    return webContents.debugger.sendCommand(method, params) as Promise<T>
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
    for (const request of this.networkRequests.values()) {
      if (request.id === id) {
        return request
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
    await this.sendCDPCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: options?.dblClick ? 2 : 1
    })

    await this.sendCDPCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: options?.dblClick ? 2 : 1
    })
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

    // Perform drag operation
    await this.sendCDPCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: fromX,
      y: fromY,
      button: 'left',
      clickCount: 1
    })

    // Move in steps for smooth drag
    const steps = 10
    for (let i = 1; i <= steps; i++) {
      const x = fromX + (toX - fromX) * (i / steps)
      const y = fromY + (toY - fromY) * (i / steps)
      await this.sendCDPCommand('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x,
        y,
        button: 'left'
      })
    }

    await this.sendCDPCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: toX,
      y: toY,
      button: 'left',
      clickCount: 1
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

  /**
   * Capture a screenshot
   * Aligned with chrome-devtools-mcp: supports png, jpeg, webp formats
   */
  async captureScreenshot(options?: {
    format?: 'png' | 'jpeg' | 'webp'
    quality?: number
    fullPage?: boolean
    uid?: string
  }): Promise<{ data: string; mimeType: string }> {
    const format = options?.format || 'png'
    // Quality only applies to jpeg and webp, not png
    const quality = format === 'png' ? undefined : (options?.quality || 80)

    // Helper to get mime type
    const getMimeType = (fmt: string): string => {
      switch (fmt) {
        case 'jpeg': return 'image/jpeg'
        case 'webp': return 'image/webp'
        default: return 'image/png'
      }
    }

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

        return {
          data: response.data,
          mimeType: getMimeType(format)
        }
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

    return {
      data: response.data,
      mimeType: getMimeType(format)
    }
  }

  // ============================================
  // Script Execution
  // ============================================

  /**
   * Evaluate JavaScript in the browser context
   */
  async evaluateScript<T = unknown>(script: string, args?: unknown[]): Promise<T> {
    // Wrap script in a function call if args provided
    let expression = script
    if (args && args.length > 0) {
      const argsStr = args.map(a => JSON.stringify(a)).join(', ')
      expression = `(${script})(${argsStr})`
    }

    const response = await this.sendCDPCommand<{
      result: { value?: T; type: string; description?: string }
      exceptionDetails?: { exception?: { description?: string } }
    }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })

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
   * Wait for text to appear on the page
   */
  async waitForText(text: string, timeout: number = 30000): Promise<void> {
    const startTime = Date.now()
    const pollInterval = 500

    while (Date.now() - startTime < timeout) {
      const snapshot = await this.createSnapshot()
      const formattedText = snapshot.format()

      if (formattedText.includes(text)) {
        return
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval))
    }

    throw new Error(`Timeout waiting for text: "${text}"`)
  }

  /**
   * Wait for an element matching a selector
   */
  async waitForElement(selector: string, timeout: number = 30000): Promise<void> {
    const startTime = Date.now()
    const pollInterval = 500

    while (Date.now() - startTime < timeout) {
      try {
        const result = await this.evaluateScript<boolean>(
          `!!document.querySelector("${selector.replace(/"/g, '\\"')}")`
        )
        if (result) {
          return
        }
      } catch (e) {
        // Ignore errors and retry
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval))
    }

    throw new Error(`Timeout waiting for element: "${selector}"`)
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
  }

  /**
   * Disable all monitoring features and cleanup debugger resources
   */
  private disableMonitoring(): void {
    // Remove debugger event listener and detach to prevent memory leaks
    const webContents = this.getWebContents()
    if (webContents && !webContents.isDestroyed()) {
      try {
        // Remove the CDP message listener
        webContents.debugger.off('message', this.handleCDPMessage)
      } catch (e) {
        // Listener may already be removed
      }

      try {
        // Disable CDP domains before detaching
        if (this.networkEnabled) {
          webContents.debugger.sendCommand('Network.disable').catch(() => {})
        }
        if (this.consoleEnabled) {
          webContents.debugger.sendCommand('Runtime.disable').catch(() => {})
        }
      } catch (e) {
        // Ignore errors during domain disable
      }

      try {
        // Detach debugger to free resources
        webContents.debugger.detach()
      } catch (e) {
        // Already detached or not attached
      }
    }

    this.networkEnabled = false
    this.consoleEnabled = false
    this.clearNetworkRequests()
    this.clearConsoleMessages()
  }

  /**
   * Cleanup when context is destroyed
   */
  destroy(): void {
    this.disableMonitoring()
    this.activeViewId = null
    this.lastSnapshot = null
    this.mainWindow = null
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

// Singleton instance
export const browserContext = new BrowserContext()
