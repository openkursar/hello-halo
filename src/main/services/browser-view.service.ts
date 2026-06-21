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
 * - Window-level isolation: AI automation views are hosted on a separate
 *   hidden BrowserWindow to prevent lifecycle conflicts with user-visible views
 */

import { BrowserView, BrowserWindow } from 'electron'
import { isUrlAllowedByPolicy } from './browser-policy.service'

// ============================================
// Types
// ============================================

/** Device emulation mode for a browser view */
export type DeviceMode = 'pc' | 'h5'

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
  deviceMode: DeviceMode
  error?: string
  /** True when a navigation was blocked by browser policy. Used by renderer
   *  to show the policy-block overlay and by applyBounds() to keep the
   *  native BrowserView offscreen so the overlay is visible. */
  blockedByPolicy?: boolean
  /** Exact URL that was blocked. `state.url` can be stale here (e.g. a
   *  redirect block keeps the pre-redirect URL), so the overlay's
   *  "allow and retry" action needs the real target. */
  blockedUrl?: string
}

export interface BrowserViewBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserViewCreateOptions {
  /** When true, the view is hosted on a hidden offscreen window instead of the
   *  main window. Used by AI automation to isolate view lifecycle from the
   *  user-visible browser. Defaults to false. */
  offscreen?: boolean
  /** Initial device emulation mode. Defaults to 'pc'. */
  deviceMode?: DeviceMode
}

// ============================================
// Constants
// ============================================

// Desktop Chrome User-Agent to avoid detection as Electron app
export const CHROME_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// Mobile (H5) User-Agent — iPhone Safari is the safest default for mobile H5 pages.
// Most H5 sites are optimized for iOS Safari, making it the best emulation target.
export const H5_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

/**
 * Logical viewport width for H5 mode (iPhone 16 Pro Max points).
 * Exported so the renderer can position the visual frame to match.
 */
export const H5_VIEWPORT_WIDTH = 430

/** H5 (mobile) emulation — iPhone 16 Pro Max (430×932 pt, 3× scale) */
export const H5_DEVICE_METRICS = {
  width: 430,
  height: 0,          // 0 = auto: let the actual BrowserView height determine window.innerHeight
  deviceScaleFactor: 3,
  mobile: true,
  screenWidth: 430,
  screenHeight: 932,  // Physical screen height for CSS media queries
}

/** PC (desktop) emulation parameters — resets any prior mobile override */
export const PC_DEVICE_METRICS = {
  width: 1280,
  height: 720,
  deviceScaleFactor: 1,
  mobile: false,
  screenWidth: 1280,
  screenHeight: 720,
}

// ============================================
// Browser Policy Enforcement
// ============================================
// Policy evaluation (isUrlAllowedByPolicy and friends) lives in
// browser-policy.service.ts — this file only consumes the verdict.

/**
 * Stable error code attached to the create() rejection when the initial URL
 * is blocked by browser policy. The IPC layer forwards it so the renderer
 * can show the policy-block overlay (with "allow and retry") instead of a
 * generic creation error.
 */
export const BROWSER_POLICY_BLOCKED = 'BROWSER_POLICY_BLOCKED'

/** Build a short error string for state.error. */
function buildBlockedMessage(url: string): string {
  try {
    const { hostname } = new URL(url)
    return `Navigation to "${hostname}" blocked by browser policy`
  } catch {
    return 'Navigation blocked by browser policy'
  }
}

// ============================================
// BrowserView Manager
// ============================================

class BrowserViewManager {
  private views: Map<string, BrowserView> = new Map()
  private states: Map<string, BrowserViewState> = new Map()
  private mainWindow: BrowserWindow | null = null
  private activeViewId: string | null = null

  // Last visible bounds per view — used to restore position after policy-block hide.
  private lastBounds: Map<string, BrowserViewBounds> = new Map()

