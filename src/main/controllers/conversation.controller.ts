/**		      	    				  	  	  	 		 		       	 	 	         	 	    					 
 * Conversation Controller - Unified business logic for conversation operations
 * Used by both IPC handlers and HTTP routes
 */

import {
  listConversations as serviceListConversations,
  createConversation as serviceCreateConversation,
  getConversation as serviceGetConversation,
  getConversationFrom as serviceGetConversationFrom,
  updateConversation as serviceUpdateConversation,
  deleteConversation as serviceDeleteConversation,
  addMessage as serviceAddMessage,
  updateLastMessage as serviceUpdateLastMessage,
  getMessageThoughts as serviceGetMessageThoughts,
  toggleStarConversation as serviceToggleStarConversation
} from '../services/conversation.service'
import { closeV2Session, resolveDefaultEngine, ensureEngineAvailable, assertEngineSourceSelection, getLegacyEngine } from '../services/agent'
import { isEngineId } from '../../shared/types/engine'
import { getTaskStateService } from '../platform/task-state'

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
export async function createConversation(
  spaceId: string,
  title?: string,
  reasoningEffort?: unknown,
  options?: { ephemeral?: boolean }
): Promise<ControllerResponse> {
  try {
    const conversation = serviceCreateConversation(spaceId, title, reasoningEffort, { ephemeral: options?.ephemeral === true, engineId: await resolveDefaultEngine() })
    return { success: true, data: conversation }
  } catch (error: unknown) {
    const err = error as Error
    return { success: false, error: err.message }
  }
}

/**
 * Get a specific conversation
 */
export function getConversation(spaceId: string, conversationId: string, fromMessageId?: string): ControllerResponse {
  try {
    const conversation = fromMessageId
      ? serviceGetConversationFrom(spaceId, conversationId, fromMessageId)
      : serviceGetConversation(spaceId, conversationId)
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
export async function updateConversation(
  spaceId: string,
  conversationId: string,
  updates: Record<string, unknown>
): Promise<ControllerResponse> {
  try {
    let editable = updates
    if (['engineOverride', 'modelSourceId', 'modelId'].some(key => key in updates)) {
      const current = serviceGetConversation(spaceId, conversationId)
      if (!current) return { success: false, error: 'Conversation not found' }
      const snapshot = JSON.stringify([current.engineOverride, current.modelSourceId, current.modelId])
      if ('engineOverride' in updates) {
        const requested = updates.engineOverride
        if (requested !== null && requested !== undefined && !isEngineId(requested)) throw new Error('Unknown agent engine')
        if (isEngineId(requested)) await ensureEngineAvailable(requested)
        editable = { ...updates, engineOverride: requested ?? undefined }
      }
      const selected = { ...current, ...editable }
      const targetEngine = selected.engineOverride ?? selected.engineBinding?.engineId
        ?? (selected.engineRoutingVersion === 1 && isEngineId(selected.engineId) ? selected.engineId : getLegacyEngine())
      await assertEngineSourceSelection(targetEngine, selected)
      const fresh = serviceGetConversation(spaceId, conversationId)
      if (!fresh || snapshot !== JSON.stringify([fresh.engineOverride, fresh.modelSourceId, fresh.modelId])) {
        throw new Error('The engine or model selection changed while saving. Please try again.')
      }
    }
    const conversation = serviceUpdateConversation(spaceId, conversationId, editable)
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
    // Close the conversation's CC session (idempotent) so the subprocess dies
    // with the record instead of lingering until the 30-min idle sweep.
    closeV2Session(conversationId)
    const result = serviceDeleteConversation(spaceId, conversationId)
    getTaskStateService()?.remove(conversationId)
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

/**
 * Get thoughts for a specific message (lazy loading)
 */
export function getMessageThoughts(
  spaceId: string,
  conversationId: string,
  messageId: string
): ControllerResponse {
  try {
    const thoughts = serviceGetMessageThoughts(spaceId, conversationId, messageId)
    return { success: true, data: thoughts }
  } catch (error: unknown) {
    const err = error as Error
    return { success: false, error: err.message }
  }
}

/**
 * Toggle starred status on a conversation
 */
export function toggleStarConversation(
  spaceId: string,
  conversationId: string,
  starred: boolean
): ControllerResponse {
  try {
    const meta = serviceToggleStarConversation(spaceId, conversationId, starred)
    if (meta) {
      return { success: true, data: meta }
    }
    return { success: false, error: 'Conversation not found' }
  } catch (error: unknown) {
    const err = error as Error
    return { success: false, error: err.message }
  }
}
