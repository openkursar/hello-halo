/**
 * Chat Store — conversation and messaging state.
 *
 * The implementation is split by concern into ./chat/* slices (shared types,
 * helpers, and the slice-creator contract live in ./chat/internal). This file
 * holds the initial state and composes the slices into the Zustand store. The
 * public entry (`useChatStore`) is unchanged, so consumers are unaffected.
 *
 * Architecture:
 * - spaceStates: Map<spaceId, SpaceState> — conversation metadata per space
 * - conversationCache: Map<conversationId, Conversation> — LRU full conversations
 * - sessions: Map<conversationId, SessionState> — runtime state per conversation
 */
import { create } from 'zustand'
import { PULSE_READ_GRACE_PERIOD_MS } from './chat/internal'
import type { ChatState, SpaceState, SessionState } from './chat/internal'
import type { Conversation, ConversationMeta, SessionInitInfo, PulseItem, TaskStatus } from './chat/internal'
import { createGettersSlice } from './chat/getters'
import { createConversationsSlice } from './chat/conversations'
import { createMessagingSlice } from './chat/messaging'
import { createAgentEventsSlice } from './chat/agent-events'
import { createSessionSlice } from './chat/session'

export const useChatStore = create<ChatState>((set, get) => ({
  spaceStates: new Map<string, SpaceState>(),
  conversationCache: new Map<string, Conversation>(),
  sessions: new Map<string, SessionState>(),
  sessionInitInfo: new Map<string, SessionInitInfo>(),
  unseenCompletions: new Map<string, { spaceId: string; title: string }>(),
  pulseReadAt: new Map<string, { readAt: number; originalStatus: 'completed-unseen' | 'error'; spaceId: string; title: string }>(),
  currentSpaceId: null,
  pendingPulseNavigation: null,
  artifacts: [],
  isLoading: false,
  isLoadingConversation: false,
  _pulseItems: [],
  _pulseCount: 0,

  ...createGettersSlice(set, get),
  ...createConversationsSlice(set, get),
  ...createMessagingSlice(set, get),
  ...createAgentEventsSlice(set, get),
  ...createSessionSlice(set, get),
}))

// ==========================================
// Derived Pulse State — recalculates only when pulse-relevant fields change.
// During streaming, sessions change every token (streamingContent, thoughts, etc.)
// but pulse-relevant fields (isGenerating, pendingToolApproval, error, pendingQuestion)
// stay the same. We extract a fingerprint of only these fields and skip recalculation
// when the fingerprint is unchanged.
// ==========================================

/**
 * Extract a pulse-relevant fingerprint from sessions.
 * Only includes fields that affect deriveTaskStatus().
 */
function _extractPulseFingerprint(sessions: Map<string, SessionState>): string {
  const parts: string[] = []
  for (const [id, s] of sessions) {
    // Only include sessions that could produce non-idle status
    if (s.isGenerating || s.pendingToolApproval || s.error || s.pendingQuestion?.status === 'active') {
      parts.push(`${id}:${s.isGenerating ? 1 : 0}${s.pendingToolApproval ? 1 : 0}${s.error && s.errorType !== 'interrupted' ? 1 : 0}${s.pendingQuestion?.status === 'active' ? 1 : 0}`)
    }
  }
  return parts.join('|')
}

/**
 * Compute pulse items from state (same logic as the original usePulseItems selector).
 */
