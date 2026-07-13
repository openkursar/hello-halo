/**
 * agentApi — agent domain slice of the unified api object.
 * Split from the monolithic api/index.ts; transport branch (IPC vs HTTP) preserved.
 */
import {
  httpRequest,
  isElectron,
  subscribeToConversation,
} from './_shared'
import type {
  ApiResponse,
} from './_shared'

export const agentApi = {
  // ===== Agent =====
  sendMessage: async (request: {
    spaceId: string
    conversationId: string
    message: string
    resumeSessionId?: string
    images?: Array<{
      id: string
      type: 'image'
      mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
      data: string
      name?: string
      size?: number
    }>
    thinkingEnabled?: boolean  // Enable extended thinking mode
    canvasContext?: {  // Canvas context for AI awareness
      isOpen: boolean
      tabCount: number
      activeTab: {
        type: string
        title: string
        url?: string
        path?: string
        terminalSessionId?: string
      } | null
      tabs: Array<{
        type: string
        title: string
        url?: string
        path?: string
        terminalSessionId?: string
        isActive: boolean
      }>
    }
  }): Promise<ApiResponse> => {
    // Subscribe to conversation events before sending
    if (!isElectron()) {
      subscribeToConversation(request.conversationId)
    }

    if (isElectron()) {
      return window.halo.sendMessage(request)
    }
    return httpRequest('POST', '/api/agent/message', request)
  },

  stopGeneration: async (conversationId?: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.stopGeneration(conversationId)
    }
    return httpRequest('POST', '/api/agent/stop', { conversationId })
  },

  approveTool: async (conversationId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.approveTool(conversationId)
    }
    return httpRequest('POST', '/api/agent/approve', { conversationId })
  },

  rejectTool: async (conversationId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.rejectTool(conversationId)
    }
    return httpRequest('POST', '/api/agent/reject', { conversationId })
  },

  // Get current session state for recovery after refresh
  getSessionState: async (conversationId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.getSessionState(conversationId)
    }
    return httpRequest('GET', `/api/agent/session/${conversationId}`)
  },

  // Warm up V2 session - call when switching conversations to prepare for faster message sending
  ensureSessionWarm: async (spaceId: string, conversationId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      // No need to wait, initialize in background
      window.halo.ensureSessionWarm(spaceId, conversationId).catch((error: unknown) => {
        console.error('[API] ensureSessionWarm error:', error)
      })
      return { success: true }
    }
    // HTTP mode: send warm-up request to backend
    return httpRequest('POST', '/api/agent/warm', { spaceId, conversationId }).catch(() => ({
      success: false // Warm-up failure should not block
    }))
  },

  // Answer a pending AskUserQuestion
  answerQuestion: async (data: {
    conversationId: string
    id: string
    answers: Record<string, string>
  }): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.answerQuestion(data)
    }
    return httpRequest('POST', '/api/agent/answer-question', data)
  },

  // Inject a mid-turn message into an active session (Agent Team mode)
  injectMessage: async (data: { conversationId: string; message: string }): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.injectMessage(data)
    }
    return httpRequest('POST', '/api/agent/inject-message', data)
  },

  // Test MCP server connections
  testMcpConnections: async (): Promise<{ success: boolean; servers: unknown[]; error?: string }> => {
    if (isElectron()) {
      return window.halo.testMcpConnections()
    }
    // HTTP mode: call backend endpoint
    const result = await httpRequest('POST', '/api/agent/test-mcp')
    return result as { success: boolean; servers: unknown[]; error?: string }
  },

  // Get the active engine's capability descriptor. Renderer caches this in
  // a Zustand store and uses the flags to drive engine-aware UI affordances.
  getEngineCapabilities: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.getEngineCapabilities()
    }
    return httpRequest('GET', '/api/agent/engine-capabilities')
  },

  // ===== Toolset broker (on-demand MCP toolsets) =====
  listToolsets: async (spaceId: string, conversationId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.listToolsets({ spaceId, conversationId })
    }
    return httpRequest('POST', '/api/agent/toolsets/list', { spaceId, conversationId })
  },

  openToolset: async (spaceId: string, conversationId: string, toolsetId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.openToolset({ spaceId, conversationId, toolsetId })
    }
    return httpRequest('POST', '/api/agent/toolsets/open', { spaceId, conversationId, toolsetId })
  },

  closeToolset: async (spaceId: string, conversationId: string, toolsetId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.closeToolset({ spaceId, conversationId, toolsetId })
    }
    return httpRequest('POST', '/api/agent/toolsets/close', { spaceId, conversationId, toolsetId })
  },

  // ===== Terminal (user-facing viewer operations) =====
  listTerminals: async (): Promise<ApiResponse> => {
    if (isElectron()) return window.halo.listTerminals()
    return httpRequest('GET', '/api/terminal/list')
  },

  createTerminal: async (data: { spaceId: string; shell?: string; cwd?: string; title?: string }): Promise<ApiResponse> => {
    if (isElectron()) return window.halo.createTerminal(data)
    return httpRequest('POST', '/api/terminal/create', data)
  },

  terminalInput: async (sessionId: string, data: string): Promise<ApiResponse> => {
    if (isElectron()) return window.halo.terminalInput({ sessionId, data })
    return httpRequest('POST', '/api/terminal/input', { sessionId, data })
  },

  terminalResize: async (sessionId: string, cols: number, rows: number): Promise<ApiResponse> => {
    if (isElectron()) return window.halo.terminalResize({ sessionId, cols, rows })
    return httpRequest('POST', '/api/terminal/resize', { sessionId, cols, rows })
  },

  killTerminal: async (sessionId: string): Promise<ApiResponse> => {
    if (isElectron()) return window.halo.killTerminal({ sessionId })
    return httpRequest('POST', '/api/terminal/kill', { sessionId })
  },

  getTerminalReplay: async (sessionId: string): Promise<ApiResponse> => {
    if (isElectron()) return window.halo.getTerminalReplay({ sessionId })
    return httpRequest('POST', '/api/terminal/replay', { sessionId })
  },

}
