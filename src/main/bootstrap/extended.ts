/**
 * Extended Services - Deferred Loading
 *
 * These services are loaded AFTER the window is visible.
 * They use lazy initialization - actual initialization happens on first use.
 *
 * GUIDELINES:
 *   - DEFAULT location for all new features
 *   - Services here do NOT block startup
 *   - Use lazy initialization pattern for heavy modules
 *
 * CURRENT SERVICES:
 *   - Onboarding: First-time user guide (only needed once)
 *   - Remote: Remote access feature (optional)
 *   - Browser: Embedded browser for Content Canvas (V2 feature)
 *   - AIBrowser: AI browser automation tools (V2 feature)
 *   - Overlay: Floating UI elements (optional)
 *   - Search: Global search (optional)
 *   - Performance: Developer monitoring tools (dev only)
 *   - GitBash: Windows Git Bash setup (Windows optional)
 */

import { BrowserWindow } from 'electron'
import { registerOnboardingHandlers } from '../ipc/onboarding'
import { registerRemoteHandlers } from '../ipc/remote'
import { registerBrowserHandlers } from '../ipc/browser'
import { registerAIBrowserHandlers, cleanupAIBrowserHandlers } from '../ipc/ai-browser'
import { registerOverlayHandlers, cleanupOverlayHandlers } from '../ipc/overlay'
import { initializeSearchHandlers, cleanupSearchHandlers } from '../ipc/search'
import { registerPerfHandlers } from '../ipc/perf'
import { registerGitBashHandlers, initializeGitBashOnStartup } from '../ipc/git-bash'

/**
 * Initialize extended services after window is visible
 *
 * @param mainWindow - The main application window
 *
 * These services are loaded asynchronously and do not block the UI.
 * Heavy modules use lazy initialization - they only fully initialize
 * when their features are first accessed.
 */
export function initializeExtendedServices(mainWindow: BrowserWindow): void {
  const start = performance.now()

  // === EXTENDED SERVICES ===
  // These services are loaded after the window is visible.
  // New features should be added here by default.

  // Onboarding: First-time user guide, only needed once
  registerOnboardingHandlers()

  // Remote: Remote access feature, optional functionality
  registerRemoteHandlers(mainWindow)

  // Browser: Embedded BrowserView for Content Canvas
  // Note: BrowserView is created lazily when Canvas is opened
  registerBrowserHandlers(mainWindow)

  // AI Browser: AI automation tools (V2 feature)
  // Uses lazy initialization - heavy modules loaded on first tool call
  registerAIBrowserHandlers(mainWindow)

  // Overlay: Floating UI elements (chat capsule, etc.)
  // Already implements lazy initialization internally
  registerOverlayHandlers(mainWindow)

  // Search: Global search functionality
  initializeSearchHandlers(mainWindow)

  // Performance: Developer monitoring tools
  registerPerfHandlers(mainWindow)

  // GitBash: Windows Git Bash detection and setup
  registerGitBashHandlers(mainWindow)

  // Windows-specific: Initialize Git Bash in background
  if (process.platform === 'win32') {
    initializeGitBashOnStartup()
      .then((status) => {
        console.log('[Bootstrap] Git Bash status:', status)
      })
      .catch((err) => {
        console.error('[Bootstrap] Git Bash initialization failed:', err)
      })
  }

  const duration = performance.now() - start
  console.log(`[Bootstrap] Extended services registered in ${duration.toFixed(1)}ms`)
}

/**
 * Cleanup extended services on app shutdown
 *
 * Called during window-all-closed to properly release resources.
 */
export function cleanupExtendedServices(): void {
  // AI Browser: Cleanup MCP server and browser context
  cleanupAIBrowserHandlers()

  // Overlay: Cleanup overlay BrowserView
  cleanupOverlayHandlers()

  // Search: Cancel any ongoing searches
  cleanupSearchHandlers()

  console.log('[Bootstrap] Extended services cleaned up')
}
