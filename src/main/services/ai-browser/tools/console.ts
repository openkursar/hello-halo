/**
 * Console Tools - Browser console monitoring
 *
 * Tools for viewing console logs, warnings, and errors.
 * Tool descriptions aligned with chrome-devtools-mcp for 100% compatibility.
 */

import type { AIBrowserTool, ToolResult, ConsoleMessage } from '../types'

// Filterable console message types
const FILTERABLE_MESSAGE_TYPES = [
  'log',
  'debug',
  'info',
  'error',
  'warn',
  'dir',
  'dirxml',
  'table',
  'trace',
  'clear',
  'startGroup',
  'startGroupCollapsed',
  'endGroup',
  'assert',
  'profile',
  'profileEnd',
  'count',
  'timeEnd',
  'verbose',
  'issue'
] as const

/**
 * list_console_messages - List captured console messages
 * Aligned with chrome-devtools-mcp: list_console_messages
 */
export const listConsoleMessagesTool: AIBrowserTool = {
  name: 'browser_console',
  description: 'List all console messages for the currently selected page since the last navigation.',
  category: 'console',
  inputSchema: {
    type: 'object',
    properties: {
      pageSize: {
        type: 'number',
        description: 'Maximum number of messages to return. When omitted, returns all requests.'
      },
      pageIdx: {
        type: 'number',
        description: 'Page number to return (0-based). When omitted, returns the first page.'
      },
      types: {
        type: 'array',
        description: 'Filter messages to only return messages of the specified resource types. When omitted or empty, returns all messages.',
        items: {
          type: 'string',
          enum: FILTERABLE_MESSAGE_TYPES as unknown as string[]
        }
      },
      includePreservedMessages: {
        type: 'boolean',
        description: 'Set to true to return the preserved messages over the last 3 navigations.'
      }
    }
  },
  handler: async (params, context): Promise<ToolResult> => {
    const types = params.types as string[] | undefined
    const pageIdx = (params.pageIdx as number) || 0
    const pageSize = params.pageSize as number | undefined
    const includePreserved = params.includePreservedMessages as boolean || false

    let messages = context.getConsoleMessages(includePreserved)

    // Filter by type if specified
    if (types && types.length > 0) {
      const typeSet = new Set(types)
      messages = messages.filter(m => typeSet.has(m.type))
    }

    const total = messages.length

    // Apply pagination if pageSize is specified
    let pageMessages: ConsoleMessage[]
    if (pageSize !== undefined) {
      const startIdx = pageIdx * pageSize
      const endIdx = Math.min(startIdx + pageSize, total)
      pageMessages = messages.slice(startIdx, endIdx)
    } else {
      pageMessages = messages
    }

    if (pageMessages.length === 0) {
      return {
        content: 'No console messages captured.'
      }
    }

    const lines: string[] = []

    if (pageSize !== undefined) {
      const startIdx = pageIdx * pageSize
      const endIdx = Math.min(startIdx + pageSize, total)
      lines.push(`Console Messages (${startIdx + 1}-${endIdx} of ${total}):`)
    } else {
      lines.push(`Console Messages (${total} total):`)
    }
    lines.push('')

    for (const msg of pageMessages) {
      const time = new Date(msg.timestamp).toLocaleTimeString()

      lines.push(`[msgid=${msg.id}] ${msg.type.toUpperCase()} (${time})`)
      lines.push(`    ${msg.text.substring(0, 200)}${msg.text.length > 200 ? '...' : ''}`)

      if (msg.url) {
        lines.push(`    at ${msg.url}${msg.lineNumber !== undefined ? `:${msg.lineNumber}` : ''}`)
      }

      lines.push('')
    }

    if (pageSize !== undefined && pageIdx * pageSize + pageMessages.length < total) {
      lines.push(`Use pageIdx=${pageIdx + 1} to see more messages.`)
    }

    return {
      content: lines.join('\n')
    }
  }
}

/**
 * get_console_message - Get details of a specific console message
 * Aligned with chrome-devtools-mcp: get_console_message
 */
export const getConsoleMessageTool: AIBrowserTool = {
  name: 'browser_console_message',
  description: `Gets a console message by its ID. You can get all messages by calling browser_console.`,
  category: 'console',
  inputSchema: {
    type: 'object',
    properties: {
      msgid: {
        type: 'number',
        description: 'The msgid of a console message on the page from the listed console messages'
      }
    },
    required: ['msgid']
  },
  handler: async (params, context): Promise<ToolResult> => {
    const msgId = params.msgid as number
    const message = context.getConsoleMessage(String(msgId))

    if (!message) {
      return {
        content: `Message not found: ${msgId}`,
        isError: true
      }
    }

    const time = new Date(message.timestamp).toLocaleString()

    const lines = [
      `# Console Message: msgid=${message.id}`,
      '',
      `## Type: ${message.type.toUpperCase()}`,
      `Timestamp: ${time}`,
      ''
    ]

    if (message.url) {
      lines.push(`## Source`)
      lines.push(`File: ${message.url}`)
      if (message.lineNumber !== undefined) {
        lines.push(`Line: ${message.lineNumber}`)
      }
      lines.push('')
    }

    lines.push(`## Message`)
    lines.push('```')
    lines.push(message.text)
    lines.push('```')

    if (message.stackTrace) {
      lines.push('')
      lines.push(`## Stack Trace`)
      lines.push('```')
      lines.push(message.stackTrace)
      lines.push('```')
    }

    if (message.args && message.args.length > 0) {
      lines.push('')
      lines.push(`## Arguments`)
      lines.push('```json')
      lines.push(JSON.stringify(message.args, null, 2))
      lines.push('```')
    }

    return {
      content: lines.join('\n')
    }
  }
}

// Export all console tools
export const consoleTools: AIBrowserTool[] = [
  listConsoleMessagesTool,
  getConsoleMessageTool
]
