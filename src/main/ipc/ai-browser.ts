/**
 * AI Browser IPC Handlers
 *
 * Handles IPC communication for the AI Browser functionality.
 * Provides endpoints for:
 * - Executing AI Browser tools
 * - Getting tool definitions
 * - Managing AI Browser state
 *
 * LAZY INITIALIZATION:
 * This module uses lazy initialization to improve startup performance.
 * The heavy AI Browser module (3000+ lines) is only loaded when:
 * - A tool is first executed
 * - Tool definitions are first requested
 * - Active view is first set
 *
 * This avoids blocking app startup with module loading.
 */

import { ipcMain, BrowserWindow } from 'electron'

// Lazy-loaded module references
let aiBrowserModule: typeof import('../services/ai-browser') | null = null
let mainWindowRef: BrowserWindow | null = null
let initialized = false

/**
 * Ensure AI Browser module is loaded and initialized
 * Called on first use of any AI Browser functionality
 */
async function ensureInitialized(): Promise<typeof import('../services/ai-browser')> {
  if (!aiBrowserModule) {
    console.log('[AI Browser IPC] Lazy loading AI Browser module...')
    const start = performance.now()

    // Dynamic import to defer module loading
    aiBrowserModule = await import('../services/ai-browser')

    const duration = performance.now() - start
    console.log(`[AI Browser IPC] Module loaded in ${duration.toFixed(1)}ms`)
  }

  if (!initialized && mainWindowRef) {
    console.log('[AI Browser IPC] Initializing AI Browser...')
    aiBrowserModule.initializeAIBrowser(mainWindowRef)
    initialized = true
  }

  return aiBrowserModule
}

/**
 * Register all AI Browser IPC handlers
 *
 * NOTE: This function only registers IPC handlers.
 * The actual AI Browser module is loaded lazily on first use.
 */
export function registerAIBrowserHandlers(mainWindow: BrowserWindow | null): void {
  if (!mainWindow) {
    console.warn('[AI Browser IPC] No main window provided, skipping registration')
    return
  }

  // Store reference for lazy initialization
  mainWindowRef = mainWindow

  // NOTE: We do NOT call initializeAIBrowser() here!
  // It will be called lazily when the module is first used.

  // ============================================
  // Tool Information
  // ============================================

  /**
   * Get all AI Browser tool names
   */
  ipcMain.handle('ai-browser:get-tool-names', async () => {
    try {
      const module = await ensureInitialized()
      const toolNames = module.getAIBrowserToolNames()
      return { success: true, data: toolNames }
    } catch (error) {
      console.error('[AI Browser IPC] Get tool names failed:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  /**
   * Get all AI Browser tool definitions
   */
  ipcMain.handle('ai-browser:get-tool-definitions', async () => {
    try {
      const module = await ensureInitialized()
      const definitions = module.getAIBrowserToolDefinitions()
      return { success: true, data: definitions }
    } catch (error) {
      console.error('[AI Browser IPC] Get tool definitions failed:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  /**
   * Get AI Browser system prompt addition
   */
  ipcMain.handle('ai-browser:get-system-prompt', async () => {
    try {
      const module = await ensureInitialized()
      return { success: true, data: module.AI_BROWSER_SYSTEM_PROMPT }
    } catch (error) {
      console.error('[AI Browser IPC] Get system prompt failed:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // ============================================
  // Tool Execution
  // ============================================

  /**
   * Execute an AI Browser tool
   */
  ipcMain.handle(
    'ai-browser:execute-tool',
    async (_event, { toolName, params }: { toolName: string; params: Record<string, unknown> }) => {
      console.log(`[AI Browser IPC] >>> execute-tool: ${toolName}`)

      try {
        const module = await ensureInitialized()
        const result = await module.executeAIBrowserTool(toolName, params)

        console.log(`[AI Browser IPC] <<< execute-tool success: ${toolName}`)
        return {
          success: true,
          data: {
            content: result.content,
            images: result.images,
            isError: result.isError
          }
        }
      } catch (error) {
        console.error('[AI Browser IPC] Execute tool failed:', error)
        return { success: false, error: (error as Error).message }
      }
    }
  )

  /**
   * Check if a tool is an AI Browser tool
   */
  ipcMain.handle('ai-browser:is-browser-tool', async (_event, { toolName }: { toolName: string }) => {
    try {
      const module = await ensureInitialized()
      return { success: true, data: module.isAIBrowserTool(toolName) }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  // ============================================
  // State Management
  // ============================================

  /**
   * Set the active browser view for AI operations
   */
  ipcMain.handle('ai-browser:set-active-view', async (_event, { viewId }: { viewId: string }) => {
    try {
      const module = await ensureInitialized()
      module.setActiveBrowserView(viewId)
      return { success: true }
    } catch (error) {
      console.error('[AI Browser IPC] Set active view failed:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  console.log('[AI Browser IPC] Handlers registered (lazy initialization enabled)')
}

/**
 * Cleanup AI Browser resources
 */
export function cleanupAIBrowserHandlers(): void {
  // Only cleanup if module was actually loaded
  if (aiBrowserModule && initialized) {
    aiBrowserModule.cleanupAIBrowser()
    console.log('[AI Browser IPC] Module cleaned up')
  }

  // Reset state
  aiBrowserModule = null
  mainWindowRef = null
  initialized = false

  console.log('[AI Browser IPC] Handlers cleaned up')
}
