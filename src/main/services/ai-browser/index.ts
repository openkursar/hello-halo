/**
 * AI Browser Module - Public API
 *
 * This module provides AI-controlled browser capabilities for Halo.
 * It enables the AI to navigate web pages, interact with elements,
 * and extract information - all without requiring external tools.
 *
 * Entry Points (see DESIGN.md for full architecture):
 *   createAIBrowserMcpServer()   — Creates the MCP tool server (primary entry)
 *   createScopedBrowserContext()  — Creates an isolated context (automation, digital-human chat)
 *   getInteractiveBrowserContext() — Per-conversation view of the USER's browser
 *   releaseInteractiveBrowserContext() — Drop one when its session ends
 *   cleanupAIBrowser()           — Destroys the global singleton on shutdown
 *   AI_BROWSER_SYSTEM_PROMPT     — System prompt fragment for AI instructions
 */

import { browserContext, createScopedBrowserContext } from './context'
import { browserContextOfServer, createAIBrowserMcpServer } from './sdk-mcp-server'

// Re-export public API
export { createAIBrowserMcpServer }
// Which browser a mounted AI Browser server acts on, for capabilities that share it.
export { browserContextOfServer }
export { createScopedBrowserContext }
export { getInteractiveBrowserContext, releaseInteractiveBrowserContext } from './context'
// Every page a conversation holds, for a client that missed the live events.
export { isLiveConversationPage, listLivePages } from './context'
// The user closing an AI page, refused unless the page is the named conversation's alone.
export { stopLivePage } from './context'
// The page a conversation acts on, for bringing it in front of the user.
export { conversationPage } from './context'
// Pages that end with their space.
export { listSpacePageIds, closeBrowserPages } from './context'
export type { BrowserContext } from './context'

// View-lifecycle event bus (consumed by ipc/ai-browser.ts transport layer)
export {
  onBrowserActiveView,
  onBrowserPageOpened,
  onBrowserViewGone,
  onBrowserConversationReleased,
  onBrowserCredentialRequest,
  onBrowserCredentialResolved,
  onBrowserOperating,
  type BrowserActiveViewEvent,
  type BrowserViewGoneEvent,
  type BrowserConversationReleasedEvent,
  type BrowserCredentialRequestEvent,
  type BrowserCredentialResolvedEvent,
  type BrowserOperatingEvent,
} from './events'

// A page waiting on a credential the model must not hold; answered by the user
// through the transport layer (ipc/ai-browser.ts, http/routes/browser.routes.ts).
export {
  submitCredential,
  declineCredential,
  listPendingCredentialRequests,
} from './credential-broker'

export { AI_BROWSER_DESCRIPTION, AI_BROWSER_INSTRUCTIONS, AI_BROWSER_SYSTEM_PROMPT } from './guidance'

// ============================================
// Lifecycle
// ============================================

/**
 * Clean up AI Browser resources (global singleton only).
 *
 * Called by bootstrap/extended.ts during app shutdown.
 * Scoped contexts are cleaned up by their owners (app-chat / execute).
 */
export function cleanupAIBrowser(): void {
  browserContext.destroy()
  console.log('[AI Browser] Global context cleaned up')
}
