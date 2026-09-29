/**
 * What the user has open in the content canvas, sent with a chat message so the
 * agent can refer to it naturally ("this file", "the terminal on the right").
 *
 * Shared by every chat entry point that accepts it (space chat, digital-human
 * chat) and by the renderer that builds it.
 */
export interface CanvasContext {
  isOpen: boolean
  tabCount: number
  activeTab: {
    type: string  // 'browser' | 'code' | 'markdown' | 'image' | 'pdf' | 'text' | 'json' | 'csv' | 'terminal'
    title: string
    url?: string   // For browser/pdf tabs
    path?: string  // For file tabs
    terminalSessionId?: string  // For terminal tabs - the pty session id the AI drives via terminal_* tools
  } | null
  tabs: Array<{
    type: string
    title: string
    url?: string
    path?: string
    terminalSessionId?: string  // For terminal tabs - the pty session id the AI drives via terminal_* tools
    isActive: boolean
  }>
}
