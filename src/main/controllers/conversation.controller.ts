/**
 * Conversation Controller - Unified business logic for conversation operations
 * Used by both IPC handlers and HTTP routes
 */

import {
  listConversations as serviceListConversations,
  createConversation as serviceCreateConversation,
  getConversation as serviceGetConversation,
  updateConversation as serviceUpdateConversation,
  deleteConversation as serviceDeleteConversation,
  addMessage as serviceAddMessage,
  updateLastMessage as serviceUpdateLastMessage
} from '../services/conversation.service'

export interface ControllerResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

/**
 * List all conversations for a space
 */
export function listConversations(spaceId: string): ControllerResponse {
  try {
    const conversations = serviceListConversations(spaceId)
    return { success: true, data: conversations }
  } catch (error: unknown) {
    const err = error as Error
    return { success: false, error: err.message }
  }
}

/**
 * Create a new conversation
 */
export function createConversation(spaceId: string, title?: string): ControllerResponse {
  try {
    const conversation = serviceCreateConversation(spaceId, title)
    return { success: true, data: conversation }
  } catch (error: unknown) {
    const err = error as Error
    return { success: false, error: err.message }
  }
}

/**
 * Get a specific conversation
 */
export function getConversation(spaceId: string, conversationId: string): ControllerResponse {
  try {
    const conversation = serviceGetConversation(spaceId, conversationId)
    if (conversation) {
      return { success: true, data: conversation }
    }
    return { success: false, error: 'Conversation not found' }
  } catch (error: unknown) {
    const err = error as Error
    return { success: false, error: err.message }
  }
}

/**
 * Update a conversation
 */
export function updateConversation(
  spaceId: string,
  conversationId: string,
  updates: Record<string, unknown>
): ControllerResponse {
  try {
    const conversation = serviceUpdateConversation(spaceId, conversationId, updates)
    if (conversation) {
      return { success: true, data: conversation }
    }
    return { success: false, error: 'Failed to update conversation' }
  } catch (error: unknown) {
    const err = error as Error
    return { success: false, error: err.message }
  }
}

/**
 * Delete a conversation
 */
export function deleteConversation(spaceId: string, conversationId: string): ControllerResponse {
  try {
    const result = serviceDeleteConversation(spaceId, conversationId)
    return { success: result }
  } catch (error: unknown) {
    const err = error as Error
    return { success: false, error: err.message }
  }
}

/**
 * Add a message to a conversation
 */
export function addMessage(
  spaceId: string,
  conversationId: string,
  message: { role: string; content: string }
): ControllerResponse {
  try {
    const newMessage = serviceAddMessage(spaceId, conversationId, message as any)
    return { success: true, data: newMessage }
  } catch (error: unknown) {
    const err = error as Error
    return { success: false, error: err.message }
  }
}

/**
 * Update the last message in a conversation
 */
export function updateLastMessage(
  spaceId: string,
  conversationId: string,
  updates: Record<string, unknown>
): ControllerResponse {
  try {
    const message = serviceUpdateLastMessage(spaceId, conversationId, updates)
    if (message) {
      return { success: true, data: message }
    }
    return { success: false, error: 'Failed to update message' }
  } catch (error: unknown) {
    const err = error as Error
    return { success: false, error: err.message }
  }
}
