/**
 * Input Tools - User interaction simulation
 *
 * Tools for clicking, filling forms, keyboard input, and drag operations.
 * Tool descriptions aligned with chrome-devtools-mcp for 100% compatibility.
 */

import type { AIBrowserTool, ToolResult } from '../types'

/**
 * click - Click on an element
 * Aligned with chrome-devtools-mcp: click
 */
export const clickTool: AIBrowserTool = {
  name: 'browser_click',
  description: 'Clicks on the provided element',
  category: 'input',
  inputSchema: {
    type: 'object',
    properties: {
      uid: {
        type: 'string',
        description: 'The uid of an element on the page from the page content snapshot'
      },
      dblClick: {
        type: 'boolean',
        description: 'Set to true for double clicks. Default is false.'
      }
    },
    required: ['uid']
  },
  handler: async (params, context): Promise<ToolResult> => {
    const uid = params.uid as string
    const dblClick = params.dblClick as boolean || false

    if (!context.getActiveViewId()) {
      return {
        content: 'No active browser page. Use browser_new_page first.',
        isError: true
      }
    }

    try {
      await context.clickElement(uid, { dblClick })
      return {
        content: dblClick
          ? 'Successfully double clicked on the element'
          : 'Successfully clicked on the element'
      }
    } catch (error) {
      return {
        content: `Failed to click element ${uid}: ${(error as Error).message}`,
        isError: true
      }
    }
  }
}

/**
 * hover - Hover over an element
 * Aligned with chrome-devtools-mcp: hover
 */
export const hoverTool: AIBrowserTool = {
  name: 'browser_hover',
  description: 'Hover over the provided element',
  category: 'input',
  inputSchema: {
    type: 'object',
    properties: {
      uid: {
        type: 'string',
        description: 'The uid of an element on the page from the page content snapshot'
      }
    },
    required: ['uid']
  },
  handler: async (params, context): Promise<ToolResult> => {
    const uid = params.uid as string

    if (!context.getActiveViewId()) {
      return {
        content: 'No active browser page.',
        isError: true
      }
    }

    try {
      await context.hoverElement(uid)
      return {
        content: 'Successfully hovered over the element'
      }
    } catch (error) {
      return {
        content: `Failed to hover element ${uid}: ${(error as Error).message}`,
        isError: true
      }
    }
  }
}

/**
 * fill - Fill an input field with text
 * Aligned with chrome-devtools-mcp: fill
 */
export const fillTool: AIBrowserTool = {
  name: 'browser_fill',
  description: 'Type text into a input, text area or select an option from a <select> element.',
  category: 'input',
  inputSchema: {
    type: 'object',
    properties: {
      uid: {
        type: 'string',
        description: 'The uid of an element on the page from the page content snapshot'
      },
      value: {
        type: 'string',
        description: 'The value to fill in'
      }
    },
    required: ['uid', 'value']
  },
  handler: async (params, context): Promise<ToolResult> => {
    const uid = params.uid as string
    const value = params.value as string

    if (!context.getActiveViewId()) {
      return {
        content: 'No active browser page.',
        isError: true
      }
    }

    try {
      // Check if this is a combobox/select element
      const element = context.getElementByUid(uid)
      if (element && element.role === 'combobox') {
        // For combobox, we need to find the matching option
        await context.selectOption(uid, value)
      } else {
        await context.fillElement(uid, value)
      }
      return {
        content: 'Successfully filled out the element'
      }
    } catch (error) {
      return {
        content: `Failed to fill element ${uid}: ${(error as Error).message}`,
        isError: true
      }
    }
  }
}

/**
 * fill_form - Fill multiple form fields at once
 * Aligned with chrome-devtools-mcp: fill_form
 */
export const fillFormTool: AIBrowserTool = {
  name: 'browser_fill_form',
  description: 'Fill out multiple form elements at once',
  category: 'input',
  inputSchema: {
    type: 'object',
    properties: {
      elements: {
        type: 'array',
        description: 'Elements from snapshot to fill out.',
        items: {
          type: 'object',
          properties: {
            uid: { type: 'string', description: 'The uid of the element to fill out' },
            value: { type: 'string', description: 'Value for the element' }
          },
          required: ['uid', 'value']
        }
      }
    },
    required: ['elements']
  },
  handler: async (params, context): Promise<ToolResult> => {
    const elements = params.elements as Array<{ uid: string; value: string }>

    if (!context.getActiveViewId()) {
      return {
        content: 'No active browser page.',
        isError: true
      }
    }

    const errors: string[] = []

    for (const elem of elements) {
      try {
        const element = context.getElementByUid(elem.uid)
        if (element && element.role === 'combobox') {
          await context.selectOption(elem.uid, elem.value)
        } else {
          await context.fillElement(elem.uid, elem.value)
        }
      } catch (error) {
        errors.push(`${elem.uid}: ${(error as Error).message}`)
      }
    }

    if (errors.length > 0) {
      return {
        content: `Partially filled out the form.\n\nErrors:\n${errors.join('\n')}`,
        isError: errors.length === elements.length
      }
    }

    return {
      content: 'Successfully filled out the form'
    }
  }
}

