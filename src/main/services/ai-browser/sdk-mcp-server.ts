/**
 * AI Browser SDK MCP Server
 *
 * Creates an in-process MCP server using Claude Agent SDK's
 * tool() and createSdkMcpServer() functions.
 *
 * This allows AI Browser tools to be properly registered with the SDK
 * and executed internally without external process spawning.
 */

import { z } from 'zod'
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import type { BrowserContextInterface } from './types'
import { browserContext } from './context'
import { browserViewManager } from '../browser-view.service'

// ============================================
// Navigation Tools
// ============================================

const browser_list_pages = tool(
  'browser_list_pages',
  'List all open browser pages/tabs with their URLs and titles',
  {},
  async () => {
    const states = (browserViewManager as any).getAllStates?.() || []

    if (states.length === 0) {
      return {
        content: [{ type: 'text' as const, text: 'No browser pages are currently open.' }]
      }
    }

    const lines = ['Open browser pages:']
    states.forEach((state: any, index: number) => {
      lines.push(`[${index}] ${state.title || 'Untitled'} - ${state.url || 'about:blank'}`)
    })

    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }]
    }
  }
)

const browser_select_page = tool(
  'browser_select_page',
  'Select a browser page by index to make it the active page for subsequent operations',
  {
    pageIdx: z.number().describe('The index of the page to select (from list_pages output)'),
    bringToFront: z.boolean().optional().describe('Whether to bring the page to front (default: true)')
  },
  async (args) => {
    const states = (browserViewManager as any).getAllStates?.() || []

    if (args.pageIdx < 0 || args.pageIdx >= states.length) {
      return {
        content: [{ type: 'text' as const, text: `Invalid page index: ${args.pageIdx}. Valid range: 0-${states.length - 1}` }],
        isError: true
      }
    }

    const state = states[args.pageIdx]
    browserContext.setActiveViewId(state.id)

    return {
      content: [{ type: 'text' as const, text: `Selected page [${args.pageIdx}]: ${state.title || 'Untitled'} - ${state.url}` }]
    }
  }
)

const browser_new_page = tool(
  'browser_new_page',
  'Create a new browser page and navigate to the specified URL',
  {
    url: z.string().describe('The URL to navigate to'),
    timeout: z.number().optional().describe('Navigation timeout in milliseconds (default: 30000)')
  },
  async (args) => {
    const timeout = args.timeout || 30000

    try {
      const viewId = `ai-browser-${Date.now()}`
      const state = await browserViewManager.create(viewId, args.url)
      browserContext.setActiveViewId(viewId)

      // Wait for page load
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
        content: [{ type: 'text' as const, text: `Created new page: ${finalState?.title || 'Untitled'} - ${finalState?.url || args.url}` }]
      }
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Failed to create new page: ${(error as Error).message}` }],
        isError: true
      }
    }
  }
)

const browser_close_page = tool(
  'browser_close_page',
  'Close a browser page by index',
  {
    pageIdx: z.number().describe('The index of the page to close')
  },
  async (args) => {
    const states = (browserViewManager as any).getAllStates?.() || []

    if (args.pageIdx < 0 || args.pageIdx >= states.length) {
      return {
        content: [{ type: 'text' as const, text: `Invalid page index: ${args.pageIdx}` }],
        isError: true
      }
    }

    const state = states[args.pageIdx]
    browserViewManager.destroy(state.id)

    return {
      content: [{ type: 'text' as const, text: `Closed page [${args.pageIdx}]: ${state.title || 'Untitled'}` }]
    }
  }
)

const browser_navigate = tool(
  'browser_navigate',
  'Navigate to a URL, go back, go forward, or reload the current page',
  {
    type: z.enum(['url', 'back', 'forward', 'reload']).optional().describe('Navigation type'),
    url: z.string().optional().describe('The URL to navigate to (required if type is "url")'),
    ignoreCache: z.boolean().optional().describe('Whether to ignore cache when reloading'),
    timeout: z.number().optional().describe('Navigation timeout in milliseconds (default: 30000)')
  },
  async (args) => {
    const type = args.type || 'url'
    const timeout = args.timeout || 30000

    const viewId = browserContext.getActiveViewId()
    if (!viewId) {
      return {
        content: [{ type: 'text' as const, text: 'No active browser page. Use browser_new_page first.' }],
        isError: true
      }
    }

    try {
      switch (type) {
        case 'back':
          browserViewManager.goBack(viewId)
          break
        case 'forward':
          browserViewManager.goForward(viewId)
          break
        case 'reload':
          browserViewManager.reload(viewId)
          break
        case 'url':
        default:
          if (!args.url) {
            return {
              content: [{ type: 'text' as const, text: 'URL is required for navigation' }],
              isError: true
            }
          }
          await browserViewManager.navigate(viewId, args.url)
          break
      }

      // Wait for navigation
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
        content: [{ type: 'text' as const, text: `Navigated to: ${finalState?.title || 'Untitled'} - ${finalState?.url}` }]
      }
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Navigation failed: ${(error as Error).message}` }],
        isError: true
      }
    }
  }
)

