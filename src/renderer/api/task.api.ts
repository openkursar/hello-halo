/**
 * taskApi — task panel bookkeeping domain slice of the unified api object.
 * Persists completed-but-unseen conversations and their post-view grace
 * period so they survive an app restart (previously renderer-memory only).
 */
import {
  httpRequest,
  isElectron,
  onEvent,
} from './_shared'
import type {
  ApiResponse,
} from './_shared'

export const taskApi = {
  taskListState: async (): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.taskListState()
    }
    return httpRequest('GET', '/api/task-state')
  },

  taskMarkUnseen: async (conversationId: string, spaceId: string, title: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.taskMarkUnseen(conversationId, spaceId, title)
    }
    return httpRequest('POST', '/api/task-state/mark-unseen', { conversationId, spaceId, title })
  },

  taskMarkRead: async (
    conversationId: string,
    spaceId: string,
    title: string,
    originalStatus: 'completed-unseen' | 'error'
  ): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.taskMarkRead(conversationId, spaceId, title, originalStatus)
    }
    return httpRequest('POST', '/api/task-state/mark-read', { conversationId, spaceId, title, originalStatus })
  },

  taskSetKept: async (conversationId: string, kept: boolean): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.taskSetKept(conversationId, kept)
    }
    return httpRequest('POST', '/api/task-state/set-kept', { conversationId, kept })
  },

  taskRemoveState: async (conversationId: string): Promise<ApiResponse> => {
    if (isElectron()) {
      return window.halo.taskRemoveState(conversationId)
    }
    return httpRequest('POST', '/api/task-state/remove', { conversationId })
  },

  onTaskStateChanged: (callback: (data: unknown) => void) =>
    onEvent('task:state_changed', callback),
}
