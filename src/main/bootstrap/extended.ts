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

import { registerOnboardingHandlers } from '../ipc/onboarding'
import { registerRemoteHandlers } from '../ipc/remote'
import { registerBrowserHandlers } from '../ipc/browser'
import { registerAIBrowserHandlers, cleanupAIBrowserHandlers } from '../ipc/ai-browser'
import { registerOverlayHandlers, cleanupOverlayHandlers } from '../ipc/overlay'
import { initializeSearchHandlers, cleanupSearchHandlers } from '../ipc/search'
import { registerPerfHandlers } from '../ipc/perf'
import { registerGitBashHandlers, initializeGitBashOnStartup } from '../ipc/git-bash'
import { cleanupAllCaches } from '../services/artifact-cache.service'
import { markExtendedServicesReady } from './state'
import { getMainWindow, sendToRenderer } from '../services/window.service'
import { initializeHealthSystem, setSessionCleanupFn } from '../services/health'
import { closeAllV2Sessions } from '../services/agent/session-manager'
import { registerHealthHandlers } from '../ipc/health'

/**
 * Initialize extended services after window is visible
 *
 * Window reference is managed by window.service.ts, no need to pass here.
 *
 * These services are loaded asynchronously and do not block the UI.
 * Heavy modules use lazy initialization - they only fully initialize
 * when their features are first accessed.
 */
export function initializeExtendedServices(): void {
  const start = performance.now()
  console.log('[Bootstrap] Extended services starting...')

  // Get main window for services that still need it directly
  const mainWindow = getMainWindow()

  // === EXTENDED SERVICES ===
  // These services are loaded after the window is visible.
  // New features should be added here by default.

  // Onboarding: First-time user guide, only needed once
  registerOnboardingHandlers()

  // Remote: Remote access feature, optional functionality
  registerRemoteHandlers()

  // Browser: Embedded BrowserView for Content Canvas
  // Note: BrowserView is created lazily when Canvas is opened
  registerBrowserHandlers(mainWindow)

  // AI Browser: AI automation tools (V2 feature)
  // Uses lazy initialization - heavy modules loaded on first tool call
  registerAIBrowserHandlers()

  // Overlay: Floating UI elements (chat capsule, etc.)
  // Already implements lazy initialization internally
  registerOverlayHandlers(mainWindow)

  // Search: Global search functionality
  initializeSearchHandlers()

  // Performance: Developer monitoring tools
  registerPerfHandlers(mainWindow)

  // GitBash: Windows Git Bash detection and setup
  registerGitBashHandlers()

  // Health: System health monitoring and recovery
  // Register IPC handlers for health queries from renderer
  registerHealthHandlers()

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

  // Initialize health system asynchronously (non-blocking)
  // This runs startup checks and starts fallback polling
  setSessionCleanupFn(closeAllV2Sessions)
  initializeHealthSystem()
    .then(() => {
      console.log('[Bootstrap] Health system initialized')
    })
    .catch((err) => {
      console.error('[Bootstrap] Health system initialization failed:', err)
    })

  const duration = performance.now() - start
  console.log(`[Bootstrap] Extended services registered in ${duration.toFixed(1)}ms`)

  // Mark state as ready (for Pull-based queries from renderer)
  // This enables renderer to query status on HMR reload or error recovery
  markExtendedServicesReady()

  // Notify renderer that extended services are ready (Push-based)
  // This allows renderer to safely call extended service APIs
  sendToRenderer('bootstrap:extended-ready', {
    timestamp: Date.now(),
    duration: duration
  })
  console.log('[Bootstrap] Sent bootstrap:extended-ready to renderer')
}

/**
 * Cleanup extended services on app shutdown
 *
 * Called during window-all-closed to properly release resources.
 */
export async function cleanupExtendedServices(): Promise<void> {
  // AI Browser: Cleanup MCP server and browser context
  cleanupAIBrowserHandlers()

  // Overlay: Cleanup overlay BrowserView
  cleanupOverlayHandlers()

  // Search: Cancel any ongoing searches
  cleanupSearchHandlers()

  // Artifact Cache: Close file watchers and clear caches
  await cleanupAllCaches()

  console.log('[Bootstrap] Extended services cleaned up')
}