const browser_wait_for = tool(
  'browser_wait_for',
  'Wait for specific text to appear on the page',
  {
    text: z.string().describe('The text to wait for'),
    timeout: z.number().optional().describe('Maximum time to wait in milliseconds (default: 30000)')
  },
  async (args) => {
    const timeout = args.timeout || 30000

    try {
      await browserContext.waitForText(args.text, timeout)
      return {
        content: [{ type: 'text' as const, text: `Found text: "${args.text}"` }]
      }
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Timeout waiting for text: "${args.text}"` }],
        isError: true
      }
    }
  }
)

// ============================================
// Input Tools
// ============================================

const browser_click = tool(
  'browser_click',
  'Click on an element identified by its UID from the accessibility snapshot',
  {
    uid: z.string().describe('The unique ID of the element to click (from take_snapshot output)'),
    dblClick: z.boolean().optional().describe('Whether to perform a double click (default: false)')
  },
  async (args) => {
    if (!browserContext.getActiveViewId()) {
      return {
        content: [{ type: 'text' as const, text: 'No active browser page. Use browser_new_page first.' }],
        isError: true
      }
    }

    try {
      await browserContext.clickElement(args.uid, { dblClick: args.dblClick || false })
      return {
        content: [{ type: 'text' as const, text: `Clicked element: ${args.uid}${args.dblClick ? ' (double-click)' : ''}` }]
      }
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Failed to click element ${args.uid}: ${(error as Error).message}` }],
        isError: true
      }
    }
  }
)

const browser_hover = tool(
  'browser_hover',
  'Hover over an element to trigger hover effects or tooltips',
  {
    uid: z.string().describe('The unique ID of the element to hover over')
  },
  async (args) => {
    if (!browserContext.getActiveViewId()) {
      return {
        content: [{ type: 'text' as const, text: 'No active browser page.' }],
        isError: true
      }
    }

    try {
      await browserContext.hoverElement(args.uid)
      return {
        content: [{ type: 'text' as const, text: `Hovering over element: ${args.uid}` }]
      }
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Failed to hover element ${args.uid}: ${(error as Error).message}` }],
        isError: true
      }
    }
  }
)

const browser_fill = tool(
  'browser_fill',
  'Fill an input field with the specified text (clears existing content first)',
  {
    uid: z.string().describe('The unique ID of the input element'),
    value: z.string().describe('The text to enter into the input field')
  },
  async (args) => {
    if (!browserContext.getActiveViewId()) {
      return {
        content: [{ type: 'text' as const, text: 'No active browser page.' }],
        isError: true
      }
    }

    try {
      await browserContext.fillElement(args.uid, args.value)
      return {
        content: [{ type: 'text' as const, text: `Filled element ${args.uid} with: "${args.value}"` }]
      }
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Failed to fill element ${args.uid}: ${(error as Error).message}` }],
        isError: true
      }
    }
  }
)

const browser_fill_form = tool(
  'browser_fill_form',
  'Fill multiple form fields at once for more efficient form completion',
  {
    elements: z.array(z.object({
      uid: z.string().describe('Element UID'),
      value: z.string().describe('Value to fill')
    })).describe('Array of {uid, value} pairs to fill')
  },
  async (args) => {
    if (!browserContext.getActiveViewId()) {
      return {
        content: [{ type: 'text' as const, text: 'No active browser page.' }],
        isError: true
      }
    }

    const results: string[] = []
    const errors: string[] = []

    for (const elem of args.elements) {
      try {
        await browserContext.fillElement(elem.uid, elem.value)
        results.push(`${elem.uid}: "${elem.value}"`)
      } catch (error) {
        errors.push(`${elem.uid}: ${(error as Error).message}`)
      }
    }

    if (errors.length > 0) {
      return {
        content: [{ type: 'text' as const, text: `Filled ${results.length} fields:\n${results.join('\n')}\n\nErrors:\n${errors.join('\n')}` }],
        isError: errors.length === args.elements.length
      }
    }

    return {
      content: [{ type: 'text' as const, text: `Filled ${results.length} fields:\n${results.join('\n')}` }]
    }
  }
)

