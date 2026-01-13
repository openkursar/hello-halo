/**
 * Navigation Tools - Page navigation and management
 *
 * Tools for navigating between pages, managing tabs, and waiting for content.
 * Tool descriptions aligned with chrome-devtools-mcp for 100% compatibility.
 */

import type { AIBrowserTool, ToolResult } from '../types'
import { browserViewManager } from '../../browser-view.service'

/**
 * list_pages - List all open browser pages/tabs
 * Aligned with chrome-devtools-mcp: listPages
 */
export const listPagesTool: AIBrowserTool = {
  name: 'browser_list_pages',
  description: 'Get a list of pages open in the browser.',
  category: 'navigation',
  inputSchema: {
    type: 'object',
    properties: {}
  },
  handler: async (_params, _context): Promise<ToolResult> => {
    // Get all view states from the manager
    const states = (browserViewManager as any).getAllStates?.() || []

    if (states.length === 0) {
      return {
        content: 'No browser pages are currently open.'
      }
    }

    const lines = ['Open browser pages:']
    states.forEach((state: any, index: number) => {
      lines.push(`[${index}] ${state.title || 'Untitled'} - ${state.url || 'about:blank'}`)
    })

    return {
      content: lines.join('\n')
    }
  }
}

/**
 * select_page - Select a page by index to make it active
 * Aligned with chrome-devtools-mcp: selectPage
 */
export const selectPageTool: AIBrowserTool = {
  name: 'browser_select_page',
  description: 'Select a page as a context for future tool calls.',
  category: 'navigation',
  inputSchema: {
    type: 'object',
    properties: {
      pageIdx: {
        type: 'number',
        description: 'The index of the page to select. Call browser_list_pages to get available pages.'
      },
      bringToFront: {
        type: 'boolean',
        description: 'Whether to focus the page and bring it to the top.'
      }
    },
    required: ['pageIdx']
  },
  handler: async (params, context): Promise<ToolResult> => {
    const pageIdx = params.pageIdx as number
    const states = (browserViewManager as any).getAllStates?.() || []

    if (pageIdx < 0 || pageIdx >= states.length) {
      return {
        content: `Invalid page index: ${pageIdx}. Valid range: 0-${states.length - 1}`,
        isError: true
      }
    }

    const state = states[pageIdx]
    context.setActiveViewId(state.id)

    return {
      content: `Selected page [${pageIdx}]: ${state.title || 'Untitled'} - ${state.url}`
    }
  }
}

/**
 * new_page - Create a new browser page
 * Aligned with chrome-devtools-mcp: newPage
 */
export const newPageTool: AIBrowserTool = {
  name: 'browser_new_page',
  description: 'Creates a new page',
  category: 'navigation',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'URL to load in a new page.'
      },
      timeout: {
        type: 'number',
        description: 'Maximum wait time in milliseconds. If set to 0, the default timeout will be used.'
      }
    },
    required: ['url']
  },
  handler: async (params, context): Promise<ToolResult> => {
    const url = params.url as string
    const timeout = (params.timeout as number) || 30000

    try {
      // Generate a unique view ID
      const viewId = `ai-browser-${Date.now()}`

      // Create the browser view
      const state = await browserViewManager.create(viewId, url)

      // Set as active view in context
      context.setActiveViewId(viewId)

      // Wait for page load with timeout
      const startTime = Date.now()
      while (Date.now() - startTime < timeout) {
        const currentState = browserViewManager.getState(viewId)
        if (currentState && !currentState.isLoading) {
          break
        }
        await new Promise(resolve => setTimeout(resolve, 100))
      }

      const finalState = browserViewManager.getState(viewId)
      return {
        content: `Created new page: ${finalState?.title || 'Untitled'} - ${finalState?.url || url}`
      }
    } catch (error) {
      return {
        content: `Failed to create new page: ${(error as Error).message}`,
        isError: true
      }
    }
  }
}

/**
 * close_page - Close a browser page
 * Aligned with chrome-devtools-mcp: closePage
 */
export const closePageTool: AIBrowserTool = {
  name: 'browser_close_page',
  description: 'Closes the page by its index. The last open page cannot be closed.',
  category: 'navigation',
  inputSchema: {
    type: 'object',
    properties: {
      pageIdx: {
        type: 'number',
        description: 'The index of the page to close. Call list_pages to list pages.'
      }
    },
    required: ['pageIdx']
  },
  handler: async (params, _context): Promise<ToolResult> => {
    const pageIdx = params.pageIdx as number
    const states = (browserViewManager as any).getAllStates?.() || []

    if (pageIdx < 0 || pageIdx >= states.length) {
      return {
        content: `Invalid page index: ${pageIdx}`,
        isError: true
      }
    }

    // Prevent closing the last page
    if (states.length === 1) {
      return {
        content: 'The last open page cannot be closed.',
        isError: true
      }
    }

    const state = states[pageIdx]
    browserViewManager.destroy(state.id)

    return {
      content: `Closed page [${pageIdx}]: ${state.title || 'Untitled'}`
    }
  }
}

/**
 * navigate_page - Navigate to a URL or perform navigation actions
 * Aligned with chrome-devtools-mcp: navigatePage
 */