function _computePulseItems(state: ChatState): PulseItem[] {
  const items: PulseItem[] = []
  const addedIds = new Set<string>()

  const getSpaceName = (spaceId: string): string => {
    return spaceId === 'halo-temp' ? 'Halo' : spaceId
  }

  // 1. Active sessions
  for (const [conversationId, session] of state.sessions) {
    const hasUnseen = state.unseenCompletions.has(conversationId)
    const status = deriveTaskStatus(session, hasUnseen)
    if (status === 'idle') continue

    let meta: ConversationMeta | undefined
    for (const [, ss] of state.spaceStates) {
      meta = ss.conversations.find(c => c.id === conversationId)
      if (meta) break
    }
    if (!meta) continue

    items.push({
      conversationId,
      spaceId: meta.spaceId,
      spaceName: getSpaceName(meta.spaceId),
      title: meta.title,
      status,
      starred: !!meta.starred,
      updatedAt: meta.updatedAt
    })
    addedIds.add(conversationId)
  }

  // 2. Unseen completions
  for (const [conversationId, info] of state.unseenCompletions) {
    if (addedIds.has(conversationId)) continue
    let meta: ConversationMeta | undefined
    for (const [, ss] of state.spaceStates) {
      meta = ss.conversations.find(c => c.id === conversationId)
      if (meta) break
    }
    items.push({
      conversationId,
      spaceId: info.spaceId,
      spaceName: getSpaceName(info.spaceId),
      title: meta?.title || info.title,
      status: 'completed-unseen',
      starred: !!meta?.starred,
      updatedAt: meta?.updatedAt || new Date().toISOString()
    })
    addedIds.add(conversationId)
  }

  // 3. Starred conversations
  for (const [, ss] of state.spaceStates) {
    for (const conv of ss.conversations) {
      if (!conv.starred || addedIds.has(conv.id)) continue
      items.push({
        conversationId: conv.id,
        spaceId: conv.spaceId,
        spaceName: getSpaceName(conv.spaceId),
        title: conv.title,
        status: 'idle',
        starred: true,
        updatedAt: conv.updatedAt
      })
      addedIds.add(conv.id)
    }
  }

  // 4. Read items in grace period
  const now = Date.now()
  for (const [conversationId, info] of state.pulseReadAt) {
    if (addedIds.has(conversationId)) continue
    if (now - info.readAt >= PULSE_READ_GRACE_PERIOD_MS) continue
    items.push({
      conversationId,
      spaceId: info.spaceId,
      spaceName: getSpaceName(info.spaceId),
      title: info.title,
      status: info.originalStatus,
      starred: false,
      updatedAt: new Date(info.readAt).toISOString(),
      readAt: info.readAt
    })
    addedIds.add(conversationId)
  }

  // Sort by priority
  const priorityOrder: Record<TaskStatus, number> = {
    'waiting': 0,
    'generating': 1,
    'completed-unseen': 2,
    'error': 3,
    'idle': 4
  }
  items.sort((a, b) => {
    const pa = priorityOrder[a.status]
    const pb = priorityOrder[b.status]
    if (pa !== pb) return pa - pb
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  })

  return items
}

/**
 * Count pulse items (same logic as the original usePulseCount selector).
 */
function _computePulseCount(state: ChatState): number {
  let count = 0
  const countedIds = new Set<string>()

  for (const [conversationId, session] of state.sessions) {
    const hasUnseen = state.unseenCompletions.has(conversationId)
    const status = deriveTaskStatus(session, hasUnseen)
    if (status !== 'idle') {
      count++
      countedIds.add(conversationId)
    }
  }

  for (const [conversationId] of state.unseenCompletions) {
    if (!countedIds.has(conversationId)) {
      count++
      countedIds.add(conversationId)
    }
  }

  for (const [, ss] of state.spaceStates) {
    for (const conv of ss.conversations) {
      if (conv.starred && !countedIds.has(conv.id)) {
        count++
        countedIds.add(conv.id)
      }
    }
  }

  const now = Date.now()
  for (const [conversationId, info] of state.pulseReadAt) {
    if (!countedIds.has(conversationId) && now - info.readAt < PULSE_READ_GRACE_PERIOD_MS) {
      count++
      countedIds.add(conversationId)
    }
  }

  return count
}

// Track previous pulse-relevant state to avoid unnecessary recalculations
let _prevPulseFingerprint = ''
let _prevUnseenSize = 0
let _prevPulseReadAtSize = 0
let _prevStarredFingerprint = ''

/**
 * Extract a fingerprint of starred conversations across all spaces.
 */
function _extractStarredFingerprint(spaceStates: Map<string, SpaceState>): string {
  const parts: string[] = []
  for (const [, ss] of spaceStates) {
    for (const conv of ss.conversations) {
      if (conv.starred) {
        parts.push(`${conv.id}:${conv.title}:${conv.updatedAt}`)
      }
    }
  }
  return parts.join('|')
}

// Subscribe to store changes and recalculate pulse only when relevant fields change
useChatStore.subscribe((state) => {
  const sessionFingerprint = _extractPulseFingerprint(state.sessions)
  const unseenSize = state.unseenCompletions.size
  const pulseReadAtSize = state.pulseReadAt.size
  const starredFingerprint = _extractStarredFingerprint(state.spaceStates)

  if (
    sessionFingerprint === _prevPulseFingerprint &&
    unseenSize === _prevUnseenSize &&
    pulseReadAtSize === _prevPulseReadAtSize &&
    starredFingerprint === _prevStarredFingerprint
  ) {
    return // No pulse-relevant changes
  }

  _prevPulseFingerprint = sessionFingerprint
  _prevUnseenSize = unseenSize
  _prevPulseReadAtSize = pulseReadAtSize
  _prevStarredFingerprint = starredFingerprint

  const newItems = _computePulseItems(state)
  const newCount = _computePulseCount(state)

  // Only update if values actually changed (avoid infinite loop)
  const currentItems = state._pulseItems
  const itemsChanged = newItems.length !== currentItems.length ||
    newItems.some((item, i) =>
      item.conversationId !== currentItems[i]?.conversationId ||
      item.status !== currentItems[i]?.status ||
      item.starred !== currentItems[i]?.starred ||
      item.title !== currentItems[i]?.title ||
      item.updatedAt !== currentItems[i]?.updatedAt ||
      item.readAt !== currentItems[i]?.readAt
    )

  if (itemsChanged || newCount !== state._pulseCount) {
    useChatStore.setState({ _pulseItems: newItems, _pulseCount: newCount })
  }
})