const browser_drag = tool(
  'browser_drag',
  'Drag an element from one position to another',
  {
    from_uid: z.string().describe('The UID of the element to drag'),
    to_uid: z.string().describe('The UID of the target element to drop onto')
  },
  async (args) => {
    if (!browserContext.getActiveViewId()) {
      return {
        content: [{ type: 'text' as const, text: 'No active browser page.' }],
        isError: true
      }
    }

    try {
      await browserContext.dragElement(args.from_uid, args.to_uid)
      return {
        content: [{ type: 'text' as const, text: `Dragged element from ${args.from_uid} to ${args.to_uid}` }]
      }
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Failed to drag: ${(error as Error).message}` }],
        isError: true
      }
    }
  }
)

const browser_press_key = tool(
  'browser_press_key',
  'Press a keyboard key or key combination (e.g., "Enter", "Control+a", "Escape")',
  {
    key: z.string().describe('Key to press. Can include modifiers: "Control+a", "Shift+Tab", "Enter", etc.')
  },
  async (args) => {
    if (!browserContext.getActiveViewId()) {
      return {
        content: [{ type: 'text' as const, text: 'No active browser page.' }],
        isError: true
      }
    }

    try {
      await browserContext.pressKey(args.key)
      return {
        content: [{ type: 'text' as const, text: `Pressed key: ${args.key}` }]
      }
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Failed to press key: ${(error as Error).message}` }],
        isError: true
      }
    }
  }
)

const browser_upload_file = tool(
  'browser_upload_file',
  'Upload a file to a file input element',
  {
    uid: z.string().describe('The UID of the file input element'),
    filePath: z.string().describe('Absolute path to the file to upload')
  },
  async (args) => {
    if (!browserContext.getActiveViewId()) {
      return {
        content: [{ type: 'text' as const, text: 'No active browser page.' }],
        isError: true
      }
    }

    try {
      const element = browserContext.getElementByUid(args.uid)
      if (!element) {
        throw new Error(`Element not found: ${args.uid}`)
      }

      await browserContext.sendCDPCommand('DOM.setFileInputFiles', {
        backendNodeId: element.backendNodeId,
        files: [args.filePath]
      })

      return {
        content: [{ type: 'text' as const, text: `Uploaded file to ${args.uid}: ${args.filePath}` }]
      }
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Failed to upload file: ${(error as Error).message}` }],
        isError: true
      }
    }
  }
)

const browser_handle_dialog = tool(
  'browser_handle_dialog',
  'Handle a browser dialog by accepting or dismissing it',
  {
    action: z.enum(['accept', 'dismiss']).describe('Action to take'),
    promptText: z.string().optional().describe('Text to enter for prompt dialogs (optional)')
  },
  async (args) => {
    const dialog = browserContext.getPendingDialog()
    if (!dialog) {
      return {
        content: [{ type: 'text' as const, text: 'No dialog is currently open.' }],
        isError: true
      }
    }

    try {
      await browserContext.handleDialog(args.action === 'accept', args.promptText)
      return {
        content: [{ type: 'text' as const, text: `${args.action === 'accept' ? 'Accepted' : 'Dismissed'} ${dialog.type} dialog: "${dialog.message}"` }]
      }
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Failed to handle dialog: ${(error as Error).message}` }],
        isError: true
      }
    }
  }
)

// ============================================
// Snapshot Tools
// ============================================

