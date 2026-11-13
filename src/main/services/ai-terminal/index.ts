/**
 * AI Terminal Module - Public API
 *
 * Interactive pty terminal that the AI controls via MCP tools and the user can
 * see and take over. Registered as an on-demand toolset (see agent/toolsets).
 *
 * Platform note: Linux is intentionally excluded at the packaging layer
 * (node-pty prebuilds omitted). isTerminalAvailable() gates the whole feature
 * so it never appears in the capability index / menu on unsupported platforms.
 */

export { createTerminalMcpServer } from './sdk-mcp-server'
export {
  getGlobalTerminalContext,
  peekGlobalTerminalContext,
  cleanupAITerminal
} from './context'
export { isTerminalAvailable } from './available'
export {
  listTerminals,
  terminalInput,
  terminalResize,
  killTerminal,
  getTerminalReplay,
  createTerminalForUser,
  terminalViewerAttach,
  terminalViewerDetach,
  terminalViewerAck,
  terminalViewerDisconnected
} from './service'
export {
  onTerminalData,
  onTerminalLifecycle
} from './events'
export type { TerminalContext } from './context'
export type {
  TerminalInfo,
  TerminalDataEvent,
  TerminalLifecycleEvent,
  CreateTerminalOptions
} from '../../../shared/types/terminal'

export { AI_TERMINAL_DESCRIPTION, AI_TERMINAL_INSTRUCTIONS } from './guidance'
