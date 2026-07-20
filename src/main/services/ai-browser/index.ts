/**
 * AI Browser Module - Public API
 *
 * This module provides AI-controlled browser capabilities for Halo.
 * It enables the AI to navigate web pages, interact with elements,
 * and extract information - all without requiring external tools.
 *
 * Entry Points (see DESIGN.md for full architecture):
 *   createAIBrowserMcpServer()   — Creates the MCP tool server (primary entry)
 *   createScopedBrowserContext()  — Creates an isolated context for automation
 *   cleanupAIBrowser()           — Destroys the global singleton on shutdown
 *   AI_BROWSER_SYSTEM_PROMPT     — System prompt fragment for AI instructions
 */

import { browserContext, createScopedBrowserContext } from './context'
import { createAIBrowserMcpServer } from './sdk-mcp-server'

// Re-export public API
export { createAIBrowserMcpServer }
export { createScopedBrowserContext }

// View-lifecycle event bus (consumed by ipc/ai-browser.ts transport layer)
export {
  onBrowserActiveView,
  onBrowserViewGone,
  type BrowserActiveViewEvent,
  type BrowserViewGoneEvent,
} from './events'

// ============================================
// System Prompt
// ============================================

/**
 * AI Browser system prompt addition
 * Append this to the system prompt when AI Browser is enabled
 *
 * Note: Tools are exposed via MCP server with prefix "mcp__ai-browser__"
 * e.g., mcp__ai-browser__browser_navigate
 */
export const AI_BROWSER_SYSTEM_PROMPT = `
## AI Browser

You can control Halo's embedded real browser. All browser tools are prefixed with mcp__ai-browser__.

### Core Workflow
1. \`browser_navigate\` — open a URL with \`{ url: "https://..." }\`; the first page is created automatically
2. \`browser_snapshot\` — see what's on the page (returns element UIDs)
3. Use UIDs to interact: \`browser_click\`, \`browser_fill\`, \`browser_hover\`, \`browser_press_key\`
4. \`browser_snapshot\` again — verify the result, get fresh UIDs
5. Repeat 3-4 until the task is complete

### Key Rules
- Always use the LATEST snapshot's UIDs. After any action that changes the page, re-snapshot before the next interaction.
- \`browser_navigate\` only opens URLs. Do not pass history actions like back/forward/reload.
- \`browser_tab\` only manages tabs (list, new, switch, close). Use it only for explicit multi-tab work.
- If a page is still loading, use Bash \`sleep 1-2\` then snapshot again. Or use \`browser_wait_for\` to wait for specific text.
- \`browser_fill\` supports both single fields (uid + value) and batch mode (elements array) for efficient form filling.
- \`browser_click\` supports drag-and-drop via the dragTo parameter.
- \`browser_inspect\` reveals network requests and console messages — powerful for finding API endpoints or diagnosing errors.
- \`browser_evaluate\` is the escape hatch — use it for anything other tools can't handle (scrolling, viewport resize, history actions, direct API calls, DOM manipulation).
- For pre-built automation scripts, use \`browser_run\`.
`

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