const browser_snapshot = tool(
  'browser_snapshot',
  `Get the accessibility tree of the current page. Returns a structured text representation of all interactive elements with unique IDs (uid) that can be used with other tools like click, fill, etc.

IMPORTANT: Always use this tool after navigation or interactions to get the latest page state. Element UIDs change after page updates.`,
  {
    verbose: z.boolean().optional().describe('Include more details like descriptions (default: false)'),
    filePath: z.string().optional().describe('Optional: Save snapshot to a file instead of returning it')
  },
  async (args) => {
    if (!browserContext.getActiveViewId()) {
      return {
        content: [{ type: 'text' as const, text: 'No active browser page. Use browser_new_page first.' }],
        isError: true
      }
    }

    try {
      const snapshot = await browserContext.createSnapshot(args.verbose || false)
      const formatted = snapshot.format(args.verbose || false)

      if (args.filePath) {
        const { writeFileSync } = require('fs')
        writeFileSync(args.filePath, formatted, 'utf-8')
        return {
          content: [{ type: 'text' as const, text: `Snapshot saved to: ${args.filePath}\n\nPage: ${snapshot.title}\nURL: ${snapshot.url}\nElements: ${snapshot.idToNode.size}` }]
        }
      }

      return {
        content: [{ type: 'text' as const, text: formatted }]
      }
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Failed to take snapshot: ${(error as Error).message}` }],
        isError: true
      }
    }
  }
)

const browser_screenshot = tool(
  'browser_screenshot',
  `Take a screenshot of the current page or a specific element. Returns the image as base64 data.`,
  {
    format: z.enum(['png', 'jpeg']).optional().describe('Image format (default: "png")'),
    quality: z.number().optional().describe('JPEG quality 0-100 (default: 80)'),
    uid: z.string().optional().describe('Optional: Capture only a specific element by its UID'),
    fullPage: z.boolean().optional().describe('Capture the full scrollable page (default: false)'),
    filePath: z.string().optional().describe('Optional: Save screenshot to a file')
  },
  async (args) => {
    if (!browserContext.getActiveViewId()) {
      return {
        content: [{ type: 'text' as const, text: 'No active browser page.' }],
        isError: true
      }
    }

    try {
      const result = await browserContext.captureScreenshot({
        format: args.format || 'png',
        quality: args.quality,
        uid: args.uid,
        fullPage: args.fullPage || false
      })

      if (args.filePath) {
        const { writeFileSync } = require('fs')
        const buffer = Buffer.from(result.data, 'base64')
        writeFileSync(args.filePath, buffer)
        return {
          content: [{ type: 'text' as const, text: `Screenshot saved to: ${args.filePath}` }]
        }
      }

      // Return with image data
      return {
        content: [
          { type: 'text' as const, text: `Screenshot captured (${args.format || 'png'}${args.uid ? `, element: ${args.uid}` : ''}${args.fullPage ? ', full page' : ''})` },
          { type: 'image' as const, data: result.data, mimeType: result.mimeType }
        ]
      }
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Failed to take screenshot: ${(error as Error).message}` }],
        isError: true
      }
    }
  }
)

const browser_evaluate = tool(
  'browser_evaluate',
  `Execute JavaScript code in the browser context. Returns the result of the evaluation.`,
  {
    script: z.string().describe('JavaScript code or function to execute'),
    args: z.array(z.any()).optional().describe('Optional: Arguments to pass to the function')
  },
  async (args) => {
    if (!browserContext.getActiveViewId()) {
      return {
        content: [{ type: 'text' as const, text: 'No active browser page.' }],
        isError: true
      }
    }

    try {
      const result = await browserContext.evaluateScript(args.script, args.args)
      const resultStr = typeof result === 'object'
        ? JSON.stringify(result, null, 2)
        : String(result)

      return {
        content: [{ type: 'text' as const, text: `Script result:\n${resultStr}` }]
      }
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Script error: ${(error as Error).message}` }],
        isError: true
      }
    }
  }
)

// ============================================
// Network Tools
// ============================================

const browser_network_requests = tool(
  'browser_network_requests',
  'Get a list of recent network requests made by the page',
  {
    filter: z.object({
      url: z.string().optional().describe('Filter by URL pattern'),
      method: z.string().optional().describe('Filter by HTTP method'),
      resourceType: z.string().optional().describe('Filter by resource type'),
      hasResponse: z.boolean().optional().describe('Only include requests with responses')
    }).optional().describe('Optional filters'),
    limit: z.number().optional().describe('Maximum number of requests to return (default: 50)')
  },
  async (args) => {
    try {
      const requests = browserContext.getNetworkRequests(args.filter || {}, args.limit || 50)

      if (requests.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No network requests captured.' }]
        }
      }

      const lines = ['Recent network requests:']
      requests.forEach((req, index) => {
        lines.push(`[${index}] ${req.method} ${req.url}`)
        if (req.status) {
          lines.push(`    Status: ${req.status}`)
        }
      })

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }]
      }
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Failed to get network requests: ${(error as Error).message}` }],
        isError: true
      }
    }
  }
)

