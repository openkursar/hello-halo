/**
 * BrowserViewer - Embedded browser component using Electron BrowserView
 *
 * This component provides a true browser experience within the Content Canvas,
 * featuring:
 * - Full Chromium rendering (same as Chrome)
 * - Navigation controls (back, forward, reload)
 * - Address bar with smart URL/search detection (Bing search)
 * - Loading indicators
 * - PC / H5 device mode toggle (viewport + UA + touch emulation via CDP)
 * - AI operation indicator when AI is controlling the browser
 * - Native context menu for screenshot, zoom and DevTools (uses Electron Menu)
 * - Page zoom controls via native menu
 *
 * The actual browser rendering is done by Electron's BrowserView in the main
 * process. This component manages the UI chrome and delegates lifecycle
 * management to CanvasLifecycle.
 *
 * IMPORTANT: BrowserView lifecycle (create, show, hide, destroy) is managed
 * by CanvasLifecycle, NOT by this component's useEffects.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  X,
  Home,
  Lock,
  Unlock,
  Globe,
  ExternalLink,
  Bot,
  MoreVertical,
  Search,
  Smartphone,
  Monitor,
  Loader2,
  ShieldCheck,
} from 'lucide-react'
import { api } from '../../../api'
import { canvasLifecycle, type TabState, type BrowserState } from '../../../services/canvas-lifecycle'
import { useBrowserState } from '../../../hooks/useCanvasLifecycle'
import { useAIBrowserStore } from '../../../stores/ai-browser.store'
import { useTranslation } from '../../../i18n'
import { useSecurityPolicy } from '../../../hooks/useSecurityPolicy'
import { getBrowserHomepage } from '../../../utils/browser-homepage'

interface BrowserViewerProps {
  tab: TabState
}

// Search engine URL (not policy-dependent)
const SEARCH_ENGINE_URL = 'https://www.bing.com/search?q='

/**
 * Check if input is a valid URL or should be treated as search query
 */
function isValidUrl(input: string): boolean {
  // Common URL patterns
  if (input.startsWith('http://') || input.startsWith('https://') || input.startsWith('file://')) {
    return true
  }

  // Check for domain-like patterns (e.g., "google.com", "localhost:3000")
  const domainPattern = /^[a-zA-Z0-9][-a-zA-Z0-9]*(\.[a-zA-Z]{2,}|:\d+)/
  if (domainPattern.test(input)) {
    return true
  }

  // Localhost without port
  if (input === 'localhost' || input.startsWith('localhost/')) {
    return true
  }

  return false
}

/**
 * Convert input to URL - either validates URL or creates search URL
 */
function inputToUrl(input: string): string {
  const trimmed = input.trim()

  if (!trimmed) return ''

  // Already a full URL
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('file://')) {
    return trimmed
  }

  // Looks like a URL, add https://
  if (isValidUrl(trimmed)) {
    return `https://${trimmed}`
  }

  // Treat as search query
  return `${SEARCH_ENGINE_URL}${encodeURIComponent(trimmed)}`
}

