/**
 * Overlay Service - Manages the overlay BrowserView
 *
 * This service creates and manages a dedicated BrowserView that renders
 * above all other views (including other BrowserViews) to display floating UI elements.
 *
 * Architecture:
 * - Pre-renders an overlay SPA at startup
 * - Shows/hides by changing bounds (width: 0 = hidden)
 * - Communicates with overlay via IPC
 *
 * Note: Using BrowserView instead of WebContentsView for Electron 28 compatibility.
 * BrowserView order is determined by add order - later added views appear on top.
 */

import { BrowserView, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

// ============================================
// Types
// ============================================

export interface OverlayState {
  showChatCapsule: boolean
  // Future overlay states
  // showDialog: boolean
  // dialogProps: DialogProps | null
}

export interface OverlayBounds {
  x: number
  y: number
  width: number
  height: number
}

// ============================================
// Overlay Manager
// ============================================

class OverlayManager {
  private mainWindow: BrowserWindow | null = null
  private overlayView: BrowserView | null = null
  private currentState: OverlayState = {
    showChatCapsule: false,
  }
  private isReady = false
  private isAttached = false
  private readyPromiseResolve: (() => void) | null = null
  private isInitializing = false
  private initPromise: Promise<void> | null = null

  /**
   * Set the main window reference (called at app startup)
   * This does NOT create the overlay - it's lazily initialized when first needed
   */
  setMainWindow(mainWindow: BrowserWindow): void {
    this.mainWindow = mainWindow

    // Handle window resize for when overlay is visible
    mainWindow.on('resize', () => {
      if (this.currentState.showChatCapsule && this.isAttached) {
        this.updateOverlayBounds()
      }
    })

    // Clean up on window close
    mainWindow.on('closed', () => {
      this.cleanup()
    })

    console.log('[Overlay] Main window reference set (lazy initialization enabled)')
  }

  /**
   * Lazily initialize the overlay BrowserView
   * Called on first showChatCapsule() to avoid startup overhead
   */
  private async lazyInitialize(): Promise<void> {
    // Return existing promise if already initializing
    if (this.initPromise) {
      return this.initPromise
    }

    // Already initialized
    if (this.overlayView) {
      return
    }

    if (!this.mainWindow) {
      console.error('[Overlay] Cannot initialize: mainWindow not set')
      return
    }

    this.isInitializing = true
    this.initPromise = this.doInitialize()

    try {
      await this.initPromise
    } finally {
      this.isInitializing = false
      this.initPromise = null
    }
  }

  /**
   * Actually create and initialize the overlay BrowserView
   */
  private async doInitialize(): Promise<void> {
    if (!this.mainWindow) return

    console.log('[Overlay] Lazy initializing overlay BrowserView...')
    const startTime = Date.now()

    // Create the overlay BrowserView
    this.overlayView = new BrowserView({
      webPreferences: {
        preload: join(__dirname, '../preload/index.mjs'),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })

    // Set transparent background
    this.overlayView.setBackgroundColor('#00000000')

    // Register IPC handlers first (before loading)
    this.registerIpcHandlers()

    // Add error listener for debugging load failures
    this.overlayView.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      console.error('[Overlay] Failed to load:', { errorCode, errorDescription, validatedURL })
    })

    // IMPORTANT: Add the BrowserView to window BEFORE loading
    // This ensures JavaScript can execute properly
    // Use offscreen bounds during loading to keep it invisible but allow proper initialization
    this.mainWindow.addBrowserView(this.overlayView)
    this.isAttached = true

    // Get window size for initial bounds (offscreen but full size for proper rendering)
    const [winWidth, winHeight] = this.mainWindow.getContentSize()
    this.overlayView.setBounds({ x: -winWidth, y: 0, width: winWidth, height: winHeight })

    // Load the overlay SPA with retry logic
    const loadOverlay = async (): Promise<boolean> => {
      if (!this.overlayView) return false

      try {
        if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
          // Development: use vite dev server
          const baseUrl = process.env['ELECTRON_RENDERER_URL']
          const overlayUrl = baseUrl.endsWith('/')
            ? `${baseUrl}overlay.html`
            : `${baseUrl}/overlay.html`
          await this.overlayView.webContents.loadURL(overlayUrl)
        } else {
          // Production: load from built files
          const overlayPath = join(__dirname, '../renderer/overlay.html')
          await this.overlayView.webContents.loadFile(overlayPath)
        }
        return true
      } catch (error) {
        console.error('[Overlay] Failed to load:', error)
        return false
      }
    }

    // Try loading with retries (Vite dev server might not be ready immediately)
    let loaded = false
    for (let attempt = 1; attempt <= 3; attempt++) {
      loaded = await loadOverlay()
      if (loaded) break
      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, 1000))
    }

    if (!loaded) {
      console.error('[Overlay] Failed to load after 3 attempts')
      this.cleanup()
      return
    }

    // If overlay:ready was already received during loading, skip waiting
    if (!this.isReady) {
      // Wait for overlay:ready signal (with timeout)
      const readyPromise = new Promise<void>((resolve) => {
        this.readyPromiseResolve = resolve
      })

      const timeoutPromise = new Promise<void>((resolve) => {
        setTimeout(() => {
          console.warn('[Overlay] Timeout waiting for ready signal')
          resolve()
        }, 5000) // 5 second timeout
      })

      await Promise.race([readyPromise, timeoutPromise])
    }

    // Now hide the overlay (move offscreen with 0 size)
    this.overlayView.setBounds({ x: 0, y: 0, width: 0, height: 0 })

    // Remove from window until needed (but keep the view alive)
    try {
      this.mainWindow.removeBrowserView(this.overlayView)
    } catch (e) {
      // Ignore
    }
    this.isAttached = false

    // NOTE: Window resize and closed handlers are set up in setMainWindow()

    // Uncomment to debug overlay in development:
    // if (is.dev) {
    //   this.overlayView.webContents.openDevTools({ mode: 'detach' })
    // }

    console.log(`[Overlay] Lazy initialization complete (${Date.now() - startTime}ms)`)
  }

  /**
   * Register IPC handlers for overlay communication
   */
  private registerIpcHandlers(): void {
    // Overlay ready notification
    ipcMain.on('overlay:ready', () => {
      this.isReady = true
      // Resolve the ready promise if waiting
      if (this.readyPromiseResolve) {
        this.readyPromiseResolve()
        this.readyPromiseResolve = null
      }
      // Send current state
      this.sendStateToOverlay()
    })

    // Exit maximized request from overlay
    ipcMain.on('overlay:exit-maximized', () => {
      // Forward to main renderer
      this.mainWindow?.webContents.send('canvas:exit-maximized')
    })
  }

  /**
   * Show the chat capsule overlay
   * Lazily initializes the overlay on first call to avoid startup overhead
   */
  async showChatCapsule(): Promise<void> {
    if (!this.mainWindow) {
      console.warn('[Overlay] Cannot show: mainWindow not set')
      return
    }

    // Lazy initialize on first use
    if (!this.overlayView) {
      await this.lazyInitialize()
    }

    if (!this.overlayView) {
      console.error('[Overlay] Failed to initialize overlay')
      return
    }

    this.currentState.showChatCapsule = true

    // Always remove and re-add to ensure overlay is on top of all other BrowserViews
    // BrowserView z-order is determined by add order - later added views appear on top
    if (this.isAttached) {
      try {
        this.mainWindow.removeBrowserView(this.overlayView)
      } catch (e) {
        // Ignore
      }
    }

    this.mainWindow.addBrowserView(this.overlayView)
    this.isAttached = true

    // Update bounds to cover the capsule area (left side)
    this.updateOverlayBounds()

    // Send state to overlay
    this.sendStateToOverlay()
  }

  /**
   * Hide the chat capsule overlay
   */
  hideChatCapsule(): void {
    if (!this.overlayView || !this.mainWindow) return

    this.currentState.showChatCapsule = false

    // Hide by setting bounds to 0
    this.overlayView.setBounds({ x: 0, y: 0, width: 0, height: 0 })

    // Remove from window to ensure it doesn't block clicks
    if (this.isAttached) {
      try {
        this.mainWindow.removeBrowserView(this.overlayView)
      } catch (e) {
        // Already removed
      }
      this.isAttached = false
    }

    // Send state to overlay
    this.sendStateToOverlay()
  }

  /**
   * Update overlay bounds based on window size
   */
  private updateOverlayBounds(): void {
    if (!this.mainWindow || !this.overlayView) return

    const [, height] = this.mainWindow.getContentSize()

    // For chat capsule: only need left edge area
    // Capsule is 44px wide + 12px margin = ~60px, give some extra space
    const overlayWidth = 80
    this.overlayView.setBounds({
      x: 0,
      y: 0,
      width: overlayWidth,
      height: height,
    })
  }

  /**
   * Send current state to overlay SPA
   */
  private sendStateToOverlay(): void {
    if (!this.overlayView) {
      return
    }

    // Check if webContents is valid and not destroyed
    if (this.overlayView.webContents.isDestroyed()) {
      return
    }

    try {
      this.overlayView.webContents.send('overlay:state-change', this.currentState)
    } catch (error) {
      console.error('[Overlay] Failed to send state:', error)
    }
  }

  /**
   * Clean up resources
   */
  cleanup(): void {
    // Clear ready promise
    this.readyPromiseResolve = null

    if (this.overlayView && this.mainWindow && this.isAttached) {
      try {
        this.mainWindow.removeBrowserView(this.overlayView)
      } catch (e) {
        // Already removed
      }
    }

    if (this.overlayView) {
      try {
        (this.overlayView.webContents as any).destroy()
      } catch (e) {
        // Already destroyed
      }
      this.overlayView = null
    }

    this.mainWindow = null
    this.isReady = false
    this.isAttached = false
  }

  /**
   * Check if overlay is initialized
   */
  isInitialized(): boolean {
    return this.overlayView !== null && this.mainWindow !== null
  }
}

// Singleton instance
export const overlayManager = new OverlayManager()
