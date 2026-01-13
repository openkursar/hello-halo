/**
 * BrowserView Service - Manages embedded browser views
 *
 * This service creates and manages BrowserView instances for the Content Canvas,
 * enabling true browser functionality within Halo - like having Chrome embedded
 * in the app.
 *
 * Key features:
 * - Multiple concurrent BrowserViews (one per tab)
 * - Full Chromium rendering with network capabilities
 * - Security isolation (sandbox mode)
 * - State tracking (URL, title, loading, navigation history)
 * - AI-ready (screenshot capture, JS execution)
 */

import { BrowserView, BrowserWindow } from 'electron'

// ============================================
// Types
// ============================================

export interface BrowserViewState {
  id: string
  url: string
  title: string
  favicon?: string // base64 data URL
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  zoomLevel: number
  isDevToolsOpen: boolean
  error?: string
}

export interface BrowserViewBounds {
  x: number
  y: number
  width: number
  height: number
}

// ============================================
// Constants
// ============================================

// Chrome User-Agent to avoid detection as Electron app
const CHROME_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// ============================================
// BrowserView Manager
// ============================================

class BrowserViewManager {
  private views: Map<string, BrowserView> = new Map()
  private states: Map<string, BrowserViewState> = new Map()
  private mainWindow: BrowserWindow | null = null
  private activeViewId: string | null = null

  // Debounce timers for state change events
  // This prevents flooding the renderer with too many IPC messages during rapid navigation
  private stateChangeDebounceTimers: Map<string, NodeJS.Timeout> = new Map()
  private static readonly STATE_CHANGE_DEBOUNCE_MS = 50 // 50ms debounce

  /**
   * Initialize the manager with the main window
   */
  initialize(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow

    // Clean up views when window is closed
    mainWindow.on('closed', () => {
      this.destroyAll()
    })
  }

  /**
   * Create a new BrowserView
   */
  async create(viewId: string, url?: string): Promise<BrowserViewState> {
    console.log(`[BrowserView] >>> create() called - viewId: ${viewId}, url: ${url}`)

    // Don't create duplicate views
    if (this.views.has(viewId)) {
      console.log(`[BrowserView] View already exists, returning existing state`)
      return this.states.get(viewId)!
    }

    console.log(`[BrowserView] Creating new BrowserView...`)
    const view = new BrowserView({
      webPreferences: {
        sandbox: true, // Security: enable sandbox for external content
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        // Persistent storage for cookies, localStorage, etc.
        partition: 'persist:browser',
        // Enable smooth scrolling and other web features
        scrollBounce: true,
      },
    })
    console.log(`[BrowserView] BrowserView instance created`)

    // Set Chrome User-Agent to avoid detection
    view.webContents.setUserAgent(CHROME_USER_AGENT)

    // Set background color to white (standard web)
    view.setBackgroundColor('#ffffff')

    // Initialize state
    const state: BrowserViewState = {
      id: viewId,
      url: url || 'about:blank',
      title: 'New Tab',
      isLoading: !!url,
      canGoBack: false,
      canGoForward: false,
      zoomLevel: 1,
      isDevToolsOpen: false,
    }

    this.views.set(viewId, view)
    this.states.set(viewId, state)
    console.log(`[BrowserView] View stored in map, views count: ${this.views.size}`)

    // Bind events
    this.bindEvents(viewId, view)
    console.log(`[BrowserView] Events bound`)

    // Navigate to initial URL
    if (url) {
      try {
        console.log(`[BrowserView] Loading URL: ${url}`)
        await view.webContents.loadURL(url)
        console.log(`[BrowserView] URL loaded successfully`)
      } catch (error) {
        console.error(`[BrowserView] Failed to load URL: ${url}`, error)
        state.error = (error as Error).message
        state.isLoading = false
      }
    }

    console.log(`[BrowserView] <<< create() returning state:`, JSON.stringify(state, null, 2))
    return state
  }