/**
 * drag - Drag an element to another element
 * Aligned with chrome-devtools-mcp: drag
 */
export const dragTool: AIBrowserTool = {
  name: 'browser_drag',
  description: 'Drag an element onto another element',
  category: 'input',
  inputSchema: {
    type: 'object',
    properties: {
      from_uid: {
        type: 'string',
        description: 'The uid of the element to drag'
      },
      to_uid: {
        type: 'string',
        description: 'The uid of the element to drop into'
      }
    },
    required: ['from_uid', 'to_uid']
  },
  handler: async (params, context): Promise<ToolResult> => {
    const fromUid = params.from_uid as string
    const toUid = params.to_uid as string

    if (!context.getActiveViewId()) {
      return {
        content: 'No active browser page.',
        isError: true
      }
    }

    try {
      await context.dragElement(fromUid, toUid)
      return {
        content: 'Successfully dragged an element'
      }
    } catch (error) {
      return {
        content: `Failed to drag: ${(error as Error).message}`,
        isError: true
      }
    }
  }
}

/**
 * press_key - Press a keyboard key
 * Aligned with chrome-devtools-mcp: press_key
 */
export const pressKeyTool: AIBrowserTool = {
  name: 'browser_press_key',
  description: 'Press a key or key combination. Use this when other input methods like fill() cannot be used (e.g., keyboard shortcuts, navigation keys, or special key combinations).',
  category: 'input',
  inputSchema: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        description: 'A key or a combination (e.g., "Enter", "Control+A", "Control++", "Control+Shift+R"). Modifiers: Control, Shift, Alt, Meta'
      }
    },
    required: ['key']
  },
  handler: async (params, context): Promise<ToolResult> => {
    const key = params.key as string

    if (!context.getActiveViewId()) {
      return {
        content: 'No active browser page.',
        isError: true
      }
    }

    try {
      await context.pressKey(key)
      return {
        content: `Successfully pressed key: ${key}`
      }
    } catch (error) {
      return {
        content: `Failed to press key: ${(error as Error).message}`,
        isError: true
      }
    }
  }
}

/**
 * upload_file - Upload a file to a file input
 * Aligned with chrome-devtools-mcp: upload_file
 */
export const uploadFileTool: AIBrowserTool = {
  name: 'browser_upload_file',
  description: 'Upload a file through a provided element.',
  category: 'input',
  inputSchema: {
    type: 'object',
    properties: {
      uid: {
        type: 'string',
        description: 'The uid of the file input element or an element that will open file chooser on the page from the page content snapshot'
      },
      filePath: {
        type: 'string',
        description: 'The local path of the file to upload'
      }
    },
    required: ['uid', 'filePath']
  },
  handler: async (params, context): Promise<ToolResult> => {
    const uid = params.uid as string
    const filePath = params.filePath as string

    if (!context.getActiveViewId()) {
      return {
        content: 'No active browser page.',
        isError: true
      }
    }

    try {
      const element = context.getElementByUid(uid)
      if (!element) {
        throw new Error(`Element not found: ${uid}`)
      }

      // Use CDP to set files on the input
      await context.sendCDPCommand('DOM.setFileInputFiles', {
        backendNodeId: element.backendNodeId,
        files: [filePath]
      })

      return {
        content: `File uploaded from ${filePath}.`
      }
    } catch (error) {
      return {
        content: `Failed to upload file: ${(error as Error).message}`,
        isError: true
      }
    }
  }
}

// Export all input tools (handle_dialog moved to navigation.ts for better organization)
export const inputTools: AIBrowserTool[] = [
  clickTool,
  hoverTool,
  fillTool,
  fillFormTool,
  dragTool,
  pressKeyTool,
  uploadFileTool
]
