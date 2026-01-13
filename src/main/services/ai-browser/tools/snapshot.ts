/**
 * Snapshot Tools - Accessibility tree, screenshot and script evaluation
 *
 * Tools for capturing page state and executing scripts.
 * Tool descriptions aligned with chrome-devtools-mcp for 100% compatibility.
 */

import type { AIBrowserTool, ToolResult } from '../types'
import { writeFileSync } from 'fs'

/**
 * take_snapshot - Get the accessibility tree of the current page
 * Aligned with chrome-devtools-mcp: take_snapshot
 */
export const takeSnapshotTool: AIBrowserTool = {
  name: 'browser_snapshot',
  description: `Take a text snapshot of the currently selected page based on the a11y tree. The snapshot lists page elements along with a unique
identifier (uid). Always use the latest snapshot. Prefer taking a snapshot over taking a screenshot. The snapshot indicates the element selected
in the DevTools Elements panel (if any).`,
  category: 'snapshot',
  inputSchema: {
    type: 'object',
    properties: {
      verbose: {
        type: 'boolean',
        description: 'Whether to include all possible information available in the full a11y tree. Default is false.'
      },
      filePath: {
        type: 'string',
        description: 'The absolute path, or a path relative to the current working directory, to save the snapshot to instead of attaching it to the response.'
      }
    }
  },
  handler: async (params, context): Promise<ToolResult> => {
    const verbose = params.verbose as boolean || false
    const filePath = params.filePath as string | undefined

    if (!context.getActiveViewId()) {
      return {
        content: 'No active browser page. Use browser_new_page first.',
        isError: true
      }
    }

    try {
      const snapshot = await context.createSnapshot(verbose)
      const formatted = snapshot.format(verbose)

      if (filePath) {
        writeFileSync(filePath, formatted, 'utf-8')
        return {
          content: `Snapshot saved to: ${filePath}\n\nPage: ${snapshot.title}\nURL: ${snapshot.url}\nElements: ${snapshot.idToNode.size}`
        }
      }

      return {
        content: formatted
      }
    } catch (error) {
      return {
        content: `Failed to take snapshot: ${(error as Error).message}`,
        isError: true
      }
    }
  }
}

/**
 * take_screenshot - Capture a screenshot of the page
 * Aligned with chrome-devtools-mcp: take_screenshot
 */
export const takeScreenshotTool: AIBrowserTool = {
  name: 'browser_screenshot',
  description: `Take a screenshot of the page or element.`,
  category: 'snapshot',
  inputSchema: {
    type: 'object',
    properties: {
      format: {
        type: 'string',
        description: 'Type of format to save the screenshot as. Default is "png"',
        enum: ['png', 'jpeg', 'webp']
      },
      quality: {
        type: 'number',
        description: 'Compression quality for JPEG and WebP formats (0-100). Higher values mean better quality but larger file sizes. Ignored for PNG format.'
      },
      uid: {
        type: 'string',
        description: 'The uid of an element on the page from the page content snapshot. If omitted takes a pages screenshot.'
      },
      fullPage: {
        type: 'boolean',
        description: 'If set to true takes a screenshot of the full page instead of the currently visible viewport. Incompatible with uid.'
      },
      filePath: {
        type: 'string',
        description: 'The absolute path, or a path relative to the current working directory, to save the screenshot to instead of attaching it to the response.'
      }
    }
  },
  handler: async (params, context): Promise<ToolResult> => {
    const format = (params.format as 'png' | 'jpeg' | 'webp') || 'png'
    const quality = params.quality as number | undefined
    const uid = params.uid as string | undefined
    const fullPage = params.fullPage as boolean || false
    const filePath = params.filePath as string | undefined

    if (!context.getActiveViewId()) {
      return {
        content: 'No active browser page.',
        isError: true
      }
    }

    // Validate incompatible options
    if (uid && fullPage) {
      return {
        content: 'Providing both "uid" and "fullPage" is not allowed.',
        isError: true
      }
    }

    try {
      const result = await context.captureScreenshot({
        format,
        quality: format === 'png' ? undefined : quality,
        uid,
        fullPage
      })

      // Build response message
      let message: string
      if (uid) {
        message = `Took a screenshot of node with uid "${uid}".`
      } else if (fullPage) {
        message = 'Took a screenshot of the full current page.'
      } else {
        message = "Took a screenshot of the current page's viewport."
      }

      if (filePath) {
        const buffer = Buffer.from(result.data, 'base64')
        writeFileSync(filePath, buffer)
        return {
          content: `${message}\nSaved screenshot to ${filePath}.`
        }
      }

      // Return with image data for AI to see
      return {
        content: message,
        images: [{
          data: result.data,
          mimeType: result.mimeType
        }]
      }
    } catch (error) {
      return {
        content: `Failed to take screenshot: ${(error as Error).message}`,
        isError: true
      }
    }
  }
}

/**
 * evaluate_script - Execute JavaScript in the browser context
 * Aligned with chrome-devtools-mcp: evaluate_script
 */
export const evaluateScriptTool: AIBrowserTool = {
  name: 'browser_evaluate',
  description: `Evaluate a JavaScript function inside the currently selected page. Returns the response as JSON
so returned values have to JSON-serializable.`,
  category: 'snapshot',
  inputSchema: {
    type: 'object',
    properties: {
      function: {
        type: 'string',
        description: `A JavaScript function declaration to be executed by the tool in the currently selected page.
Example without arguments: \`() => {
  return document.title
}\` or \`async () => {
  return await fetch("example.com")
}\`.
Example with arguments: \`(el) => {
  return el.innerText;
}\`
`
      },
      args: {
        type: 'array',
        description: 'An optional list of arguments to pass to the function.',
        items: {
          type: 'object',
          properties: {
            uid: {
              type: 'string',
              description: 'The uid of an element on the page from the page content snapshot'
            }
          },
          required: ['uid']
        }
      }
    },
    required: ['function']
  },
  handler: async (params, context): Promise<ToolResult> => {
    const fn = params.function as string
    const args = params.args as Array<{ uid: string }> | undefined

    if (!context.getActiveViewId()) {
      return {
        content: 'No active browser page.',
        isError: true
      }
    }

    try {
      // If args contain UIDs, resolve them to elements
      const elementArgs: unknown[] = []
      if (args && args.length > 0) {
        for (const arg of args) {
          const element = context.getElementByUid(arg.uid)
          if (!element) {
            throw new Error(`Element not found: ${arg.uid}`)
          }
          elementArgs.push(element)
        }
      }

      const result = await context.evaluateScript(fn, elementArgs)
      const resultStr = typeof result === 'object'
        ? JSON.stringify(result, null, 2)
        : String(result)

      return {
        content: `Script ran on page and returned:\n\`\`\`json\n${resultStr}\n\`\`\``
      }
    } catch (error) {
      return {
        content: `Script error: ${(error as Error).message}`,
        isError: true
      }
    }
  }
}

// Export all snapshot tools
export const snapshotTools: AIBrowserTool[] = [
  takeSnapshotTool,
  takeScreenshotTool,
  evaluateScriptTool
]