  // Hidden offscreen window that hosts AI automation BrowserViews.
  // Isolates AI view lifecycle from the user-visible mainWindow so that
  // creating/destroying AI views cannot corrupt the mainWindow's view list.
  private offscreenWindow: BrowserWindow | null = null
  // Track which views live on the offscreen window for correct cleanup.
  private offscreenViewIds: Set<string> = new Set()

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
   * Get or lazily create the hidden offscreen host window.
   *
   * This window is never shown to the user. Its sole purpose is to provide a
   * compositing surface for AI automation BrowserViews so that CDP commands
   * (e.g. Page.captureScreenshot) produce frames. The window itself loads no
   * content and consumes minimal memory (~10 MB).
   */
  private getOrCreateOffscreenWindow(): BrowserWindow {
    if (this.offscreenWindow && !this.offscreenWindow.isDestroyed()) {
      return this.offscreenWindow
    }

    this.offscreenWindow = new BrowserWindow({
      show: false,
      width: 1280,
      height: 720,
      webPreferences: {
        // Minimal prefs — this window never loads content itself
        nodeIntegration: false,
        contextIsolation: true,
      },
    })

    // Prevent from appearing in taskbar / dock
    this.offscreenWindow.setSkipTaskbar(true)

    // Handle unexpected close (e.g. OS kill)
    this.offscreenWindow.on('closed', () => {
      this.offscreenWindow = null
    })

    console.log('[BrowserView] Offscreen host window created for AI automation views')
    return this.offscreenWindow
  }

