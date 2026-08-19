/**
 * Toolset Broker - Public API
 *
 * On-demand loading of built-in in-process MCP servers ("toolsets").
 * See registry.ts for how to add a toolset.
 */

export { registerToolset, getAvailableToolsets, getToolset } from './registry'
export {
  openToolset,
  closeToolset,
  requestToolset,
  listToolsetStatuses,
  buildMcpServerRecord,
  buildCreationTimeServers
} from './broker'
export { getOpenToolsets, dropConversationState } from './state'
export { buildToolsetSection } from './capability-index'
export { listToolsets, openToolsetByUser, closeToolsetByUser } from './service'
export type {
  ToolsetDefinition,
  ToolsetScope,
  ToolsetStatus,
  ToolsetOpener,
  ToolsetsChangedEvent
} from './types'
