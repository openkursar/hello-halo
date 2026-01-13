/**
 * Network Tools - Network request monitoring and inspection
 *
 * Tools for viewing and analyzing network traffic.
 * Tool descriptions aligned with chrome-devtools-mcp for 100% compatibility.
 */

import type { AIBrowserTool, ToolResult, NetworkRequest } from '../types'

// Resource types that can be filtered
const FILTERABLE_RESOURCE_TYPES = [
  'document',
  'stylesheet',
  'image',
  'media',
  'font',
  'script',
  'texttrack',
  'xhr',
  'fetch',
  'prefetch',
  'eventsource',
  'websocket',
  'manifest',
  'signedexchange',
  'ping',
  'cspviolationreport',
  'preflight',
  'fedcm',
  'other'
] as const

/**
 * list_network_requests - List all captured network requests
 * Aligned with chrome-devtools-mcp: list_network_requests
 */
export const listNetworkRequestsTool: AIBrowserTool = {
  name: 'browser_network_requests',
  description: `List all requests for the currently selected page since the last navigation.`,
  category: 'network',
  inputSchema: {
    type: 'object',
    properties: {
      pageSize: {
        type: 'number',
        description: 'Maximum number of requests to return. When omitted, returns all requests.'
      },
      pageIdx: {
        type: 'number',
        description: 'Page number to return (0-based). When omitted, returns the first page.'
      },
      resourceTypes: {
        type: 'array',
        description: 'Filter requests to only return requests of the specified resource types. When omitted or empty, returns all requests.',
        items: {
          type: 'string',
          enum: FILTERABLE_RESOURCE_TYPES as unknown as string[]
        }
      },
      includePreservedRequests: {
        type: 'boolean',
        description: 'Set to true to return the preserved requests over the last 3 navigations.'
      }
    }
  },
  handler: async (params, context): Promise<ToolResult> => {
    const resourceTypes = params.resourceTypes as string[] | undefined
    const pageIdx = (params.pageIdx as number) || 0
    const pageSize = params.pageSize as number | undefined
    const includePreserved = params.includePreservedRequests as boolean || false

    let requests = context.getNetworkRequests(includePreserved)

    // Filter by resource type if specified
    if (resourceTypes && resourceTypes.length > 0) {
      const types = new Set(resourceTypes.map(t => t.toLowerCase()))
      requests = requests.filter(r => types.has(r.resourceType.toLowerCase()))
    }

    const total = requests.length

    // Apply pagination if pageSize is specified
    let pageRequests: NetworkRequest[]
    if (pageSize !== undefined) {
      const startIdx = pageIdx * pageSize
      const endIdx = Math.min(startIdx + pageSize, total)
      pageRequests = requests.slice(startIdx, endIdx)
    } else {
      pageRequests = requests
    }

    if (pageRequests.length === 0) {
      return {
        content: 'No network requests captured.'
      }
    }

    const lines: string[] = []

    if (pageSize !== undefined) {
      const startIdx = pageIdx * pageSize
      const endIdx = Math.min(startIdx + pageSize, total)
      lines.push(`Network Requests (${startIdx + 1}-${endIdx} of ${total}):`)
    } else {
      lines.push(`Network Requests (${total} total):`)
    }
    lines.push('')

    for (const req of pageRequests) {
      const status = req.status ? `${req.status}` : 'pending'
      const duration = req.timing?.duration ? `${req.timing.duration}ms` : '-'

      lines.push(`[reqid=${req.id}] ${req.method} ${status} ${req.resourceType}`)
      lines.push(`    URL: ${req.url.substring(0, 100)}${req.url.length > 100 ? '...' : ''}`)
      lines.push(`    Duration: ${duration}`)
      if (req.error) {
        lines.push(`    Error: ${req.error}`)
      }
      lines.push('')
    }

    if (pageSize !== undefined && pageIdx * pageSize + pageRequests.length < total) {
      lines.push(`Use pageIdx=${pageIdx + 1} to see more requests.`)
    }

    return {
      content: lines.join('\n')
    }
  }
}

/**
 * get_network_request - Get details of a specific network request
 * Aligned with chrome-devtools-mcp: get_network_request
 */
export const getNetworkRequestTool: AIBrowserTool = {
  name: 'browser_network_request',
  description: `Gets a network request by an optional reqid, if omitted returns the currently selected request in the DevTools Network panel.`,
  category: 'network',
  inputSchema: {
    type: 'object',
    properties: {
      reqid: {
        type: 'number',
        description: 'The reqid of the network request. If omitted returns the currently selected request in the DevTools Network panel.'
      }
    }
  },
  handler: async (params, context): Promise<ToolResult> => {
    const reqId = params.reqid as number | undefined

    let request: NetworkRequest | undefined

    if (reqId !== undefined) {
      request = context.getNetworkRequest(String(reqId))
    } else {
      // Get currently selected request (if DevTools integration is available)
      request = context.getSelectedNetworkRequest?.()
      if (!request) {
        return {
          content: 'Nothing is currently selected in the DevTools Network panel.'
        }
      }
    }

    if (!request) {
      return {
        content: `Request not found: ${reqId}`,
        isError: true
      }
    }

    const lines = [
      `# Network Request: reqid=${request.id}`,
      '',
      `## Basic Info`,
      `URL: ${request.url}`,
      `Method: ${request.method}`,
      `Resource Type: ${request.resourceType}`,
      `Status: ${request.status || 'pending'} ${request.statusText || ''}`,
      `MIME Type: ${request.mimeType || 'unknown'}`,
      ''
    ]

    if (request.timing) {
      lines.push(`## Timing`)
      lines.push(`Duration: ${request.timing.duration}ms`)
      lines.push('')
    }

    if (request.requestHeaders && Object.keys(request.requestHeaders).length > 0) {
      lines.push(`## Request Headers`)
      for (const [key, value] of Object.entries(request.requestHeaders)) {
        lines.push(`${key}: ${value}`)
      }
      lines.push('')
    }

    if (request.responseHeaders && Object.keys(request.responseHeaders).length > 0) {
      lines.push(`## Response Headers`)
      for (const [key, value] of Object.entries(request.responseHeaders)) {
        lines.push(`${key}: ${value}`)
      }
      lines.push('')
    }

    if (request.requestBody) {
      lines.push(`## Request Body`)
      lines.push('```')
      lines.push(request.requestBody.substring(0, 2000))
      if (request.requestBody.length > 2000) {
        lines.push('... (truncated)')
      }
      lines.push('```')
      lines.push('')
    }

    if (request.error) {
      lines.push(`## Error`)
      lines.push(request.error)
    }

    return {
      content: lines.join('\n')
    }
  }
}

// Export all network tools
export const networkTools: AIBrowserTool[] = [
  listNetworkRequestsTool,
  getNetworkRequestTool
]