  /**
   * Create a new BrowserView
   */
  async create(viewId: string, url?: string, options?: BrowserViewCreateOptions): Promise<BrowserViewState> {
    const isOffscreen = options?.offscreen ?? false
    const deviceMode: DeviceMode = options?.deviceMode ?? 'pc'
    console.log(`[BrowserView] >>> create() called - viewId: ${viewId}, url: ${url}, offscreen: ${isOffscreen}, deviceMode: ${deviceMode}`)

    // Browser policy check — reject BEFORE creating any BrowserView.
    // The IPC handler returns { success: false, error, code } which the
    // renderer maps to the policy-block overlay (no BrowserView involved).
    if (url && !isUrlAllowedByPolicy(url)) {
      const msg = buildBlockedMessage(url)
      console.log(`[BrowserView] ${msg}`)
      const error = new Error(msg) as Error & { code?: string }
      error.code = BROWSER_POLICY_BLOCKED
      throw error
    }

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
        // Shared across mainWindow and offscreen window — login state is preserved.
        partition: 'persist:browser',
        // Enable smooth scrolling and other web features
        scrollBounce: true,
      },
    })
    console.log(`[BrowserView] BrowserView instance created`)

    // Set User-Agent based on device mode
    view.webContents.setUserAgent(deviceMode === 'h5' ? H5_USER_AGENT : CHROME_USER_AGENT)

    // Set background color to white (standard web)
    view.setBackgroundColor('#ffffff')

    // Attach to the appropriate host window so the Chromium compositor allocates
    // a compositing surface. Without this, CDP commands that need pixel output
    // (e.g. Page.captureScreenshot) will hang because no frames are produced.
    //
    // For user-visible views: attach to mainWindow at offscreen bounds;
    //   show() later repositions to visible bounds.
    // For AI automation views: attach to a dedicated hidden offscreen window
    //   to isolate lifecycle from the user's mainWindow.
    const hostWindow = isOffscreen
      ? this.getOrCreateOffscreenWindow()
      : this.mainWindow

    if (hostWindow && !hostWindow.isDestroyed()) {
      hostWindow.addBrowserView(view)
      // Offscreen window is hidden, so (0,0) is fine. User views start off-screen
      // and are repositioned by show().
      const initialBounds = isOffscreen
        ? { x: 0, y: 0, width: 1280, height: 720 }
        : { x: -10000, y: -10000, width: 1280, height: 720 }
      view.setBounds(initialBounds)
    }

    if (isOffscreen) {
      this.offscreenViewIds.add(viewId)
    }

    // Initialize state
    // Only set isLoading for real HTTP(S) URLs — about:blank / file: / etc. load instantly
    const needsLoading = !!url && (url.startsWith('http://') || url.startsWith('https://'))
    const state: BrowserViewState = {
      id: viewId,
      url: url || 'about:blank',
      title: 'New Tab',
      isLoading: needsLoading,
      canGoBack: false,
      canGoForward: false,
      zoomLevel: 1,
      isDevToolsOpen: false,
      deviceMode,
    }

    this.views.set(viewId, view)
    this.states.set(viewId, state)
    console.log(`[BrowserView] View stored in map, views count: ${this.views.size}`)

    // Bind events
    this.bindEvents(viewId, view)
    console.log(`[BrowserView] Events bound`)

    // NOTE: CDP device emulation (viewport/touch) is applied in bindEvents
    // after did-finish-load, not here. The WebContents debugger cannot be
    // attached before the first navigation completes.
    // UA is already set via setUserAgent() above — this handles server-side
    // UA detection without needing CDP.

    // Navigate to initial URL
    // (Policy check already happened at the top of create() — if we reach
    // here the URL is allowed or absent.)
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

    // Offscreen views live on a hidden window and must not be shown on mainWindow
    if (this.offscreenViewIds.has(viewId)) {
      console.warn(`[BrowserView] show() - Cannot show offscreen view on mainWindow: ${viewId}`)
      return false
    }

    // Defensive: if the native BrowserView object has been destroyed (e.g. by
    // a race condition), clean up the stale entry and bail out.
    try {
      if (view.webContents.isDestroyed()) {
        console.error(`[BrowserView] show() - View webContents already destroyed, cleaning up: ${viewId}`)
        this.cleanupStaleView(viewId)
        return false
      }
    } catch (e) {
      console.error(`[BrowserView] show() - View object destroyed, cleaning up: ${viewId}`)
      this.cleanupStaleView(viewId)
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

    // Set bounds with integer values (H5-aware, respects policy-block state)
    const intBounds = this.resolveBounds(viewId, bounds)
    console.log(`[BrowserView] Setting bounds:`, intBounds)
    this.applyBounds(viewId, intBounds)

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
    if (!view) return false

    // Remove from the correct host window
    const hostWindow = this.offscreenViewIds.has(viewId)
      ? this.offscreenWindow
      : this.mainWindow

    if (hostWindow && !hostWindow.isDestroyed()) {
      try {
        hostWindow.removeBrowserView(view)
      } catch (e) {
        // View might already be removed
      }
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

    this.applyBounds(viewId, this.resolveBounds(viewId, bounds))

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

    // Browser policy check
    if (!isUrlAllowedByPolicy(url)) {
      console.log(`[BrowserView] Navigation blocked by browser policy: ${url}`)
      this.updateState(viewId, {
        error: buildBlockedMessage(url),
        blockedByPolicy: true,
        blockedUrl: url,
        isLoading: false,
      })
      this.emitStateChangeImmediate(viewId)
      return false
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

    // Remove from the correct host window
    const isOffscreen = this.offscreenViewIds.has(viewId)
    const hostWindow = isOffscreen ? this.offscreenWindow : this.mainWindow

    if (hostWindow && !hostWindow.isDestroyed()) {
      try {
        hostWindow.removeBrowserView(view)
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
    this.lastBounds.delete(viewId)
    this.offscreenViewIds.delete(viewId)

    if (this.activeViewId === viewId) {
      this.activeViewId = null
    }
  }

  /**
   * Destroy all BrowserViews and the offscreen host window
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

    // Destroy the offscreen host window if it exists
    if (this.offscreenWindow && !this.offscreenWindow.isDestroyed()) {
      this.offscreenWindow.destroy()
    }
    this.offscreenWindow = null
    this.offscreenViewIds.clear()
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
        blockedByPolicy: false,
        blockedUrl: undefined,
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
        blockedByPolicy: false,
        blockedUrl: undefined,
      })
      // Use immediate emit for load finish - user needs to see content immediately
      this.emitStateChangeImmediate(viewId)

      // Apply CDP device emulation after page load — the debugger can only be
      // safely attached once the WebContents has a live renderer process.
      // UA is already set via setUserAgent(); this call handles viewport,
      // touch events and CSS media features for H5 mode.
      const state = this.states.get(viewId)
      if (state?.deviceMode === 'h5') {
        this.applyDeviceMode(viewId, 'h5').catch(err => {
          console.warn(`[BrowserView] did-finish-load applyDeviceMode failed:`, err)
        })
      }
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

    // Handle new window requests - open in same view (with policy check)
    wc.setWindowOpenHandler(({ url }) => {
      if (isUrlAllowedByPolicy(url)) {
        wc.loadURL(url)
      } else {
        console.log(`[BrowserView] window.open blocked by browser policy: ${url}`)
        this.updateState(viewId, { error: buildBlockedMessage(url), blockedByPolicy: true, blockedUrl: url })
        this.emitStateChangeImmediate(viewId)
      }
      return { action: 'deny' }
    })

    // Handle external protocol links & browser policy
    wc.on('will-navigate', (event, url) => {
      // Block non-standard protocols (javascript:, data:, etc.)
      if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('file://')) {
        event.preventDefault()
        return
      }
      // Browser policy check for page-initiated navigations
      if (!isUrlAllowedByPolicy(url)) {
        event.preventDefault()
        console.log(`[BrowserView] will-navigate blocked by browser policy: ${url}`)
        this.updateState(viewId, { error: buildBlockedMessage(url), blockedByPolicy: true, blockedUrl: url })
        this.emitStateChangeImmediate(viewId)
      }
    })

    // Block server-side redirects (301/302) to disallowed domains
    wc.on('will-redirect', (event, url) => {
      if (!isUrlAllowedByPolicy(url)) {
        event.preventDefault()
        console.log(`[BrowserView] will-redirect blocked by browser policy: ${url}`)
        this.updateState(viewId, { error: buildBlockedMessage(url), blockedByPolicy: true, blockedUrl: url, isLoading: false })
        this.emitStateChangeImmediate(viewId)
      }
    })
  }

  /**
   * Update state.
   *
   * When blockedByPolicy transitions, applyBounds() is called to move the
   * BrowserView offscreen (blocked) or restore it to visible bounds (unblocked).
   * This is the ONLY place that sets blockedByPolicy — all policy-block callers
   * set error + blockedByPolicy together via this method.
   */
  private updateState(viewId: string, updates: Partial<BrowserViewState>) {
    const state = this.states.get(viewId)
    if (!state) return

    const wasPolicyBlocked = !!state.blockedByPolicy
    Object.assign(state, updates)

    // On policy-block transition, re-apply bounds to move view offscreen or restore it
    if (wasPolicyBlocked !== !!state.blockedByPolicy) {
      const bounds = this.lastBounds.get(viewId)
      if (bounds && !this.offscreenViewIds.has(viewId)) {
        this.applyBounds(viewId, bounds)
      }
    }
  }

  /**
   * Single exit point for setBounds — arbitrates between tab-switch visibility
   * and policy-block visibility. Always records lastBounds for later restore.
   */
  private applyBounds(viewId: string, bounds: BrowserViewBounds) {
    const view = this.views.get(viewId)
    const state = this.states.get(viewId)
    if (!view) return

    this.lastBounds.set(viewId, bounds)

    if (state?.blockedByPolicy) {
      view.setBounds({ x: -10000, y: -10000, width: 0, height: 0 })
    } else {
      view.setBounds(bounds)
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
  // Internal Helpers
  // ============================================

  /**
   * Resolve the actual integer bounds to apply to a BrowserView.
   *
   * In H5 mode the view is constrained to H5_VIEWPORT_WIDTH pixels and
   * centered horizontally within the container bounds passed from the renderer.
   * In PC mode the view fills the container exactly.
   *
   * This is the single source of truth for H5 positioning, called from both
   * show() and resize() so layout stays consistent across all code paths.
   */
  private resolveBounds(viewId: string, containerBounds: BrowserViewBounds): {
    x: number; y: number; width: number; height: number
  } {
    const state = this.states.get(viewId)
    const isH5 = state?.deviceMode === 'h5'

    if (isH5) {
      const phoneWidth = Math.min(H5_VIEWPORT_WIDTH, Math.round(containerBounds.width))
      const centeredX = Math.round(containerBounds.x + (containerBounds.width - phoneWidth) / 2)
      return {
        x: centeredX,
        y: Math.round(containerBounds.y),
        width: phoneWidth,
        height: Math.round(containerBounds.height),
      }
    }

    return {
      x: Math.round(containerBounds.x),
      y: Math.round(containerBounds.y),
      width: Math.round(containerBounds.width),
      height: Math.round(containerBounds.height),
    }
  }

  /**
   * Remove a stale view entry whose native object has been destroyed.
   * Called defensively when we detect a destroyed webContents.
   */
  private cleanupStaleView(viewId: string) {
    const timer = this.stateChangeDebounceTimers.get(viewId)
    if (timer) {
      clearTimeout(timer)
      this.stateChangeDebounceTimers.delete(viewId)
    }
    this.views.delete(viewId)
    this.states.delete(viewId)
    this.lastBounds.delete(viewId)
    this.offscreenViewIds.delete(viewId)
    if (this.activeViewId === viewId) {
      this.activeViewId = null
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

  /**
   * Reverse lookup: find the viewId that owns a given webContents ID.
   * Used by the download handler to route downloads to the correct BrowserContext.
   */
  findViewIdByWebContentsId(wcId: number): string | null {
    for (const [viewId, view] of this.views) {
      if (!view.webContents.isDestroyed() && view.webContents.id === wcId) {
        return viewId
      }
    }
    return null
  }

  /**
   * Check if a viewId belongs to an AI-created view (prefix: "ai-browser-").
   */
  isAIView(viewId: string): boolean {
    return viewId.startsWith('ai-browser-')
  }

  /**
   * Switch device emulation mode for a view.
   *
   * Applies the full set of CDP commands required to faithfully reproduce what
   * Chrome DevTools' "Toggle Device Toolbar" does:
   *   - Emulation.setDeviceMetricsOverride (viewport + mobile flag)
   *   - WebContents.setUserAgent          (UA string)
   *   - Emulation.setTouchEmulationEnabled
   *   - Emulation.setEmitTouchEventsForMouse
   *   - Emulation.setEmulatedMedia        (hover:none / pointer:coarse for h5)
   *
   * Then reloads the page so the server sees the new UA on the next request
   * and the renderer starts fresh with the correct viewport.
   */
  async setDeviceMode(viewId: string, mode: DeviceMode): Promise<boolean> {
    const view = this.views.get(viewId)
    const state = this.states.get(viewId)
    if (!view || !state) return false

    console.log(`[BrowserView] setDeviceMode: viewId=${viewId}, mode=${mode}`)

    try {
      // 1. Switch UA on the webContents object (affects subsequent navigations
      //    at the Electron level, independent of CDP).
      view.webContents.setUserAgent(mode === 'h5' ? H5_USER_AGENT : CHROME_USER_AGENT)

      // 2. Apply full CDP emulation set
      await this.applyDeviceMode(viewId, mode)

      // 3. Persist mode in state and notify renderer
      state.deviceMode = mode
      this.emitStateChangeImmediate(viewId)

      // 4. Reload so the server receives the new UA and the page re-renders
      //    with the correct viewport from the very first paint.
      view.webContents.reload()

      console.log(`[BrowserView] setDeviceMode success: viewId=${viewId}, mode=${mode}`)
      return true
    } catch (error) {
      console.error(`[BrowserView] setDeviceMode failed:`, error)
      return false
    }
  }

  /**
   * Apply all CDP commands for a device mode to the active debugger session.
   * Called both on view creation and on mode switch.
   * Does NOT reload — callers decide whether a reload is needed.
   */
  private async applyDeviceMode(viewId: string, mode: DeviceMode): Promise<void> {
    const view = this.views.get(viewId)
    if (!view) return

    const wc = view.webContents
    const isH5 = mode === 'h5'
    const metrics = isH5 ? H5_DEVICE_METRICS : PC_DEVICE_METRICS

    try {
      // Attach debugger if not already attached
      if (!wc.debugger.isAttached()) {
        wc.debugger.attach('1.3')
      }

      // Viewport + mobile rendering flag
      await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', metrics)

      // Touch events
      await wc.debugger.sendCommand('Emulation.setTouchEmulationEnabled', {
        enabled: isH5,
        maxTouchPoints: isH5 ? 5 : 0,
      })
      await wc.debugger.sendCommand('Emulation.setEmitTouchEventsForMouse', {
        enabled: isH5,
        configuration: isH5 ? 'mobile' : 'desktop',
      })

      // CSS media features — hover and pointer must be set explicitly;
      // they are NOT automatically updated by setDeviceMetricsOverride.
      await wc.debugger.sendCommand('Emulation.setEmulatedMedia', {
        features: isH5
          ? [
              { name: 'hover', value: 'none' },
              { name: 'pointer', value: 'coarse' },
            ]
          : [
              { name: 'hover', value: 'hover' },
              { name: 'pointer', value: 'fine' },
            ],
      })

      console.log(`[BrowserView] applyDeviceMode CDP commands sent: viewId=${viewId}, mode=${mode}`)
    } catch (error) {
      // CDP errors are non-fatal at creation time (debugger may not be ready yet
      // for brand-new views — the navigation itself will still use the correct UA).
      console.warn(`[BrowserView] applyDeviceMode CDP warning (non-fatal): viewId=${viewId}`, error)
    }
  }
}

// Singleton instance
export const browserViewManager = new BrowserViewManager()
