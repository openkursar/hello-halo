/**		      	    				  	  	  	 		 		       	 	 	         	 	    					 
 * AI Browser Module - Main Entry Point
 *
 * This module provides AI-controlled browser capabilities for Halo.
 * It enables the AI to navigate web pages, interact with elements,
 * and extract information - all without requiring external tools.
 *
 * Key Features:
 * - 26 browser control tools compatible with Claude Agent SDK
 * - Accessibility tree-based element identification
 * - Network and console monitoring
 * - Screenshot capture
 * - Device/network emulation
 *
 * Usage:
 * 1. Initialize with main window
 * 2. Create SDK MCP server with createAIBrowserMcpServer()
 * 3. Pass to SDK via mcpServers option
 */

import { BrowserWindow } from 'electron'
import { browserContext, BrowserContext } from './context'
import { browserViewManager } from '../browser-view.service'
import {
  allTools,
  getToolNames,
  getToolDefinitions,
  findTool
} from './tools'
import type { AIBrowserTool, ToolResult } from './types'

// Import SDK MCP server creator
import { createAIBrowserMcpServer, getAIBrowserSdkToolNames } from './sdk-mcp-server'

// Re-export SDK MCP server functions
export { createAIBrowserMcpServer, getAIBrowserSdkToolNames }

// ============================================
// Module Initialization
// ============================================

/**
 * Initialize the AI Browser module
 * Must be called with the main window before using any tools
 */
export function initializeAIBrowser(mainWindow: BrowserWindow): void {
  browserContext.initialize(mainWindow)

  // Extend browserViewManager to expose getWebContents
  extendBrowserViewManager()

  console.log('[AI Browser] Module initialized')
}

/**
 * Extend browserViewManager to expose webContents access
 * This is needed for the context to execute CDP commands
 */
function extendBrowserViewManager(): void {
  const manager = browserViewManager as any

  // Add getWebContents method if not exists
  if (!manager.getWebContents) {
    manager.getWebContents = (viewId: string) => {
      const view = manager.views?.get(viewId)
      return view?.webContents || null
    }
  }

  // Add getAllStates method if not exists
  if (!manager.getAllStates) {
    manager.getAllStates = () => {
      const states: any[] = []
      if (manager.states) {
        for (const [id, state] of manager.states) {
          states.push({ ...state, id })
        }
      }
      return states
    }
  }
}

// ============================================
// Tool Registration
// ============================================

/**
 * Get all AI Browser tool names for SDK allowedTools
 */
export function getAIBrowserToolNames(): string[] {
  return getToolNames()
}

/**
 * Get tool definitions for SDK registration
 */
export function getAIBrowserToolDefinitions() {
  return getToolDefinitions()
}

/**
 * Check if a tool name is an AI Browser tool
 */
export function isAIBrowserTool(toolName: string): boolean {
  return toolName.startsWith('browser_')
}

// ============================================
// Tool Execution
// ============================================

/**
 * Execute an AI Browser tool
 *
 * @param toolName - Name of the tool to execute
 * @param params - Tool parameters
 * @returns Tool result
 */
export async function executeAIBrowserTool(
  toolName: string,
  params: Record<string, unknown>
): Promise<ToolResult> {
  const tool = findTool(toolName)

  if (!tool) {
    return {
      content: `Unknown AI Browser tool: ${toolName}`,
      isError: true
    }
  }

  try {
    console.log(`[AI Browser] Executing tool: ${toolName}`)
    const result = await tool.handler(params, browserContext)
    console.log(`[AI Browser] Tool completed: ${toolName}`)
    return result
  } catch (error) {
    console.error(`[AI Browser] Tool error: ${toolName}`, error)
    return {
      content: `Tool execution failed: ${(error as Error).message}`,
      isError: true
    }
  }
}

// ============================================
// System Prompt
// ============================================

/**
 * AI Browser system prompt addition
 * Append this to the system prompt when AI Browser is enabled
 *
 * Note: Tools are exposed via MCP server with prefix "mcp__ai-browser__"
 * e.g., mcp__ai-browser__browser_new_page
 */
export const AI_BROWSER_SYSTEM_PROMPT = `
## AI Browser

You can now control Halo's embedded real browser. All browser tools are provided via MCP server "ai-browser".

### Core Workflow
1. Use \`mcp__ai-browser__browser_new_page\` to open a webpage
2. Use \`mcp__ai-browser__browser_snapshot\` to get page content (accessibility tree)
3. Find the target element's uid from the snapshot
4. Use \`mcp__ai-browser__browser_click\`, \`mcp__ai-browser__browser_fill\`, etc. to interact with elements
5. Re-fetch snapshot after each action to confirm results

### Available Tools (prefix: mcp__ai-browser__)

**Navigation:**
- \`browser_new_page\` - Create new page and navigate to URL
- \`browser_navigate\` - Navigate to URL or execute back/forward/reload
- \`browser_list_pages\` - List all open pages
- \`browser_select_page\` - Select active page
- \`browser_close_page\` - Close page
- \`browser_wait_for\` - Wait for text to appear

**Input:**
- \`browser_click\` - Click element
- \`browser_fill\` - Fill input field
- \`browser_fill_form\` - Batch fill form fields
- \`browser_hover\` - Hover over element
- \`browser_drag\` - Drag element
- \`browser_press_key\` - Press key (e.g., Enter, Tab)
- \`browser_upload_file\` - Upload file
- \`browser_handle_dialog\` - Handle dialog

**View:**
- \`browser_snapshot\` - Get page accessibility tree (most important!)
- \`browser_screenshot\` - Take screenshot
- \`browser_evaluate\` - Execute JavaScript

**Debug:**
- \`browser_console\` - View console messages
- \`browser_network_requests\` - View network requests

**Emulation:**
- \`browser_emulate\` - Emulate device/network
- \`browser_resize\` - Resize viewport

### Important Notes
- **Always use the latest snapshot** - UIDs change after page updates
- Prefer \`browser_snapshot\` over \`browser_screenshot\` (more lightweight)
- Use \`browser_fill_form\` for batch form filling (more efficient)
- Ensure element is visible before interacting, scroll if necessary
`

// ============================================
// Context Access
// ============================================

/**
 * Get the browser context for advanced operations
 */
export function getBrowserContext(): BrowserContext {
  return browserContext
}

/**
 * Set the active browser view for AI operations
 */
export function setActiveBrowserView(viewId: string): void {
  browserContext.setActiveViewId(viewId)
}

/**
 * Clean up AI Browser resources
 */
export function cleanupAIBrowser(): void {
  browserContext.destroy()
  console.log('[AI Browser] Module cleaned up')
}

// Re-export types
export type { AIBrowserTool, ToolResult } from './types'