export function BrowserViewer({ tab }: BrowserViewerProps) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const [addressBarValue, setAddressBarValue] = useState(tab.url || '')
  const [isAddressBarFocused, setIsAddressBarFocused] = useState(false)
  const [zoomLevel, setZoomLevel] = useState(100)

  // PDF mode: simplified UI without navigation controls
  const isPdf = tab.type === 'pdf'

  // Get browser state from lifecycle manager via hook
  const browserState = useBrowserState(tab.id)

  // Blocked-page "allow and retry" — only offered when the build lets users
  // extend the browser allowlist (browserPolicy.userExtensible).
  const securityPolicy = useSecurityPolicy()
  const allowlistEditable = securityPolicy?.browserAllowlistEditable === true
  const [isAllowingBlockedHost, setIsAllowingBlockedHost] = useState(false)
  const [allowBlockedHostError, setAllowBlockedHostError] = useState<string | null>(null)
  const isMountedRef = useRef(true)

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  const blockedUrl = tab.browserState?.blockedUrl
  const blockedHost = (() => {
    if (!blockedUrl) return null
    try {
      return new URL(blockedUrl).hostname
    } catch {
      return null
    }
  })()

  // A new block target invalidates any error from a previous attempt
  useEffect(() => {
    setAllowBlockedHostError(null)
  }, [blockedUrl])

  const handleAllowBlockedHost = useCallback(async () => {
    if (!blockedUrl || !blockedHost) return
    setIsAllowingBlockedHost(true)
    setAllowBlockedHostError(null)
    try {
      const result = await api.addBrowserAllowlistEntry(blockedHost)
      if (!result.success) {
        if (isMountedRef.current) {
          setAllowBlockedHostError(result.error || t('Failed to update allowlist'))
        }
        return
      }
      if (tab.browserViewId) {
        await api.navigateBrowserView(tab.browserViewId, blockedUrl)
      } else {
        // Initial URL was blocked at creation — no view exists, re-create it
        await canvasLifecycle.retryBlockedBrowserView(tab.id)
      }
    } catch (error) {
      console.error('[BrowserViewer] Allow blocked host failed:', error)
      if (isMountedRef.current) {
        setAllowBlockedHostError((error as Error).message)
      }
    } finally {
      if (isMountedRef.current) {
        setIsAllowingBlockedHost(false)
      }
    }
  }, [blockedUrl, blockedHost, tab.browserViewId, tab.id, t])

  // AI Browser state - detect if AI is operating this browser
  const isAIOperating = useAIBrowserStore(state => state.isOperating)
  const aiActiveUrl = useAIBrowserStore(state => state.activeUrl)

  // Determine if this browser is the one AI is currently operating
  const isThisAIBrowser = (() => {
    if (!isAIOperating || !aiActiveUrl || !tab.url) return false
    if (tab.title?.includes('🤖')) return true
    try {
      const aiHostname = new URL(aiActiveUrl).hostname
      return tab.url.includes(aiHostname)
    } catch {
      return false
    }
  })()

  // ============================================
  // Container Bounds Registration
  // ============================================

  // Register container bounds getter with CanvasLifecycle
  // This allows CanvasLifecycle to position BrowserViews correctly
  useEffect(() => {
    const getBounds = () => containerRef.current?.getBoundingClientRect() || null
    canvasLifecycle.setContainerBoundsGetter(getBounds)

    // When container becomes available, ensure BrowserView is shown
    // This handles the case where the BrowserView was created before this
    // component mounted (e.g., switching from a non-browser tab to a new browser tab)
    if (containerRef.current && tab.browserViewId) {
      // Use ensureActiveBrowserViewShown instead of updateActiveBounds
      // because the view may not have been added to the window yet
      canvasLifecycle.ensureActiveBrowserViewShown()
    }
  }, [tab.browserViewId])

  // ============================================
  // Resize Observer
  // ============================================

  // Monitor container size changes and update BrowserView bounds
  useEffect(() => {
    if (!containerRef.current) return

    const resizeObserver = new ResizeObserver(() => {
      if (tab.browserViewId) {
        canvasLifecycle.updateActiveBounds()
      }
    })

    resizeObserver.observe(containerRef.current)
    return () => resizeObserver.disconnect()
  }, [tab.browserViewId])

  // ============================================
  // Address Bar Sync
  // ============================================

  // Sync address bar with tab URL when URL changes (and not focused)
  useEffect(() => {
    if (!isAddressBarFocused && tab.url) {
      setAddressBarValue(tab.url)
    }
  }, [tab.url, isAddressBarFocused])

  // ============================================
  // Navigation Handlers
  // ============================================

  const handleNavigate = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    if (!tab.browserViewId) return

    let url = inputToUrl(addressBarValue)
    if (!url) url = await getBrowserHomepage()
    await api.navigateBrowserView(tab.browserViewId, url)
  }, [tab.browserViewId, addressBarValue])

  const handleBack = useCallback(async () => {
    if (tab.browserViewId && browserState.canGoBack) {
      await api.browserGoBack(tab.browserViewId)
    }
  }, [tab.browserViewId, browserState.canGoBack])

  const handleForward = useCallback(async () => {
    if (tab.browserViewId && browserState.canGoForward) {
      await api.browserGoForward(tab.browserViewId)
    }
  }, [tab.browserViewId, browserState.canGoForward])

  const handleReload = useCallback(async () => {
    if (!tab.browserViewId) return

    if (browserState.isLoading) {
      await api.browserStop(tab.browserViewId)
    } else {
      await api.browserReload(tab.browserViewId)
    }
  }, [tab.browserViewId, browserState.isLoading])

  const handleHome = useCallback(async () => {
    if (tab.browserViewId) {
      const homepage = await getBrowserHomepage()
      await api.navigateBrowserView(tab.browserViewId, homepage)
    }
  }, [tab.browserViewId])

  const handleToggleDeviceMode = useCallback(async () => {
    if (!tab.browserViewId) return
    const currentMode = browserState.deviceMode ?? 'pc'
    const nextMode = currentMode === 'pc' ? 'h5' : 'pc'
    await api.setBrowserDeviceMode(tab.browserViewId, nextMode)
  }, [tab.browserViewId, browserState.deviceMode])

  const handleOpenExternal = useCallback(async () => {
    // For PDF, open with system default app; for browser, open URL in external browser
    if (isPdf && tab.path) {
      await api.openArtifact(tab.path)
    } else if (tab.url) {
      window.open(tab.url, '_blank')
    }
  }, [isPdf, tab.path, tab.url])

  // ============================================
  // Address Bar Handlers
  // ============================================

  const handleAddressBarFocus = useCallback(() => {
    setIsAddressBarFocused(true)
  }, [])

  const handleAddressBarBlur = useCallback(() => {
    setIsAddressBarFocused(false)
    // Reset to current URL if unchanged
    if (tab.url) {
      setAddressBarValue(tab.url)
    }
  }, [tab.url])

  const handleAddressBarKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (tab.url) {
        setAddressBarValue(tab.url)
      }
      ;(e.target as HTMLInputElement).blur()
    }
  }, [tab.url])

  // ============================================
  // Native Menu Handler
  // ============================================

  // Show native context menu (renders above BrowserView)
  const handleShowMenu = useCallback(async () => {
    if (!tab.browserViewId) return
    await api.showBrowserContextMenu({
      viewId: tab.browserViewId,
      url: tab.url,
      zoomLevel
    })
  }, [tab.browserViewId, tab.url, zoomLevel])

  // Listen for zoom changes from native menu
  useEffect(() => {
    const unsubscribe = api.onBrowserZoomChanged((data) => {
      if (data.viewId === tab.browserViewId) {
        setZoomLevel(data.zoomLevel)
      }
    })
    return unsubscribe
  }, [tab.browserViewId])

  // Check if URL is HTTPS
  const isSecure = tab.url?.startsWith('https://')

  // Check if address bar value looks like a search query
  const isSearchQuery = addressBarValue && !isValidUrl(addressBarValue)

  // ============================================
  // Render
  // ============================================

  return (
    <div className="flex flex-col h-full bg-background">
      {/* AI Operating Indicator (browser only, not PDF) */}
      {!isPdf && isThisAIBrowser && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-primary/10 border-b border-primary/30">
          <div className="relative">
            <Bot size={16} className="text-primary" />
            <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-green-500 rounded-full" />
          </div>
          <span className="text-xs font-medium text-primary">{t('AI is operating this browser')}</span>
          <div className="flex-1" />
          <div className="flex items-center gap-1">
            <div className="w-1.5 h-1.5 bg-green-500 rounded-full" />
            <span className="text-xs text-muted-foreground">{t('Live')}</span>
          </div>
        </div>
      )}

      {/* PDF Toolbar - simplified */}
      {isPdf ? (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-card/50">
          <span className="text-sm text-muted-foreground truncate flex-1">
            {tab.title}
          </span>
          <div className="flex items-center gap-0.5">
            {/* Open external button */}
            <button
              onClick={handleOpenExternal}
              className="p-1.5 rounded hover:bg-secondary transition-colors"
              title={t('Open with external application')}
            >
              <ExternalLink className="w-4 h-4 text-muted-foreground" />
            </button>
            {/* More menu button - triggers native Electron menu */}
            <button
              onClick={handleShowMenu}
              className="p-1.5 rounded hover:bg-secondary transition-colors"
              title={t('More options (zoom)')}
            >
              <MoreVertical className="w-4 h-4 text-muted-foreground" />
            </button>
          </div>
        </div>
      ) : (
        /* Browser Chrome (Toolbar) */
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-card/50">
          {/* Navigation Buttons */}
          <div className="flex items-center gap-0.5">
            <button
              onClick={handleBack}
              disabled={!browserState.canGoBack}
              className="p-1.5 rounded hover:bg-secondary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              title={t('Back (Alt+←)')}
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <button
              onClick={handleForward}
              disabled={!browserState.canGoForward}
              className="p-1.5 rounded hover:bg-secondary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              title={t('Forward (Alt+→)')}
            >
              <ArrowRight className="w-4 h-4" />
            </button>
            <button
              onClick={handleReload}
              className="p-1.5 rounded hover:bg-secondary transition-colors"
              title={browserState.isLoading ? t('Stop') : t('Reload (Ctrl+R)')}
            >
              {browserState.isLoading ? (
                <X className="w-4 h-4" />
              ) : (
                <RotateCw className="w-4 h-4" />
              )}
            </button>
            <button
              onClick={handleHome}
              className="p-1.5 rounded hover:bg-secondary transition-colors"
              title={t('Home')}
            >
              <Home className="w-4 h-4" />
            </button>
          </div>

          {/* Address Bar */}
          <form onSubmit={handleNavigate} className="flex-1">
            <div
              className={`
                flex items-center gap-2 px-3 py-1.5 rounded-full
                bg-secondary/50 border transition-colors
                ${isAddressBarFocused
                  ? 'border-primary/50 bg-secondary'
                  : 'border-transparent hover:bg-secondary/80'
                }
              `}
            >
              {/* Security/Search Indicator */}
              {isAddressBarFocused && isSearchQuery ? (
                <Search className="w-3.5 h-3.5 text-primary flex-shrink-0" />
              ) : tab.url ? (
                isSecure ? (
                  <Lock className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />
                ) : (
                  <Unlock className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                )
              ) : (
                <Globe className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
              )}

              <input
                type="text"
                value={addressBarValue}
                onChange={(e) => setAddressBarValue(e.target.value)}
                onFocus={handleAddressBarFocus}
                onBlur={handleAddressBarBlur}
                onKeyDown={handleAddressBarKeyDown}
                placeholder={t('Enter URL or search Bing...')}
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground min-w-0"
                spellCheck={false}
                autoComplete="off"
              />

              {/* Loading Indicator */}
              {browserState.isLoading && (
                <div className="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin flex-shrink-0" />
              )}
            </div>
          </form>

          {/* Tool Buttons - Device mode toggle, External, More */}
          <div className="flex items-center gap-0.5">
            {/* PC / H5 device mode toggle */}
            {(() => {
              const isH5 = (browserState.deviceMode ?? 'pc') === 'h5'
              return (
                <button
                  onClick={handleToggleDeviceMode}
                  className={`p-1.5 rounded transition-colors ${
                    isH5
                      ? 'text-primary bg-primary/10 hover:bg-primary/20'
                      : 'text-muted-foreground hover:bg-secondary'
                  }`}
                  title={isH5 ? t('Switch to PC mode') : t('Switch to H5 mobile mode')}
                >
                  {isH5 ? (
                    <Smartphone className="w-4 h-4" />
                  ) : (
                    <Monitor className="w-4 h-4" />
                  )}
                </button>
              )
            })()}

            {/* Open external button */}
            <button
              onClick={handleOpenExternal}
              className="p-1.5 rounded hover:bg-secondary transition-colors"
              title={t('Open in external browser')}
            >
              <ExternalLink className="w-4 h-4 text-muted-foreground" />
            </button>

            {/* More menu button - native Electron menu (screenshot, zoom, dev tools) */}
            <button
              onClick={handleShowMenu}
              className="p-1.5 rounded hover:bg-secondary transition-colors"
              title={t('More options (screenshot, zoom, developer tools)')}
            >
              <MoreVertical className="w-4 h-4 text-muted-foreground" />
            </button>
          </div>
        </div>
      )}

      {/* Browser Content Area - BrowserView renders here */}
      <div
        ref={containerRef}
        className="flex-1 relative bg-white"
        style={{ minHeight: '200px' }}
      >
        {/* Policy Block Overlay — shown whenever a browser policy error is active,
            whether the BrowserView exists (navigate block) or not (create block).
            The native BrowserView is kept offscreen by applyBounds() so this overlay is visible. */}
        {tab.browserState?.blockedByPolicy ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-background">
            <div className="flex flex-col items-center gap-3 text-center max-w-sm px-4">
              <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center">
                <Lock className="w-8 h-8 text-destructive" />
              </div>
              <h3 className="text-base font-semibold">{t('Access Restricted')}</h3>
              <p className="text-sm text-muted-foreground">{tab.error}</p>
              {allowlistEditable && blockedHost && (
                <button
                  onClick={handleAllowBlockedHost}
                  disabled={isAllowingBlockedHost}
                  className="inline-flex items-center gap-2 px-4 py-2 mt-1 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
                >
                  {isAllowingBlockedHost ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <ShieldCheck className="w-4 h-4" />
                  )}
                  {t('Allow {{host}} and retry', { host: blockedHost })}
                </button>
              )}
              {allowlistEditable && blockedHost && (
                <p className="text-xs text-muted-foreground">
                  {t('Manage allowed sites in Settings → System')}
                </p>
              )}
              {allowBlockedHostError && (
                <p className="text-xs text-destructive">{allowBlockedHostError}</p>
              )}
            </div>
          </div>
        ) : !tab.browserViewId ? (
          /* Loading Overlay (only shown during initial load before BrowserView is ready) */
          <div className="absolute inset-0 flex items-center justify-center bg-background">
            <div className="flex flex-col items-center gap-3">
              <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
              <p className="text-sm text-muted-foreground">{t('Opening...')}</p>
            </div>
          </div>
        ) : null}

        {/* The actual BrowserView is rendered by Electron main process */}
        {/* This div serves as the positioning target */}
      </div>
    </div>
  )
}

/**
 * Remote Mode Fallback
 * Shows a message when browser features are not available
 */
export function BrowserViewerFallback({ tab }: BrowserViewerProps) {
  const { t } = useTranslation()
  const openExternal = () => {
    if (tab.url) {
      window.open(tab.url, '_blank')
    }
  }

  return (
    <div className="flex flex-col h-full bg-background">
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center max-w-md px-4">
          <Globe className="w-16 h-16 mx-auto mb-4 text-muted-foreground/30" />
          <h3 className="text-lg font-medium mb-2">{t('Browser features are only available in the desktop client')}</h3>
          <p className="text-sm text-muted-foreground mb-4">
            {t('Please use the built-in browser in the Halo desktop app')}
          </p>
          {tab.url && (
            <button
              onClick={openExternal}
              className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
            >
              <ExternalLink className="w-4 h-4" />
              {t('Open in new window')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
