/**
 * Conversation IPC Handlers
 */

import {
  listConversations,
  createConversation,
  getConversation,
  updateConversation,
  deleteConversation,
  addMessage,
  updateLastMessage,
  getMessageThoughts,
  toggleStarConversation
} from '../services/conversation.service'
import { conversationRpc } from '../../shared/rpc/contracts/conversation.contract'
import { registerRawRpcHandlers } from './rpc'

export function registerConversationHandlers(): void {
  registerRawRpcHandlers(conversationRpc, {
    // List conversations for a space
    listConversations: async (spaceId: string) => {
      try {
        const conversations = listConversations(spaceId)
        return { success: true, data: conversations }
      } catch (error: unknown) {
        const err = error as Error
        return { success: false, error: err.message }
      }
    },

    // Create a new conversation
    createConversation: async (spaceId: string, title?: string) => {
      try {
        const conversation = createConversation(spaceId, title)
        return { success: true, data: conversation }
      } catch (error: unknown) {
        const err = error as Error
        return { success: false, error: err.message }
      }
    },

    // Get a specific conversation
    getConversation: async (spaceId: string, conversationId: string) => {
      try {
        const conversation = getConversation(spaceId, conversationId)
        return { success: true, data: conversation }
      } catch (error: unknown) {
        const err = error as Error
        return { success: false, error: err.message }
      }
    },

    // Update a conversation
    updateConversation: async (spaceId: string, conversationId: string, updates: Record<string, unknown>) => {
      try {
        const conversation = updateConversation(spaceId, conversationId, updates)
        return { success: true, data: conversation }
      } catch (error: unknown) {
        const err = error as Error
        return { success: false, error: err.message }
      }
    },

    // Delete a conversation
    deleteConversation: async (spaceId: string, conversationId: string) => {
      try {
        const result = deleteConversation(spaceId, conversationId)
        return { success: true, data: result }
      } catch (error: unknown) {
        const err = error as Error
        return { success: false, error: err.message }
      }
    },

    // Add a message to a conversation
    addMessage: async (
      spaceId: string,
      conversationId: string,
      message: { role: 'user' | 'assistant' | 'system'; content: string }
    ) => {
      try {
        const newMessage = addMessage(spaceId, conversationId, message)
        return { success: true, data: newMessage }
      } catch (error: unknown) {
        const err = error as Error
        return { success: false, error: err.message }
      }
    },

    // Update the last message (for saving content and thoughts)
    updateLastMessage: async (
      spaceId: string,
      conversationId: string,
      updates: Record<string, unknown>
    ) => {
      try {
        const message = updateLastMessage(spaceId, conversationId, updates)
        return { success: true, data: message }
      } catch (error: unknown) {
        const err = error as Error
        return { success: false, error: err.message }
      }
    },

    // Get thoughts for a specific message (lazy loading)
    getMessageThoughts: async (
      spaceId: string,
      conversationId: string,
      messageId: string
    ) => {
      try {
        const thoughts = getMessageThoughts(spaceId, conversationId, messageId)
        return { success: true, data: thoughts }
      } catch (error: unknown) {
        const err = error as Error
        return { success: false, error: err.message }
      }
    },

    // Toggle starred status on a conversation
    toggleStarConversation: async (
      spaceId: string,
      conversationId: string,
      starred: boolean
    ) => {
      try {
        const meta = toggleStarConversation(spaceId, conversationId, starred)
        if (meta) {
          return { success: true, data: meta }
        }
        return { success: false, error: 'Conversation not found' }
      } catch (error: unknown) {
        const err = error as Error
        return { success: false, error: err.message }
      }
    },
  })
}
