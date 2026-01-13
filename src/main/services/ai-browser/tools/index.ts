/**
 * AI Browser Tools - Export all tools
 *
 * This module exports all 26 AI Browser tools organized by category.
 */

import type { AIBrowserTool } from '../types'
import { navigationTools } from './navigation'
import { inputTools } from './input'
import { snapshotTools } from './snapshot'
import { networkTools } from './network'
import { consoleTools } from './console'
import { emulationTools } from './emulation'
import { performanceTools } from './performance'

/**
 * All AI Browser tools
 */
export const allTools: AIBrowserTool[] = [
  ...navigationTools,    // 6 tools
  ...inputTools,         // 8 tools
  ...snapshotTools,      // 3 tools
  ...networkTools,       // 2 tools
  ...consoleTools,       // 2 tools
  ...emulationTools,     // 2 tools
  ...performanceTools    // 3 tools
]

/**
 * Get all tool names for SDK registration
 */
export function getToolNames(): string[] {
  return allTools.map(t => t.name)
}

/**
 * Find a tool by name
 */
export function findTool(name: string): AIBrowserTool | undefined {
  return allTools.find(t => t.name === name)
}

/**
 * Get tools by category
 */
export function getToolsByCategory(category: string): AIBrowserTool[] {
  return allTools.filter(t => t.category === category)
}

/**
 * Get tool definitions for SDK (name, description, inputSchema)
 */
export function getToolDefinitions(): Array<{
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}> {
  return allTools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: 'object' as const,
      properties: tool.inputSchema.properties as Record<string, unknown>,
      required: tool.inputSchema.required
    }
  }))
}

// Re-export individual tool groups
export { navigationTools } from './navigation'
export { inputTools } from './input'
export { snapshotTools } from './snapshot'
export { networkTools } from './network'
export { consoleTools } from './console'
export { emulationTools } from './emulation'
export { performanceTools } from './performance'
