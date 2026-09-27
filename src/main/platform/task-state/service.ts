/**
 * task-state -- Service
 *
 * Business logic on top of TaskStateStore: broadcasts `task:state_changed`
 * after every mutation (so desktop + remote web clients stay in sync without
 * polling) and runs a periodic sweep that deletes expired, non-kept 'read'
 * rows -- the persisted equivalent of the renderer's 60s auto-removal timer,
 * except this one only needs to run occasionally since the renderer already
 * hides expired items on its own; the sweep just prevents the table from
 * growing unbounded if a client never reconnects to observe the expiry.
 */

import { sendToRenderer } from '../../foundation/window.service'
import { broadcastToAll } from '../../http/websocket'
import { isAppChatKey } from '../../../shared/apps/im-keys'
import { TaskStateStore } from './store'
import type { ConversationTaskState } from './types'

const CHANNEL = 'task:state_changed'
/** Mirrors the renderer's PULSE_READ_GRACE_PERIOD_MS (types/index.ts). */
const GRACE_PERIOD_MS = 60_000
const SWEEP_INTERVAL_MS = 60 * 60 * 1000

export interface TaskStateService {
  list(): ConversationTaskState[]
  markUnseen(conversationId: string, spaceId: string, title: string): void
  markRead(conversationId: string, spaceId: string, title: string, originalStatus: 'completed-unseen' | 'error'): void
  setKept(conversationId: string, kept: boolean): void
  remove(conversationId: string): void
  deleteAllInSpace(spaceId: string): void
  dispose(): void
}

function broadcast(): void {
  // No payload -- clients re-fetch via taskListState. The row set is small
  // (bounded by concurrently-completed conversations) and mutations already
  // happen one at a time, so a full re-list is simpler than diffing patches
  // across two transports and not a meaningful cost.
  sendToRenderer(CHANNEL, {})
  broadcastToAll(CHANNEL, {})
}

export function createTaskStateService(store: TaskStateStore): TaskStateService {
  const sweepTimer = setInterval(() => {
    const removed = store.deleteExpiredRead(GRACE_PERIOD_MS)
    if (removed > 0) {
      console.log(`[TaskState] Swept ${removed} expired row(s)`)
      broadcast()
    }
  }, SWEEP_INTERVAL_MS)

  // Sweep once on startup too, so rows left over from a crash (or a change
  // to GRACE_PERIOD_MS) don't wait a full hour to clear.
  const initialRemoved = store.deleteExpiredRead(GRACE_PERIOD_MS)
  if (initialRemoved > 0) {
    console.log(`[TaskState] Swept ${initialRemoved} expired row(s) on startup`)
  }

  return {
    list: () => store.list(),

    markUnseen(conversationId, spaceId, title) {
      if (isAppChatKey(conversationId)) return
      store.upsertUnseen(conversationId, spaceId, title, Date.now())
      broadcast()
    },

    markRead(conversationId, spaceId, title, originalStatus) {
      if (isAppChatKey(conversationId)) return
      store.upsertRead(conversationId, spaceId, title, originalStatus, Date.now())
      broadcast()
    },

    setKept(conversationId, kept) {
      store.setKept(conversationId, kept)
      broadcast()
    },

    remove(conversationId) {
      store.remove(conversationId)
      broadcast()
    },

    deleteAllInSpace(spaceId) {
      store.deleteAllInSpace(spaceId)
    },

    dispose() {
      clearInterval(sweepTimer)
    },
  }
}