const browser_network_request = tool(
  'browser_network_request',
  'Get details of a specific network request by index',
  {
    index: z.number().describe('Index of the request (from network_requests output)')
  },
  async (args) => {
    try {
      const requests = browserContext.getNetworkRequests({}, 100)

      if (args.index < 0 || args.index >= requests.length) {
        return {
          content: [{ type: 'text' as const, text: `Invalid request index: ${args.index}` }],
          isError: true
        }
      }

      const req = requests[args.index]
      const details = [
        `URL: ${req.url}`,
        `Method: ${req.method}`,
        `Status: ${req.status || 'pending'}`,
        `Type: ${req.resourceType || 'unknown'}`,
        '',
        'Request Headers:',
        ...Object.entries(req.requestHeaders || {}).map(([k, v]) => `  ${k}: ${v}`),
        '',
        'Response Headers:',
        ...Object.entries(req.responseHeaders || {}).map(([k, v]) => `  ${k}: ${v}`)
      ]

      return {
        content: [{ type: 'text' as const, text: details.join('\n') }]
      }
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Failed to get request details: ${(error as Error).message}` }],
        isError: true
      }
    }
  }
)

// ============================================
// Console Tools
// ============================================

const browser_console = tool(
  'browser_console',
  'Get browser console messages (log, warn, error, etc.)',
  {
    level: z.enum(['all', 'log', 'info', 'warn', 'error']).optional().describe('Filter by log level (default: all)'),
    limit: z.number().optional().describe('Maximum number of messages (default: 50)')
  },
  async (args) => {
    try {
      const messages = browserContext.getConsoleMessages(args.level || 'all', args.limit || 50)

      if (messages.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No console messages captured.' }]
        }
      }

      const lines = ['Console messages:']
      messages.forEach((msg, index) => {
        lines.push(`[${msg.level.toUpperCase()}] ${msg.text}`)
      })

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }]
      }
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Failed to get console messages: ${(error as Error).message}` }],
        isError: true
      }
    }
  }
)

const browser_console_message = tool(
  'browser_console_message',
  'Get details of a specific console message by index',
  {
    index: z.number().describe('Index of the message')
  },
  async (args) => {
    try {
      const messages = browserContext.getConsoleMessages('all', 100)

      if (args.index < 0 || args.index >= messages.length) {
        return {
          content: [{ type: 'text' as const, text: `Invalid message index: ${args.index}` }],
          isError: true
        }
      }

      const msg = messages[args.index]
      const details = [
        `Level: ${msg.level}`,
        `Text: ${msg.text}`,
        `Source: ${msg.source || 'unknown'}`,
        `Line: ${msg.line || 'unknown'}`,
        `Column: ${msg.column || 'unknown'}`
      ]

      return {
        content: [{ type: 'text' as const, text: details.join('\n') }]
      }
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Failed to get message details: ${(error as Error).message}` }],
        isError: true
      }
    }
  }
)

// ============================================
// Emulation Tools
// ============================================

const browser_emulate = tool(
  'browser_emulate',
  'Emulate a device or network condition',
  {
    device: z.string().optional().describe('Device to emulate (e.g., "iPhone 12", "iPad Pro")'),
    userAgent: z.string().optional().describe('Custom user agent string'),
    viewport: z.object({
      width: z.number(),
      height: z.number()
    }).optional().describe('Custom viewport size'),
    offline: z.boolean().optional().describe('Enable offline mode'),
    latency: z.number().optional().describe('Network latency in ms'),
    downloadThroughput: z.number().optional().describe('Download speed in bytes/s'),
    uploadThroughput: z.number().optional().describe('Upload speed in bytes/s')
  },
  async (args) => {
    if (!browserContext.getActiveViewId()) {
      return {
        content: [{ type: 'text' as const, text: 'No active browser page.' }],
        isError: true
      }
    }

    try {
      await browserContext.setEmulation(args)
      const settings = []
      if (args.device) settings.push(`Device: ${args.device}`)
      if (args.viewport) settings.push(`Viewport: ${args.viewport.width}x${args.viewport.height}`)
      if (args.offline) settings.push('Offline mode enabled')
      if (args.latency) settings.push(`Latency: ${args.latency}ms`)

      return {
        content: [{ type: 'text' as const, text: `Emulation settings applied:\n${settings.join('\n') || 'Default'}` }]
      }
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Failed to set emulation: ${(error as Error).message}` }],
        isError: true
      }
    }
  }
)