  /**
   * Show a BrowserView at specified bounds
   */
  show(viewId: string, bounds: BrowserViewBounds) {
    console.log(`[BrowserView] >>> show() called - viewId: ${viewId}, bounds:`, bounds)

    const view = this.views.get(viewId)
    if (!view) {
      console.error(`[BrowserView] show() - View not found: ${viewId}`)
      return false
    }
    if (!this.mainWindow) {
      console.error(`[BrowserView] show() - mainWindow is null`)
      return false
    }

    // Hide currently active view first
    if (this.activeViewId && this.activeViewId !== viewId) {
      console.log(`[BrowserView] Hiding previous active view: ${this.activeViewId}`)
      this.hide(this.activeViewId)
    }

    // Add to window
    console.log(`[BrowserView] Adding BrowserView to window...`)
    this.mainWindow.addBrowserView(view)
    console.log(`[BrowserView] BrowserView added to window`)

    // Set bounds with integer values
    const intBounds = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    }
    console.log(`[BrowserView] Setting bounds:`, intBounds)
    view.setBounds(intBounds)

    // Auto-resize with window (only width and height, not position)
    view.setAutoResize({
      width: false,
      height: false,
      horizontal: false,
      vertical: false,
    })

    this.activeViewId = viewId
    console.log(`[BrowserView] <<< show() success - activeViewId: ${this.activeViewId}`)
    return true
  }

  /**
   * Hide a BrowserView (remove from window but keep in memory)
   */
  hide(viewId: string) {
    const view = this.views.get(viewId)
    if (!view || !this.mainWindow) return false

    try {
      this.mainWindow.removeBrowserView(view)
    } catch (e) {
      // View might already be removed
    }

    if (this.activeViewId === viewId) {
      this.activeViewId = null
    }

    return true
  }

  /**
   * Resize a BrowserView
   */
  resize(viewId: string, bounds: BrowserViewBounds) {
    const view = this.views.get(viewId)
    if (!view) return false

    view.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    })

    return true
  }

  /**
   * Navigate to a URL
   */
  async navigate(viewId: string, input: string): Promise<boolean> {
    const view = this.views.get(viewId)
    if (!view) return false

    // Process input - could be URL or search query
    let url = input.trim()

    if (!url) return false

    // Check if it's already a valid URL
    if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('file://')) {
      // Check if it looks like a domain
      if (url.includes('.') && !url.includes(' ') && this.looksLikeDomain(url)) {
        url = 'https://' + url
      } else {
        // Treat as search query
        url = `https://www.google.com/search?q=${encodeURIComponent(url)}`
      }
    }

    try {
      await view.webContents.loadURL(url)
      return true
    } catch (error) {
      console.error(`[BrowserView] Navigation failed: ${url}`, error)
      this.updateState(viewId, {
        error: (error as Error).message,
        isLoading: false,
      })
      this.emitStateChange(viewId)
      return false
    }
  }

  /**
   * Check if input looks like a domain
   */
  private looksLikeDomain(input: string): boolean {
    // Common TLDs
    const tlds = ['com', 'org', 'net', 'io', 'dev', 'co', 'ai', 'app', 'cn', 'uk', 'de', 'fr', 'jp']
    const parts = input.split('.')
    if (parts.length < 2) return false
    const lastPart = parts[parts.length - 1].toLowerCase()
    return tlds.includes(lastPart) || lastPart.length === 2
  }

  /**
   * Navigation: Go back
   */
  goBack(viewId: string): boolean {
    const view = this.views.get(viewId)
    if (!view || !view.webContents.canGoBack()) return false
    view.webContents.goBack()
    return true
  }

  /**
   * Navigation: Go forward
   */
  goForward(viewId: string): boolean {
    const view = this.views.get(viewId)
    if (!view || !view.webContents.canGoForward()) return false
    view.webContents.goForward()
    return true
  }

  /**
   * Navigation: Reload
   */
  reload(viewId: string): boolean {
    const view = this.views.get(viewId)
    if (!view) return false
    view.webContents.reload()
    return true
  }

  /**
   * Navigation: Stop loading
   */
  stop(viewId: string): boolean {
    const view = this.views.get(viewId)
    if (!view) return false
    view.webContents.stop()
    return true
  }

  /**
   * Capture screenshot of the view
   */
  async capture(viewId: string): Promise<string | null> {
    const view = this.views.get(viewId)
    if (!view) return null

    try {
      const image = await view.webContents.capturePage()
      return image.toDataURL()
    } catch (error) {
      console.error('[BrowserView] Screenshot failed:', error)
      return null
    }
  }

  /**
   * Execute JavaScript in the view
   */
  async executeJS(viewId: string, code: string): Promise<unknown> {
    const view = this.views.get(viewId)
    if (!view) return null

    try {
      return await view.webContents.executeJavaScript(code)
    } catch (error) {
      console.error('[BrowserView] JS execution failed:', error)
      return null
    }
  }

  /**
   * Set zoom level
   */
  setZoom(viewId: string, level: number): boolean {
    const view = this.views.get(viewId)
    if (!view) return false

    // Clamp zoom level
    const clampedLevel = Math.max(0.25, Math.min(5, level))
    view.webContents.setZoomFactor(clampedLevel)
    this.updateState(viewId, { zoomLevel: clampedLevel })
    this.emitStateChange(viewId)
    return true
  }

  /**
   * Toggle DevTools
   */
  toggleDevTools(viewId: string): boolean {
    const view = this.views.get(viewId)
    if (!view) return false

    if (view.webContents.isDevToolsOpened()) {
      view.webContents.closeDevTools()
      this.updateState(viewId, { isDevToolsOpen: false })
    } else {
      view.webContents.openDevTools({ mode: 'detach' })
      this.updateState(viewId, { isDevToolsOpen: true })
    }
    this.emitStateChange(viewId)
    return true
  }

  /**
   * Get current state of a view
   */
  getState(viewId: string): BrowserViewState | null {
    return this.states.get(viewId) || null
  }

  /**
   * Destroy a specific BrowserView
   */
  destroy(viewId: string) {
    const view = this.views.get(viewId)
    if (!view) return

    // Clear any pending debounce timer for this view
    const timer = this.stateChangeDebounceTimers.get(viewId)
    if (timer) {
      clearTimeout(timer)
      this.stateChangeDebounceTimers.delete(viewId)
    }

    // Remove from window
    if (this.mainWindow) {
      try {
        this.mainWindow.removeBrowserView(view)
      } catch (e) {
        // Already removed
      }
    }

    // Close webContents
    try {
      ;(view.webContents as any).destroy()
    } catch (e) {
      // Already destroyed
    }

    // Clean up maps
    this.views.delete(viewId)
    this.states.delete(viewId)

    if (this.activeViewId === viewId) {
      this.activeViewId = null
    }
  }

  /**
   * Destroy all BrowserViews
   */
  destroyAll() {
    // Clear all debounce timers
    for (const timer of this.stateChangeDebounceTimers.values()) {
      clearTimeout(timer)
    }
    this.stateChangeDebounceTimers.clear()

    for (const viewId of this.views.keys()) {
      this.destroy(viewId)
    }
  }

  /**
   * Bind WebContents events
   */
  private bindEvents(viewId: string, view: BrowserView) {
    const wc = view.webContents

    // Navigation start - immediate emit for responsive UI feedback
    wc.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
      if (!isMainFrame) return

      this.updateState(viewId, {
        url,
        isLoading: true,
        error: undefined,
      })
      // Use immediate emit for navigation start - user needs to see loading indicator
      this.emitStateChangeImmediate(viewId)
    })

    // Navigation finished - immediate emit for responsive UI feedback
    wc.on('did-finish-load', () => {
      this.updateState(viewId, {
        isLoading: false,
        canGoBack: wc.canGoBack(),
        canGoForward: wc.canGoForward(),
        error: undefined,
      })
      // Use immediate emit for load finish - user needs to see content immediately
      this.emitStateChangeImmediate(viewId)
    })

    // Navigation failed - immediate emit
    wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return

      // Ignore aborted loads (user navigation)
      if (errorCode === -3) return

      this.updateState(viewId, {
        isLoading: false,
        error: errorDescription || `Error ${errorCode}`,
      })
      this.emitStateChangeImmediate(viewId)
    })

    // Title updated - debounced (can happen frequently during SPA navigation)
    wc.on('page-title-updated', (_event, title) => {
      this.updateState(viewId, { title })
      this.emitStateChange(viewId) // debounced
    })

    // Favicon updated - debounced (not urgent)
    wc.on('page-favicon-updated', (_event, favicons) => {
      if (favicons.length > 0) {
        this.updateState(viewId, { favicon: favicons[0] })
        this.emitStateChange(viewId) // debounced
      }
    })

    // URL changed (for SPA navigation) - debounced (can happen very frequently)
    wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame) return

      this.updateState(viewId, {
        url,
        canGoBack: wc.canGoBack(),
        canGoForward: wc.canGoForward(),
      })
      this.emitStateChange(viewId) // debounced
    })

    // Handle new window requests - open in same view
    wc.setWindowOpenHandler(({ url }) => {
      // Load in current view instead of opening new window
      wc.loadURL(url)
      return { action: 'deny' }
    })

    // Handle external protocol links
    wc.on('will-navigate', (event, url) => {
      // Allow http/https/file protocols, block others (like javascript:, data:, etc.)
      if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('file://')) {
        event.preventDefault()
      }
    })
  }

  /**
   * Update state
   */
  private updateState(viewId: string, updates: Partial<BrowserViewState>) {
    const state = this.states.get(viewId)
    if (state) {
      Object.assign(state, updates)
    }
  }

  /**
   * Emit state change event to renderer (debounced)
   * Uses debouncing to prevent flooding the renderer with too many IPC messages
   * during rapid state changes (e.g., fast navigation, SPA route changes)
   */
  private emitStateChange(viewId: string) {
    // Clear existing debounce timer for this view
    const existingTimer = this.stateChangeDebounceTimers.get(viewId)
    if (existingTimer) {
      clearTimeout(existingTimer)
    }

    // Set new debounce timer
    const timer = setTimeout(() => {
      this.stateChangeDebounceTimers.delete(viewId)
      this.doEmitStateChange(viewId)
    }, BrowserViewManager.STATE_CHANGE_DEBOUNCE_MS)

    this.stateChangeDebounceTimers.set(viewId, timer)
  }

  /**
   * Emit state change event immediately (no debounce)
   * Used for critical state changes that need immediate UI feedback
   */
  private emitStateChangeImmediate(viewId: string) {
    // Clear any pending debounced emit for this view
    const existingTimer = this.stateChangeDebounceTimers.get(viewId)
    if (existingTimer) {
      clearTimeout(existingTimer)
      this.stateChangeDebounceTimers.delete(viewId)
    }

    this.doEmitStateChange(viewId)
  }

  /**
   * Actually emit the state change event
   */
  private doEmitStateChange(viewId: string) {
    const state = this.states.get(viewId)
    if (state && this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('browser:state-change', {
        viewId,
        state: { ...state },
      })
    }
  }

  // ============================================
  // AI Browser Integration Methods
  // ============================================

  /**
   * Get WebContents for a view (used by AI Browser for CDP commands)
   */
  getWebContents(viewId: string): Electron.WebContents | null {
    const view = this.views.get(viewId)
    return view?.webContents || null
  }

  /**
   * Get all view states (used by AI Browser for listing pages)
   */
  getAllStates(): Array<BrowserViewState & { id: string }> {
    const states: Array<BrowserViewState & { id: string }> = []
    for (const [id, state] of this.states) {
      states.push({ ...state, id })
    }
    return states
  }

  /**
   * Get the currently active view ID
   */
  getActiveViewId(): string | null {
    return this.activeViewId
  }

  /**
   * Set a view as active (used by AI Browser when selecting pages)
   */
  setActiveView(viewId: string): boolean {
    if (!this.views.has(viewId)) return false
    this.activeViewId = viewId
    return true
  }
}

// Singleton instance
export const browserViewManager = new BrowserViewManager()
