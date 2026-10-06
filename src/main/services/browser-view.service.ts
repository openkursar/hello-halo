/** Browser page state and policy, independent of the guest's DOM host. */

import { BrowserWindow, type WebContents } from 'electron'
import { browserHostManager, captureBrowserPage } from './browser-host'
import { isUrlAllowedByPolicy } from './browser-policy.service'
import { resolveUserAgent } from './user-agent-resolver'
import { getConfig, onBrowserConfigChange } from '../foundation/config.service'

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
  /** Policy blocks park the guest so the host can show its recovery controls. */
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
  /** Background-only pages cannot be displayed or transferred to the main host. */
  offscreen?: boolean
  /** Initial device emulation mode. Defaults to 'pc'. */
  deviceMode?: DeviceMode
}

// ============================================
// Constants
// ============================================

// Re-exported for backward compatibility with existing importers.
export { CHROME_USER_AGENT, H5_USER_AGENT } from './user-agent-resolver'

/**
 * Logical viewport width for H5 mode (iPhone 16 Pro Max points).
 * Exported so the renderer can position the visual frame to match.
 */
export const H5_VIEWPORT_WIDTH = 430

/** H5 (mobile) emulation — iPhone 16 Pro Max (430×932 pt, 3× scale) */
export const H5_DEVICE_METRICS = {
  width: 430,
  height: 0,          // 0 = auto: let the actual guest height determine window.innerHeight
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

function schemeOf(url: string): string {
  try {
    return new URL(url).protocol
  } catch {
    return ''
  }
}

/**
 * What a page may open in its own view: a web address from any page, a local
 * file only from a local page — the rule browsers apply. A popup is loaded by
 * the main process, which the renderer's own check never sees.
 */
export function popupTargetAllowed(target: string, opener: string): boolean {
  const scheme = schemeOf(target)
  if (scheme === 'http:' || scheme === 'https:' || target === 'about:blank') return true
  return scheme === 'file:' && schemeOf(opener) === 'file:'
}

function wasNavigationCancelled(error: unknown): boolean {
  const failure = error as { code?: string; errno?: number }
  return failure?.code === 'ERR_ABORTED' || failure?.errno === -3
}

function navigationFailureDetails(error: unknown): unknown {
  if (!(error instanceof Error)) return { errorType: typeof error }
  const failure = error as Error & { code?: string; errno?: number }
  return { code: failure.code, errno: failure.errno, stack: failure.stack?.split('\n').slice(1).join('\n') }
}

// ============================================
// Browser page manager
// ============================================

class BrowserPageManager {
  private views = new Map<string, { webContents: WebContents }>()
  private pendingCreates = new Map<string, Promise<BrowserViewState>>()
  private states: Map<string, BrowserViewState> = new Map()
  private mainWindow: BrowserWindow | null = null
  private activeViewId: string | null = null
  private displayedViewId: string | null = null

  // Last visible bounds per view — used to restore position after policy-block hide.
  private lastBounds: Map<string, BrowserViewBounds> = new Map()

  private destroyedListeners: Set<(viewId: string, webContentsId?: number) => void> = new Set()

  // Debounce timers for state change events
  // This prevents flooding the renderer with too many IPC messages during rapid navigation
  private stateChangeDebounceTimers: Map<string, NodeJS.Timeout> = new Map()
  private static readonly STATE_CHANGE_DEBOUNCE_MS = 50 // 50ms debounce

  // Guards against duplicate registration of the browser-config-change handler
  // when initialize() is called more than once (defensive — currently the app
  // lifecycle calls it exactly once, but this prevents a subtle leak if that
  // assumption changes).
  private browserConfigChangeRegistered = false
  // Last applied custom UA — used to detect whether a browser-config change
  // actually altered the UA before triggering view reloads. Without this,
  // unrelated browser-config writes (e.g. customAllowlist edits) would force
  // every open page to reload.
  private lastAppliedUserAgent: string | undefined

  /**
   * Initialize the manager with the main window
   */
  initialize(mainWindow: BrowserWindow) {
    if (this.mainWindow === mainWindow) return
    this.mainWindow = mainWindow
    this.lastAppliedUserAgent = getConfig().browser?.userAgent
    browserHostManager.initialize(mainWindow)

    // Clean up views when window is closed
    mainWindow.on('closed', () => {
      this.destroyAll()
    })

    // Issue #124: apply a newly-saved custom User-Agent to all active views
    // immediately, without requiring a page reload or app restart. Only fires
    // when the UA string actually changes — other browser-config fields
    // (customAllowlist, etc.) must not trigger view reloads.
    if (!this.browserConfigChangeRegistered) {
      onBrowserConfigChange((browser) => {
        const next = browser?.userAgent
        if (next === this.lastAppliedUserAgent) return
        this.lastAppliedUserAgent = next
        this.applyUserAgentToAll(next)
      })
      this.browserConfigChangeRegistered = true
    }
  }

  /**
   * Apply a (possibly new) User-Agent to every active browser page. Called by
   * the browser-config-change subscriber when the user edits the UA in
   * Settings. Each active page is reloaded so `navigator.userAgent` picks up
   * the new value — Chromium caches the UA at page-init time, so
   * `setUserAgent()` alone does not update `navigator.userAgent` for an
   * already-loaded page until it reloads. This mirrors the behavior of
   * `setDeviceMode()`, which also reloads after changing the UA.
   */
  applyUserAgentToAll(customUserAgent: string | undefined): void {
    for (const [viewId, view] of this.views) {
      const state = this.states.get(viewId)
      if (!state || view.webContents.isDestroyed()) continue
      try {
        view.webContents.setUserAgent(
          resolveUserAgent(customUserAgent, state.deviceMode)
        )
        // Reload: setUserAgent() updates HTTP headers but navigator.userAgent
        // is cached at page-init (see method JSDoc).
        if (state.url && state.url !== 'about:blank') {
          view.webContents.reload()
        }
      } catch (e) {
        console.error(`[Browser] Failed to apply UA to view ${viewId}:`, e)
      }
    }
  }

  /** Resolves when the guest is usable; navigation completion is reported through page state. */
  async create(viewId: string, url?: string, options?: BrowserViewCreateOptions): Promise<BrowserViewState> {
    if (url && !isUrlAllowedByPolicy(url)) {
      const error = new Error(buildBlockedMessage(url)) as Error & { code?: string }
      error.code = BROWSER_POLICY_BLOCKED
      console.warn('[Browser] Initial navigation blocked', { viewId })
      throw error
    }
    const pending = this.pendingCreates.get(viewId)
    if (pending) return pending
    const existing = this.states.get(viewId)
    if (existing) return existing
    const deviceMode = options?.deviceMode ?? 'pc'
    const state: BrowserViewState = {
      id: viewId,
      url: url || 'about:blank',
      title: 'New Tab',
      isLoading: !!url && url !== 'about:blank',
      canGoBack: false,
      canGoForward: false,
      zoomLevel: 1,
      isDevToolsOpen: false,
      deviceMode,
    }
    this.states.set(viewId, state)
    let promise!: Promise<BrowserViewState>
    promise = Promise.resolve().then(async () => {
      try {
        if (this.states.get(viewId) !== state) throw new Error('Browser page closed before creation')
        const webContents = await browserHostManager.create(viewId, options?.offscreen ?? false)
        if (this.states.get(viewId) !== state || webContents.isDestroyed()) {
          throw new Error('Browser page closed during creation')
        }
        const view = { webContents }
        this.views.set(viewId, view)
        webContents.once('destroyed', () => {
          if (this.views.get(viewId) === view) this.cleanupStaleView(viewId)
        })
        webContents.setUserAgent(resolveUserAgent(getConfig().browser?.userAgent, deviceMode))
        webContents.setZoomFactor(state.zoomLevel)
        this.bindEvents(viewId, view)
        if (url) {
          void webContents.loadURL(url).catch(error => {
            if (webContents.isDestroyed() || this.states.get(viewId) !== state || wasNavigationCancelled(error)) return
            console.warn('[Browser] Initial navigation failed', { viewId }, navigationFailureDetails(error))
          })
        }
        if (this.states.get(viewId) !== state) throw new Error('Browser page closed during navigation')
        return state
      } catch (error) {
        if (this.states.get(viewId) === state) this.destroy(viewId)
        console.warn('[Browser] Page creation failed', { viewId }, error)
        throw error
      } finally {
        if (this.pendingCreates.get(viewId) === promise) this.pendingCreates.delete(viewId)
      }
    })
    this.pendingCreates.set(viewId, promise)
    return promise
  }

  show(viewId: string, bounds: BrowserViewBounds): boolean {
    const view = this.views.get(viewId)
    if (!view || view.webContents.isDestroyed()) {
      console.warn('[Browser] Cannot show unavailable page', { viewId })
      if (view) this.cleanupStaleView(viewId)
      return false
    }
    if (this.displayedViewId && this.displayedViewId !== viewId) this.hide(this.displayedViewId)
    const result = this.applyBounds(viewId, bounds, true)
    if (result) {
      this.activeViewId = viewId
      this.displayedViewId = viewId
    }
    return result
  }

  hide(viewId: string): boolean {
    if (!this.views.has(viewId)) return false
    const result = this.applyBounds(viewId, this.lastBounds.get(viewId) ?? { x: 0, y: 0, width: 1280, height: 720 }, false)
    if (this.activeViewId === viewId) this.activeViewId = null
    if (this.displayedViewId === viewId) this.displayedViewId = null
    return result
  }

  /** A visible AI page can be selected by an interactive context without changing hosts. */
  isRevealed(viewId: string): boolean {
    return browserHostManager.isVisible(viewId)
  }

  /** Subscribe to view destruction, whichever path destroyed it. Returns an unsubscribe. */
  onViewDestroyed(listener: (viewId: string, webContentsId?: number) => void): () => void {
    this.destroyedListeners.add(listener)
    return () => this.destroyedListeners.delete(listener)
  }

  private emitViewDestroyed(viewId: string, webContentsId?: number, reason: 'closed' | 'lost' = 'closed') {
    if (this.mainWindow && !this.mainWindow.isDestroyed() && !this.mainWindow.webContents.isDestroyed()) {
      this.mainWindow.webContents.send('browser:page-gone', { viewId, reason })
    }
    for (const listener of this.destroyedListeners) {
      try {
        listener(viewId, webContentsId)
      } catch (error) {
        console.error(`[Browser] view-destroyed listener failed for ${viewId}:`, error)
      }
    }
  }

  /**
   * Resize a browser page
   */
  resize(viewId: string, bounds: BrowserViewBounds) {
    const view = this.views.get(viewId)
    if (!view) return false

    return this.applyBounds(viewId, bounds)
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
      if (this.views.get(viewId) !== view || wasNavigationCancelled(error)) return false
      console.error('[Browser] Navigation failed', { viewId }, navigationFailureDetails(error))
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
    if (!view || !view.webContents.navigationHistory.canGoBack()) return false
    view.webContents.navigationHistory.goBack()
    return true
  }

  /**
   * Navigation: Go forward
   */
  goForward(viewId: string): boolean {
    const view = this.views.get(viewId)
    if (!view || !view.webContents.navigationHistory.canGoForward()) return false
    view.webContents.navigationHistory.goForward()
    return true
  }

  /**
   * Navigation: Reload
   */
  reload(viewId: string): boolean {
    const view = this.views.get(viewId)
    if (!view) return false
    const state = this.states.get(viewId)
    if (view.webContents.getURL().startsWith('about:blank#halo-browser-')) {
      if (state?.url && !state.url.startsWith('about:blank')) {
        void this.navigate(viewId, state.url)
      } else {
        void view.webContents.loadURL('about:blank').catch(error => {
          if (!view.webContents.isDestroyed() && !wasNavigationCancelled(error)) console.warn('[Browser] Blank page reload failed', { viewId }, navigationFailureDetails(error))
        })
      }
      return true
    }
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
    this.updateState(viewId, { isLoading: false })
    this.emitStateChangeImmediate(viewId)
    return true
  }

  /**
   * Capture screenshot of the view
   */
  async capture(viewId: string): Promise<string | null> {
    const view = this.views.get(viewId)
    if (!view) return null

    try {
      const image = await captureBrowserPage(view.webContents)
      return image.toDataURL()
    } catch (error) {
      console.error('[Browser] Screenshot failed:', error)
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
      console.error('[Browser] JS execution failed:', error)
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
   * Destroy a browser page
   */
  destroy(viewId: string) {
    const view = this.views.get(viewId)
    if (!view && !this.states.has(viewId)) return

    // Clear any pending debounce timer for this view
    const timer = this.stateChangeDebounceTimers.get(viewId)
    if (timer) {
      clearTimeout(timer)
      this.stateChangeDebounceTimers.delete(viewId)
    }

    this.views.delete(viewId)
    this.states.delete(viewId)
    this.lastBounds.delete(viewId)
    this.pendingCreates.delete(viewId)
    browserHostManager.destroy(viewId)

    if (this.activeViewId === viewId) {
      this.activeViewId = null
    }
    if (this.displayedViewId === viewId) this.displayedViewId = null

    this.emitViewDestroyed(viewId, view?.webContents.id)
  }

  /**
   * Destroy all browser pages and the hidden host
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

    browserHostManager.destroyAll()
    for (const viewId of [...this.states.keys()]) this.destroy(viewId)
  }

  /**
   * Bind WebContents events
   */
  private bindEvents(viewId: string, view: { webContents: WebContents }) {
    const wc = view.webContents
    const isCurrent = () => this.views.get(viewId) === view && !wc.isDestroyed()
    let attachmentHistory = true
    const removeAttachmentHistory = () => {
      if (!attachmentHistory) return
      const entries = wc.navigationHistory.getAllEntries()
      const index = entries.findIndex(entry => entry.url.startsWith('about:blank#halo-browser-'))
      if (index === -1) attachmentHistory = false
      else if (index !== wc.navigationHistory.getActiveIndex() && wc.navigationHistory.removeEntryAtIndex(index)) attachmentHistory = false
    }

    wc.on('render-process-gone', (_event, details) => {
      if (!isCurrent()) return
      this.updateState(viewId, { isLoading: false, error: `Browser page stopped: ${details.reason}` })
      this.emitStateChangeImmediate(viewId)
    })

    wc.on('did-navigate', () => {
      if (!isCurrent()) return
      removeAttachmentHistory()
      const state = this.states.get(viewId)
      if (state && wc.getZoomFactor() !== state.zoomLevel) wc.setZoomFactor(state.zoomLevel)
    })

    // Navigation start - immediate emit for responsive UI feedback
    wc.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
      if (!isMainFrame || !isCurrent()) return

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
      if (!isCurrent()) return
      removeAttachmentHistory()
      this.updateState(viewId, {
        isLoading: false,
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
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
          console.warn(`[Browser] did-finish-load applyDeviceMode failed:`, err)
        })
      }
    })

    // Navigation failed - immediate emit
    wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || !isCurrent()) return

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
      if (!isCurrent()) return
      this.updateState(viewId, { title })
      this.emitStateChange(viewId) // debounced
    })

    // Favicon updated - debounced (not urgent)
    wc.on('page-favicon-updated', (_event, favicons) => {
      if (!isCurrent()) return
      if (favicons.length > 0) {
        this.updateState(viewId, { favicon: favicons[0] })
        this.emitStateChange(viewId) // debounced
      }
    })

    // URL changed (for SPA navigation) - debounced (can happen very frequently)
    wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame || !isCurrent()) return

      this.updateState(viewId, {
        url,
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
      })
      this.emitStateChange(viewId) // debounced
    })

    // Handle new window requests - open in same view (with policy check)
    wc.setWindowOpenHandler(({ url }) => {
      if (!isCurrent()) return { action: 'deny' }
      if (!popupTargetAllowed(url, wc.getURL())) {
        console.warn('[Browser] Popup to a local address refused', { viewId, scheme: schemeOf(url) })
        return { action: 'deny' }
      }
      if (isUrlAllowedByPolicy(url)) {
        void wc.loadURL(url).catch(error => {
          if (!isCurrent()) return
          if (wasNavigationCancelled(error)) return
          console.warn('[Browser] Popup navigation failed', { viewId }, navigationFailureDetails(error))
          this.updateState(viewId, { error: (error as Error).message, isLoading: false })
          this.emitStateChangeImmediate(viewId)
        })
      } else {
        this.updateState(viewId, { error: buildBlockedMessage(url), blockedByPolicy: true, blockedUrl: url })
        this.emitStateChangeImmediate(viewId)
      }
      return { action: 'deny' }
    })

    // Handle external protocol links & browser policy
    wc.on('will-navigate', (event, url) => {
      if (!isCurrent()) { event.preventDefault(); return }
      // Block non-standard protocols (javascript:, data:, etc.)
      if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('file://')) {
        event.preventDefault()
        return
      }
      // Browser policy check for page-initiated navigations
      if (!isUrlAllowedByPolicy(url)) {
        event.preventDefault()
        this.updateState(viewId, { error: buildBlockedMessage(url), blockedByPolicy: true, blockedUrl: url })
        this.emitStateChangeImmediate(viewId)
      }
    })

    // Block server-side redirects (301/302) to disallowed domains
    wc.on('will-redirect', (event, url) => {
      if (!isCurrent()) { event.preventDefault(); return }
      if (!isUrlAllowedByPolicy(url)) {
        event.preventDefault()
        this.updateState(viewId, { error: buildBlockedMessage(url), blockedByPolicy: true, blockedUrl: url, isLoading: false })
        this.emitStateChangeImmediate(viewId)
      }
    })
  }

  /**
   * Update state.
   *
   * When blockedByPolicy transitions, applyBounds() is called to move the
   * guest offscreen (blocked) or restore it to visible bounds (unblocked).
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
      if (bounds) {
        this.applyBounds(viewId, bounds)
      }
    }
  }

  private applyBounds(viewId: string, bounds: BrowserViewBounds, visible = this.displayedViewId === viewId): boolean {
    this.lastBounds.set(viewId, bounds)
    const state = this.states.get(viewId)
    const contents = this.views.get(viewId)?.webContents
    // Standard webviews inherit host zoom; page zoom must remain independent of UI scale.
    if (contents && !contents.isDestroyed() && state && contents.getZoomFactor() !== state.zoomLevel) contents.setZoomFactor(state.zoomLevel)
    return browserHostManager.present(viewId, this.resolveBounds(viewId, bounds), visible && !state?.blockedByPolicy, state?.deviceMode === 'h5' ? H5_VIEWPORT_WIDTH : undefined)
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
    }, BrowserPageManager.STATE_CHANGE_DEBOUNCE_MS)

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
   * Resolve the actual integer bounds of a browser page.
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
   * Remove a stale view entry whose guest has been destroyed.
   * Called defensively when we detect a destroyed webContents.
   */
  private cleanupStaleView(viewId: string) {
    const timer = this.stateChangeDebounceTimers.get(viewId)
    if (timer) {
      clearTimeout(timer)
      this.stateChangeDebounceTimers.delete(viewId)
    }
    if (!this.states.has(viewId)) return
    const contentsId = this.views.get(viewId)?.webContents.id
    this.pendingCreates.delete(viewId)
    this.views.delete(viewId)
    this.states.delete(viewId)
    this.lastBounds.delete(viewId)
    if (this.activeViewId === viewId) {
      this.activeViewId = null
    }
    if (this.displayedViewId === viewId) this.displayedViewId = null
    this.emitViewDestroyed(viewId, contentsId, 'lost')
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

    try {
      // 1. Switch UA on the webContents object (affects subsequent navigations
      //    at the Electron level, independent of CDP). Issue #124: honor the
      //    user-configured custom UA first.
      const customUA = getConfig().browser?.userAgent
      view.webContents.setUserAgent(resolveUserAgent(customUA, mode))

      // 2. Apply full CDP emulation set
      await this.applyDeviceMode(viewId, mode)

      // 3. Persist mode in state and notify renderer
      state.deviceMode = mode
      const bounds = this.lastBounds.get(viewId)
      if (bounds) this.applyBounds(viewId, bounds)
      this.emitStateChangeImmediate(viewId)

      // 4. Reload so the server receives the new UA and the page re-renders
      //    with the correct viewport from the very first paint.
      view.webContents.reload()

      return true
    } catch (error) {
      console.error(`[Browser] setDeviceMode failed:`, error)
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

    } catch (error) {
      // CDP errors are non-fatal at creation time (debugger may not be ready yet
      // for brand-new views — the navigation itself will still use the correct UA).
      console.warn(`[Browser] applyDeviceMode CDP warning (non-fatal): viewId=${viewId}`, error)
    }
  }
}

// Singleton instance
export const browserViewManager = new BrowserPageManager()