const browser_resize = tool(
  'browser_resize',
  'Resize the browser viewport',
  {
    width: z.number().describe('New viewport width'),
    height: z.number().describe('New viewport height')
  },
  async (args) => {
    if (!browserContext.getActiveViewId()) {
      return {
        content: [{ type: 'text' as const, text: 'No active browser page.' }],
        isError: true
      }
    }

    try {
      await browserContext.setViewportSize(args.width, args.height)
      return {
        content: [{ type: 'text' as const, text: `Viewport resized to ${args.width}x${args.height}` }]
      }
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Failed to resize: ${(error as Error).message}` }],
        isError: true
      }
    }
  }
)

// ============================================
// Performance Tools
// ============================================

const browser_perf_start = tool(
  'browser_perf_start',
  'Start collecting performance metrics',
  {},
  async () => {
    try {
      await browserContext.startPerformanceMetrics()
      return {
        content: [{ type: 'text' as const, text: 'Performance metrics collection started.' }]
      }
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Failed to start performance metrics: ${(error as Error).message}` }],
        isError: true
      }
    }
  }
)

const browser_perf_stop = tool(
  'browser_perf_stop',
  'Stop collecting performance metrics and return results',
  {},
  async () => {
    try {
      const metrics = await browserContext.stopPerformanceMetrics()
      const lines = ['Performance Metrics:']
      for (const [key, value] of Object.entries(metrics)) {
        lines.push(`  ${key}: ${value}`)
      }
      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }]
      }
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Failed to stop performance metrics: ${(error as Error).message}` }],
        isError: true
      }
    }
  }
)

const browser_perf_insight = tool(
  'browser_perf_insight',
  'Get Web Vitals and performance insights',
  {},
  async () => {
    try {
      const insights = await browserContext.getPerformanceInsights()
      const lines = ['Performance Insights:']

      if (insights.lcp) lines.push(`  LCP (Largest Contentful Paint): ${insights.lcp}ms`)
      if (insights.fid) lines.push(`  FID (First Input Delay): ${insights.fid}ms`)
      if (insights.cls) lines.push(`  CLS (Cumulative Layout Shift): ${insights.cls}`)
      if (insights.ttfb) lines.push(`  TTFB (Time to First Byte): ${insights.ttfb}ms`)
      if (insights.fcp) lines.push(`  FCP (First Contentful Paint): ${insights.fcp}ms`)

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }]
      }
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Failed to get performance insights: ${(error as Error).message}` }],
        isError: true
      }
    }
  }
)

// ============================================
// Export SDK MCP Server
// ============================================

/**
 * All AI Browser tools as SDK MCP tools
 */
const allSdkTools = [
  // Navigation (6)
  browser_list_pages,
  browser_select_page,
  browser_new_page,
  browser_close_page,
  browser_navigate,
  browser_wait_for,
  // Input (8)
  browser_click,
  browser_hover,
  browser_fill,
  browser_fill_form,
  browser_drag,
  browser_press_key,
  browser_upload_file,
  browser_handle_dialog,
  // Snapshot (3)
  browser_snapshot,
  browser_screenshot,
  browser_evaluate,
  // Network (2)
  browser_network_requests,
  browser_network_request,
  // Console (2)
  browser_console,
  browser_console_message,
  // Emulation (2)
  browser_emulate,
  browser_resize,
  // Performance (3)
  browser_perf_start,
  browser_perf_stop,
  browser_perf_insight
]

/**
 * Create AI Browser SDK MCP Server
 * This server runs in-process and handles all browser_* tools
 */
export function createAIBrowserMcpServer() {
  return createSdkMcpServer({
    name: 'ai-browser',
    version: '1.0.0',
    tools: allSdkTools
  })
}

/**
 * Get all AI Browser tool names
 */
export function getAIBrowserSdkToolNames(): string[] {
  return allSdkTools.map(t => t.name)
}
