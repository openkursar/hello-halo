/**
 * Conversation IPC Handlers
 */

import { ipcMain } from 'electron'
import {
  listConversations,
  createConversation,
  getConversation,
  updateConversation,
  deleteConversation,
  addMessage,
  updateLastMessage
} from '../services/conversation.service'

export function registerConversationHandlers(): void {
  // List conversations for a space
  ipcMain.handle('conversation:list', async (_event, spaceId: string) => {
    try {
      const conversations = listConversations(spaceId)
      return { success: true, data: conversations }
    } catch (error: unknown) {
      const err = error as Error
      return { success: false, error: err.message }
    }
  })

  // Create a new conversation
  ipcMain.handle('conversation:create', async (_event, spaceId: string, title?: string) => {
    try {
      const conversation = createConversation(spaceId, title)
      return { success: true, data: conversation }
    } catch (error: unknown) {
      const err = error as Error
      return { success: false, error: err.message }
    }
  })

  // Get a specific conversation
  ipcMain.handle('conversation:get', async (_event, spaceId: string, conversationId: string) => {
    try {
      const conversation = getConversation(spaceId, conversationId)
      return { success: true, data: conversation }
    } catch (error: unknown) {
      const err = error as Error
      return { success: false, error: err.message }
    }
  })

  // Update a conversation
  ipcMain.handle(
    'conversation:update',
    async (_event, spaceId: string, conversationId: string, updates: Record<string, unknown>) => {
      try {
        const conversation = updateConversation(spaceId, conversationId, updates)
        return { success: true, data: conversation }
      } catch (error: unknown) {
        const err = error as Error
        return { success: false, error: err.message }
      }
    }
  )

  // Delete a conversation
  ipcMain.handle('conversation:delete', async (_event, spaceId: string, conversationId: string) => {
    try {
      const result = deleteConversation(spaceId, conversationId)
      return { success: true, data: result }
    } catch (error: unknown) {
      const err = error as Error
      return { success: false, error: err.message }
    }
  })

  // Add a message to a conversation
  ipcMain.handle(
    'conversation:add-message',
    async (
      _event,
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
    }
  )

  // Update the last message (for saving content and thoughts)
  ipcMain.handle(
    'conversation:update-last-message',
    async (
      _event,
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
    }
  )
}
