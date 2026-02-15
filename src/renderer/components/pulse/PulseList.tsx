/**
 * PulseList - Shared presentational component for rendering pulse task items
 *
 * Pure list rendering of active tasks, unseen completions, and pinned conversations.
 * Used by PulseSidebarSection in the conversation list sidebar.
 *
 * Responsibilities:
 * - Renders grouped items (active first, then pinned idle)
 * - Status indicators per item
 * - Pin/unpin toggle
 * - Cross-space navigation on click
 * - Empty state
 *
 * Does NOT handle: positioning, open/close, collapse/expand, or responsive logic.
 */

import { useCallback, useMemo } from 'react'
import { Star } from 'lucide-react'
import { usePulseItems, useChatStore } from '../../stores/chat.store'
import { useSpaceStore } from '../../stores/space.store'
import { useAppStore } from '../../stores/app.store'
import { useTranslation } from '../../i18n'
import { TaskStatusDot } from './TaskStatusDot'
import type { PulseItem, TaskStatus } from '../../types'

const STATUS_LABEL: Record<TaskStatus, string> = {
  'generating': 'Generating...',
  'waiting': 'Waiting for input',
  'completed-unseen': 'Completed',
  'error': 'Error',
  'idle': 'Pinned',
}

/**
 * Navigate to a conversation, handling cross-space switching.
 * Extracted as a standalone function so it can be called from any context.
 */
export function navigateToConversation(spaceId: string, conversationId: string) {
  const chatStore = useChatStore.getState()
  const currentSpaceId = chatStore.currentSpaceId

  if (currentSpaceId === spaceId) {
    chatStore.selectConversation(conversationId)
    return
  }

  // Different space - switch space first
  const spaceStore = useSpaceStore.getState()
  const targetSpace = spaceStore.haloSpace?.id === spaceId
    ? spaceStore.haloSpace
    : spaceStore.spaces.find(s => s.id === spaceId)

  if (!targetSpace) return

  // Set flag for SpacePage to consume after it finishes loading conversations
  useChatStore.setState({ pendingPulseNavigation: conversationId })

  // Switch space — SpacePage's initSpace will pick up the flag and call selectConversation
  spaceStore.setCurrentSpace(targetSpace)
  useAppStore.getState().setView('space')
}

interface PulseListProps {
  /** Max height for the scrollable area (CSS value) */
  maxHeight?: string
  /** Callback after an item is clicked (e.g. to close a panel) */
  onItemClick?: () => void
  /** Whether to show compact items (smaller padding) */
  compact?: boolean
}

export function PulseList({ maxHeight = '360px', onItemClick, compact = false }: PulseListProps) {
  const { t } = useTranslation()
  const rawItems = usePulseItems()
  const haloSpace = useSpaceStore(state => state.haloSpace)
  const spaces = useSpaceStore(state => state.spaces)

  // Enrich items with proper space names from space store
  const items = useMemo(() => {
    return rawItems.map(item => {
      if (item.spaceName !== item.spaceId) return item
      const space = haloSpace?.id === item.spaceId
        ? haloSpace
        : spaces.find(s => s.id === item.spaceId)
      return space ? { ...item, spaceName: space.isTemp ? 'Halo' : space.name } : item
    })
  }, [rawItems, haloSpace, spaces])

  const handleItemClick = useCallback((item: PulseItem) => {
    navigateToConversation(item.spaceId, item.conversationId)
    onItemClick?.()
  }, [onItemClick])

  // Pin/Unpin: UI uses "Pin" terminology, backend API uses "Star" (starred field).
  // The mapping is: Pin = starred:true, Unpin = starred:false.
  const handleTogglePin = useCallback((e: React.MouseEvent, item: PulseItem) => {
    e.stopPropagation()
    useChatStore.getState().toggleStarConversation(item.spaceId, item.conversationId, !item.starred)
  }, [])

  const activeItems = items.filter(i => i.status !== 'idle')
  const pinnedIdleItems = items.filter(i => i.status === 'idle')

  if (items.length === 0) {
    return (
      <div className="px-4 py-6 text-center">
        <p className="text-sm text-muted-foreground">{t('No active tasks')}</p>
        <p className="text-xs text-muted-foreground/60 mt-1">
          {t('Tasks and pinned conversations appear here')}
        </p>
      </div>
    )
  }

  const py = compact ? 'py-1.5' : 'py-2.5'
  const px = compact ? 'px-3' : 'px-4'

  const renderItem = (item: PulseItem) => {
    const isRead = !!item.readAt
    return (
      <div
        key={item.conversationId}
        onClick={() => handleItemClick(item)}
        className={`pulse-item flex items-center gap-3 ${px} ${py} cursor-pointer ${isRead ? 'opacity-50' : ''}`}
      >
        {/* Status dot */}
        <TaskStatusDot status={item.status} size="md" />

        {/* Content */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate text-foreground">
            {item.title}
          </p>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="text-xs text-muted-foreground truncate">
              {item.spaceName}
            </span>
            <span className="text-muted-foreground/30 text-xs">·</span>
            <span className={`text-xs ${
              item.status === 'waiting' ? 'text-yellow-500' :
              item.status === 'error' ? 'text-red-500' :
              item.status === 'completed-unseen' ? 'text-green-500' :
              item.status === 'generating' ? 'text-blue-500' :
              'text-muted-foreground'
            }`}>
              {t(STATUS_LABEL[item.status])}
            </span>
          </div>
        </div>

        {/* Pin toggle */}
        <button
          onClick={(e) => handleTogglePin(e, item)}
          className={`p-1 rounded transition-colors flex-shrink-0 ${
            item.starred
              ? 'text-yellow-500 hover:text-yellow-400'
              : 'text-muted-foreground/40 hover:text-yellow-500'
          }`}
          title={item.starred ? t('Unpin') : t('Pin')}
        >
          <Star className={`w-3.5 h-3.5 ${item.starred ? 'fill-current' : ''}`} />
        </button>
      </div>
    )
  }

  return (
    <div className="overflow-auto scrollbar-thin" style={{ maxHeight }}>
      {/* Active items */}
      {activeItems.length > 0 && (
        <div className="py-1">
          {activeItems.map(renderItem)}
        </div>
      )}

      {/* Divider */}
      {activeItems.length > 0 && pinnedIdleItems.length > 0 && (
        <div className="mx-4 border-t border-border/30" />
      )}

      {/* Pinned idle items */}
      {pinnedIdleItems.length > 0 && (
        <div className="py-1">
          {pinnedIdleItems.map(renderItem)}
        </div>
      )}
    </div>
  )
}
