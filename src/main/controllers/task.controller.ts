/**
 * Task State Controller - Unified business logic for task-panel bookkeeping
 * Used by both IPC handlers and HTTP routes
 */

import { getTaskStateService } from '../platform/task-state'
import type { ConversationTaskState } from '../platform/task-state'

export interface ControllerResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

function requireService(): ControllerResponse<never> | null {
  if (getTaskStateService()) return null
  return { success: false, error: 'Task state service not initialized' }
}

/** List all persisted task-state rows (unseen completions + read grace-period entries). */
export function listTaskState(): ControllerResponse<ConversationTaskState[]> {
  const notReady = requireService()
  if (notReady) return notReady
  try {
    return { success: true, data: getTaskStateService()!.list() }
  } catch (error: unknown) {
    return { success: false, error: (error as Error).message }
  }
}

export function markTaskUnseen(conversationId: string, spaceId: string, title: string): ControllerResponse {
  const notReady = requireService()
  if (notReady) return notReady
  try {
    getTaskStateService()!.markUnseen(conversationId, spaceId, title)
    return { success: true }
  } catch (error: unknown) {
    return { success: false, error: (error as Error).message }
  }
}

export function markTaskRead(
  conversationId: string,
  spaceId: string,
  title: string,
  originalStatus: 'completed-unseen' | 'error'
): ControllerResponse {
  const notReady = requireService()
  if (notReady) return notReady
  try {
    getTaskStateService()!.markRead(conversationId, spaceId, title, originalStatus)
    return { success: true }
  } catch (error: unknown) {
    return { success: false, error: (error as Error).message }
  }
}

export function setTaskKept(conversationId: string, kept: boolean): ControllerResponse {
  const notReady = requireService()
  if (notReady) return notReady
  try {
    getTaskStateService()!.setKept(conversationId, kept)
    return { success: true }
  } catch (error: unknown) {
    return { success: false, error: (error as Error).message }
  }
}

export function removeTaskState(conversationId: string): ControllerResponse {
  const notReady = requireService()
  if (notReady) return notReady
  try {
    getTaskStateService()!.remove(conversationId)
    return { success: true }
  } catch (error: unknown) {
    return { success: false, error: (error as Error).message }
  }
}
