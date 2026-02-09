/**		      	    				  	  	  	 		 		       	 	 	         	 	    					 
 * Essential Services - First Screen Dependencies
 *
 * These services are REQUIRED for the initial screen render.
 * They are loaded synchronously before the window becomes interactive.
 *
 * GUIDELINES:
 *   - Each service here directly impacts startup time
 *   - Total initialization should be < 500ms
 *   - New additions require architecture review
 *
 * CURRENT SERVICES:
 *   - Config: Application configuration (API keys, settings)
 *   - Space: Workspace management (list displayed on first screen)
 *   - Conversation: Chat history (core feature)
 *   - Agent: Message handling (core feature)
 *   - Artifact: File management (sidebar display)
 *   - System: Window controls (basic functionality)
 *   - Updater: Auto-update checks (lightweight, needs early start)
 */

import { registerConfigHandlers } from '../ipc/config'
import { registerSpaceHandlers } from '../ipc/space'
import { registerConversationHandlers } from '../ipc/conversation'
import { registerAgentHandlers } from '../ipc/agent'
import { registerArtifactHandlers } from '../ipc/artifact'
import { registerSystemHandlers } from '../ipc/system'
import { registerUpdaterHandlers, initAutoUpdater } from '../services/updater.service'
import { registerAuthHandlers } from '../ipc/auth'
import { registerBootstrapStatusHandler } from './state'

/**
 * Initialize essential services required for first screen render
 *
 * Window reference is managed by window.service.ts, no need to pass here.
 *
 * IMPORTANT: These handlers are loaded synchronously.
 * Only add services that are absolutely required for the initial UI.
 */
export function initializeEssentialServices(): void {
  const start = performance.now()

  // === BOOTSTRAP STATUS ===
  // Register early so renderer can query status even before extended services are ready.
  // This enables Pull+Push pattern for reliable initialization.
  registerBootstrapStatusHandler()

  // === ESSENTIAL SERVICES ===
  // Each service below is required for the first screen render.
  // Do NOT add new services without architecture review.

  // Config: Must be first - other services may depend on configuration
  registerConfigHandlers()

  // Auth: OAuth login handlers for multi-platform login (generic + backward compat)
  registerAuthHandlers()

  // Space: Workspace list is displayed immediately on the left sidebar
  registerSpaceHandlers()

  // Conversation: Chat history is displayed in the main content area
  registerConversationHandlers()

  // Agent: Message sending is the core feature, must be ready immediately
  registerAgentHandlers()

  // Artifact: File list is displayed in the right sidebar
  registerArtifactHandlers()

  // System: Window controls (maximize/minimize/close) are basic functionality
  registerSystemHandlers()

  // Updater: Lightweight, starts checking for updates in background
  registerUpdaterHandlers()
  initAutoUpdater()

  const duration = performance.now() - start
  console.log(`[Bootstrap] Essential services initialized in ${duration.toFixed(1)}ms`)
}
