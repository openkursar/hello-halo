/**
 * conversationApi — conversation domain slice of the unified api object.
 * Split from the monolithic api/index.ts; transport branch (IPC vs HTTP) preserved.
 */
import {
  httpRequest,
  isElectron,
} from './_shared'
import type {
  ApiResponse,
} from './_shared'

export const conversationApi = {
  // ===== Conversation =====
  listConversations: async (spaceId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.listConversations(spaceId)
    }
    return httpRequest('GET', `/api/spaces/${spaceId}/conversations`)
  },

  createConversation: async (spaceId: string, title?: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.createConversation(spaceId, title)
    }
    return httpRequest('POST', `/api/spaces/${spaceId}/conversations`, { title })
  },

  getConversation: async (
    spaceId: string,
    conversationId: string
  ): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.getConversation(spaceId, conversationId)
    }
    return httpRequest('GET', `/api/spaces/${spaceId}/conversations/${conversationId}`)
  },

  updateConversation: async (
    spaceId: string,
    conversationId: string,
    updates: Record<string, unknown>
  ): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.updateConversation(spaceId, conversationId, updates)
    }
    return httpRequest(
      'PUT',
      `/api/spaces/${spaceId}/conversations/${conversationId}`,
      updates
    )
  },

  deleteConversation: async (
    spaceId: string,
    conversationId: string
  ): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.deleteConversation(spaceId, conversationId)
    }
    return httpRequest(
      'DELETE',
      `/api/spaces/${spaceId}/conversations/${conversationId}`
    )
  },

  addMessage: async (
    spaceId: string,
    conversationId: string,
    message: { role: string; content: string }
  ): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.addMessage(spaceId, conversationId, message)
    }
    return httpRequest(
      'POST',
      `/api/spaces/${spaceId}/conversations/${conversationId}/messages`,
      message
    )
  },

  updateLastMessage: async (
    spaceId: string,
    conversationId: string,
    updates: Record<string, unknown>
  ): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.updateLastMessage(spaceId, conversationId, updates)
    }
    return httpRequest(
      'PUT',
      `/api/spaces/${spaceId}/conversations/${conversationId}/messages/last`,
      updates
    )
  },

  getMessageThoughts: async (
    spaceId: string,
    conversationId: string,
    messageId: string
  ): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.getMessageThoughts(spaceId, conversationId, messageId)
    }
    return httpRequest(
      'GET',
      `/api/spaces/${spaceId}/conversations/${conversationId}/messages/${messageId}/thoughts`
    )
  },

  toggleStarConversation: async (
    spaceId: string,
    conversationId: string,
    starred: boolean
  ): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.toggleStarConversation(spaceId, conversationId, starred)
    }
    return httpRequest(
      'POST',
      `/api/spaces/${spaceId}/conversations/${conversationId}/star`,
      { starred }
    )
  },

}