/**
 * Selector: Get current session's isGenerating state
 * Use this in components that need to react to generation state changes
 */
export function useIsGenerating(): boolean {
  return useChatStore((state) => {
    const spaceState = state.currentSpaceId
      ? state.spaceStates.get(state.currentSpaceId)
      : null
    if (!spaceState?.currentConversationId) return false
    const session = state.sessions.get(spaceState.currentConversationId)
    return session?.isGenerating ?? false
  })
}

/**
 * Derive task status for a conversation from session state and unseen completions
 */
export function deriveTaskStatus(
  session: SessionState | undefined,
  hasUnseenCompletion: boolean
): TaskStatus {
  if (session) {
    if (session.pendingToolApproval || session.pendingQuestion?.status === 'active') return 'waiting'
    if (session.error && session.errorType !== 'interrupted') return 'error'
    if (session.isGenerating) return 'generating'
  }
  if (hasUnseenCompletion) return 'completed-unseen'
  return 'idle'
}

/**
 * Selector: Get task status for a specific conversation
 */
export function useConversationTaskStatus(conversationId: string | undefined): TaskStatus {
  return useChatStore((state) => {
    if (!conversationId) return 'idle'
    const session = state.sessions.get(conversationId)
    const hasUnseen = state.unseenCompletions.has(conversationId)
    return deriveTaskStatus(session, hasUnseen)
  })
}

/**
 * Selector: Get task statuses for all conversations in the current space.
 * Returns a Map of conversationId -> TaskStatus, only including non-idle entries.
 * This replaces N individual useConversationTaskStatus subscriptions with a single one.
 */
export function useAllConversationStatuses(): Map<string, TaskStatus> {
  return useChatStore(
    (state) => {
      const result = new Map<string, TaskStatus>()
      const spaceState = state.currentSpaceId
        ? state.spaceStates.get(state.currentSpaceId)
        : null
      if (!spaceState) return result

      for (const conv of spaceState.conversations) {
        const session = state.sessions.get(conv.id)
        const hasUnseen = state.unseenCompletions.has(conv.id)
        const status = deriveTaskStatus(session, hasUnseen)
        if (status !== 'idle') {
          result.set(conv.id, status)
        }
      }
      return result
    },
    // Shallow equality: only re-render if the map content actually changed
    (a, b) => {
      if (a.size !== b.size) return false
      for (const [id, status] of a) {
        if (b.get(id) !== status) return false
      }
      return true
    }
  )
}

/**
 * Selector: Get all Pulse items from derived state (pre-computed, not recalculated on every store update).
 * Recalculation is driven by the subscribe-based fingerprint watcher above.
 */
export function usePulseItems(): PulseItem[] {
  return useChatStore(state => state._pulseItems)
}

/**
 * Selector: Get the count of pulse items from derived state (pre-computed).
 */
export function usePulseCount(): number {
  return useChatStore(state => state._pulseCount)
}

/**
 * Selector: Get the dominant beacon color based on most urgent status
 * Returns: 'waiting' | 'completed' | 'generating' | 'error' | null
 */
export function usePulseBeaconStatus(): 'waiting' | 'completed' | 'generating' | 'error' | null {
  return useChatStore((state) => {
    let hasWaiting = false
    let hasCompleted = false
    let hasGenerating = false
    let hasError = false

    // Check all sessions
    for (const [conversationId, session] of state.sessions) {
      const hasUnseen = state.unseenCompletions.has(conversationId)
      const status = deriveTaskStatus(session, hasUnseen)
      if (status === 'waiting') hasWaiting = true
      if (status === 'completed-unseen') hasCompleted = true
      if (status === 'generating') hasGenerating = true
      if (status === 'error') hasError = true
    }

    // Check unseen completions
    if (state.unseenCompletions.size > 0) hasCompleted = true

    // Priority: waiting > completed > generating > error
    if (hasWaiting) return 'waiting'
    if (hasCompleted) return 'completed'
    if (hasGenerating) return 'generating'
    if (hasError) return 'error'

    // Check if there are starred items (no beacon color for idle starred)
    for (const [, ss] of state.spaceStates) {
      if (ss.conversations.some(c => c.starred)) return null
    }

    return null
  })
}
