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
import { getAppChatConversationId, isFollowedConversationId } from '../../../shared/apps/im-keys'
import { TaskStateStore } from './store'
import type { ConversationTaskState } from './types'

const CHANNEL = 'task:state_changed'
/** Mirrors the renderer's PULSE_READ_GRACE_PERIOD_MS (types/index.ts). */
const GRACE_PERIOD_MS = 60_000
const SWEEP_INTERVAL_MS = 60 * 60 * 1000

export interface TaskStateService {
  list(): ConversationTaskState[]
  /** Writes for a conversation that no longer exists drop its row instead. */
  markUnseen(conversationId: string, spaceId: string, title: string): void
  markRead(conversationId: string, spaceId: string, title: string, originalStatus: 'completed-unseen' | 'error'): void
  setKept(conversationId: string, kept: boolean): void
  remove(conversationId: string): void
  /** Drop every row of one digital human's conversations (app permanently deleted). */
  removeAppConversations(appId: string): void
  deleteAllInSpace(spaceId: string): void
  /** Drop rows of conversations that no longer exist. Returns how many went. */
  pruneGone(): number
  dispose(): void
}

/**
 * Whether a conversation is known to no longer exist. Supplied by the tiers
 * that own conversations; must answer false when it cannot tell.
 */
export type ConversationGoneCheck = (conversationId: string, spaceId: string) => boolean


function broadcast(): void {
  // No payload -- clients re-fetch via taskListState. The row set is small
  // (bounded by concurrently-completed conversations) and mutations already
  // happen one at a time, so a full re-list is simpler than diffing patches
  // across two transports and not a meaningful cost.
  sendToRenderer(CHANNEL, {})
  broadcastToAll(CHANNEL, {})
}

export function createTaskStateService(
  store: TaskStateStore,
  isConversationGone: ConversationGoneCheck
): TaskStateService {
  // A client can report a conversation after it was deleted (a turn ending as
  // its session is torn down). Its row would have nothing to open, so nothing
  // would ever clear it. The reporting client already shows the item, so the
  // broadcast goes out even with no row to remove.
  const dropIfGone = (conversationId: string, spaceId: string): boolean => {
    if (!isConversationGone(conversationId, spaceId)) return false
    store.remove(conversationId)
    console.warn(`[TaskState] Dropped report for deleted conversation: conversation=${conversationId}, space=${spaceId}`)
    broadcast()
    return true
  }

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
      if (!isFollowedConversationId(conversationId) || dropIfGone(conversationId, spaceId)) return
      store.upsertUnseen(conversationId, spaceId, title, Date.now())
      broadcast()
    },

    markRead(conversationId, spaceId, title, originalStatus) {
      if (!isFollowedConversationId(conversationId) || dropIfGone(conversationId, spaceId)) return
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

    removeAppConversations(appId) {
      store.deleteIdAndChildren(getAppChatConversationId(appId))
      broadcast()
    },

    deleteAllInSpace(spaceId) {
      store.deleteAllInSpace(spaceId)
    },

    pruneGone() {
      let removed = 0
      for (const row of store.list()) {
        if (isConversationGone(row.conversationId, row.spaceId) && store.remove(row.conversationId)) removed++
      }
      if (removed > 0) {
        console.log(`[TaskState] Pruned ${removed} row(s) of conversations that no longer exist`)
        broadcast()
      }
      return removed
    },

    dispose() {
      clearInterval(sweepTimer)
    },
  }
}