export const navigatePageTool: AIBrowserTool = {
  name: 'browser_navigate',
  description: 'Navigates the currently selected page to a URL.',
  category: 'navigation',
  inputSchema: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        description: 'Navigate the page by URL, back or forward in history, or reload.',
        enum: ['url', 'back', 'forward', 'reload']
      },
      url: {
        type: 'string',
        description: 'Target URL (only type=url)'
      },
      ignoreCache: {
        type: 'boolean',
        description: 'Whether to ignore cache on reload.'
      },
      timeout: {
        type: 'number',
        description: 'Maximum wait time in milliseconds. If set to 0, the default timeout will be used.'
      }
    }
  },
  handler: async (params, context): Promise<ToolResult> => {
    const type = (params.type as string) || 'url'
    const url = params.url as string
    const timeout = (params.timeout as number) || 30000

    const viewId = context.getActiveViewId()
    if (!viewId) {
      return {
        content: 'No active browser page. Use browser_new_page first.',
        isError: true
      }
    }

    try {
      switch (type) {
        case 'back':
          browserViewManager.goBack(viewId)
          return { content: `Successfully navigated back.` }
        case 'forward':
          browserViewManager.goForward(viewId)
          return { content: `Successfully navigated forward.` }
        case 'reload':
          browserViewManager.reload(viewId)
          return { content: `Successfully reloaded the page.` }
        case 'url':
        default:
          if (!url) {
            return {
              content: 'Either URL or a type is required.',
              isError: true
            }
          }
          await browserViewManager.navigate(viewId, url)
          break
      }

      // Wait for navigation to complete
      const startTime = Date.now()
      while (Date.now() - startTime < timeout) {
        const state = browserViewManager.getState(viewId)
        if (state && !state.isLoading) {
          break
        }
        await new Promise(resolve => setTimeout(resolve, 100))
      }

      const finalState = browserViewManager.getState(viewId)
      return {
        content: `Successfully navigated to ${finalState?.url || url}.`
      }
    } catch (error) {
      return {
        content: `Unable to navigate in the selected page: ${(error as Error).message}.`,
        isError: true
      }
    }
  }
}

/**
 * wait_for - Wait for text to appear on the page
 * Aligned with chrome-devtools-mcp: waitFor
 */
export const waitForTool: AIBrowserTool = {
  name: 'browser_wait_for',
  description: 'Wait for the specified text to appear on the selected page.',
  category: 'navigation',
  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'Text to appear on the page'
      },
      timeout: {
        type: 'number',
        description: 'Maximum wait time in milliseconds. If set to 0, the default timeout will be used.'
      }
    },
    required: ['text']
  },
  handler: async (params, context): Promise<ToolResult> => {
    const text = params.text as string
    const timeout = (params.timeout as number) || 30000

    try {
      await context.waitForText(text, timeout)
      return {
        content: `Element with text "${text}" found.`
      }
    } catch (error) {
      return {
        content: `Timeout waiting for text: "${text}"`,
        isError: true
      }
    }
  }
}

/**
 * resize_page - Resize the browser viewport
 * Aligned with chrome-devtools-mcp: resizePage
 */
export const resizePageTool: AIBrowserTool = {
  name: 'browser_resize',
  description: "Resizes the selected page's window so that the page has specified dimension",
  category: 'emulation',
  inputSchema: {
    type: 'object',
    properties: {
      width: {
        type: 'number',
        description: 'Page width'
      },
      height: {
        type: 'number',
        description: 'Page height'
      }
    },
    required: ['width', 'height']
  },
  handler: async (params, context): Promise<ToolResult> => {
    const width = params.width as number
    const height = params.height as number

    if (!context.getActiveViewId()) {
      return {
        content: 'No active browser page.',
        isError: true
      }
    }

    try {
      await context.sendCDPCommand('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
        screenWidth: width,
        screenHeight: height
      })

      return {
        content: `Viewport resized to: ${width}x${height}`
      }
    } catch (error) {
      return {
        content: `Resize failed: ${(error as Error).message}`,
        isError: true
      }
    }
  }
}

/**
 * handle_dialog - Handle a browser dialog (alert, confirm, prompt)
 * Aligned with chrome-devtools-mcp: handleDialog
 */
export const handleDialogTool: AIBrowserTool = {
  name: 'browser_handle_dialog',
  description: 'If a browser dialog was opened, use this command to handle it',
  category: 'input',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Whether to dismiss or accept the dialog',
        enum: ['accept', 'dismiss']
      },
      promptText: {
        type: 'string',
        description: 'Optional prompt text to enter into the dialog.'
      }
    },
    required: ['action']
  },
  handler: async (params, context): Promise<ToolResult> => {
    const action = params.action as 'accept' | 'dismiss'
    const promptText = params.promptText as string | undefined

    const dialog = context.getPendingDialog()
    if (!dialog) {
      return {
        content: 'No open dialog found',
        isError: true
      }
    }

    try {
      await context.handleDialog(action === 'accept', promptText)
      return {
        content: `Successfully ${action === 'accept' ? 'accepted' : 'dismissed'} the dialog`
      }
    } catch (error) {
      return {
        content: `Failed to handle dialog: ${(error as Error).message}`,
        isError: true
      }
    }
  }
}

// Export all navigation tools
export const navigationTools: AIBrowserTool[] = [
  listPagesTool,
  selectPageTool,
  newPageTool,
  closePageTool,
  navigatePageTool,
  waitForTool,
  resizePageTool,
  handleDialogTool
]
