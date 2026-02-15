/**
 * ChatHistoryPanel - Collapsible panel for browsing conversation history
 * - Desktop: Dropdown menu from button
 * - Mobile: Bottom sheet for better touch interaction
 * Features smooth animations, elegant design, and intuitive interactions
 * Supports inline title editing
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { Virtuoso } from 'react-virtuoso'
import { X, EllipsisVertical, Pin, Pencil, Trash2 } from 'lucide-react'
import type { ConversationMeta } from '../../types'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useChatStore, useAllConversationStatuses } from '../../stores/chat.store'
import { useSpaceStore } from '../../stores/space.store'
import { TaskStatusDot } from '../pulse/TaskStatusDot'

// Format relative time
function formatRelativeTime(dateString: string, t: (key: string, options?: any) => string): string {
  const date = new Date(dateString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return t('Just now')
  if (diffMins < 60) return t('{{count}} minutes ago', { count: diffMins })
  if (diffHours < 24) return t('{{count}} hours ago', { count: diffHours })
  if (diffDays < 7) return t('{{count}} days ago', { count: diffDays })

  return new Intl.DateTimeFormat(getCurrentLanguage(), {
    month: 'short',
    day: 'numeric'
  }).format(date)
}

// Get conversation preview from metadata
function getConversationPreview(conversation: ConversationMeta, t: (key: string, options?: any) => string): string {
  if (conversation.preview) {
    return conversation.preview
  }
  return conversation.messageCount > 0 ? t('Conversation content') : t('New conversation')
}

export function ChatHistoryPanel() {
  const { t } = useTranslation()
  const isMobile = useIsMobile()

  // Subscribe to store data
  const conversations = useChatStore(state => {
    const spaceState = state.spaceStates.get(state.currentSpaceId ?? '')
    return spaceState?.conversations ?? []
  })
  const currentConversationId = useChatStore(state => {
    const spaceState = state.spaceStates.get(state.currentSpaceId ?? '')
    return spaceState?.currentConversationId ?? undefined
  })
  const currentSpace = useSpaceStore(state => state.currentSpace)
  const spaceName = currentSpace?.isTemp ? t('Halo Space') : (currentSpace?.name ?? '')

  // Single batch subscription for all conversation statuses (replaces N individual hooks)
  const conversationStatuses = useAllConversationStatuses()
  const [isExpanded, setIsExpanded] = useState(false)
  const [isAnimatingOut, setIsAnimatingOut] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)
  const [panelPosition, setPanelPosition] = useState({ top: 0, left: 0 })
  const panelRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const editInputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Calculate panel position when expanded (desktop only)
  useEffect(() => {
    if (isExpanded && buttonRef.current && !isMobile) {
      const rect = buttonRef.current.getBoundingClientRect()
      setPanelPosition({
        top: rect.bottom + 8, // 8px gap
        left: Math.max(8, rect.left) // Ensure minimum 8px from left edge
      })
    }
  }, [isExpanded, isMobile])

  // Handle click outside to close
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        handleClose()
      }
    }

    if (isExpanded) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isExpanded])

  // Handle keyboard shortcut (Escape to close)
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && isExpanded) {
        if (editingId) {
          // Cancel editing
          setEditingId(null)
          setEditingTitle('')
        } else {
          handleClose()
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isExpanded, editingId])

  // Focus input when entering edit mode
  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus()
      editInputRef.current.select()
    }
  }, [editingId])

  // Close dropdown menu on outside click
  useEffect(() => {
    if (!menuOpenId) return
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpenId(null)
      }
    }
    document.addEventListener('click', handleClickOutside)
    return () => document.removeEventListener('click', handleClickOutside)
  }, [menuOpenId])

  const handleClose = () => {
    // Cancel any editing and close dropdown menu
    setMenuOpenId(null)
    setEditingId(null)
    setEditingTitle('')

    setIsAnimatingOut(true)
    setTimeout(() => {
      setIsExpanded(false)
      setIsAnimatingOut(false)
    }, 200)
  }

  const handleToggle = () => {
    if (isExpanded) {
      handleClose()
    } else {
      setIsExpanded(true)
    }
  }

  const handleSelectConversation = (id: string) => {
    // Don't select if we're editing
    if (editingId) return

    useChatStore.getState().selectConversation(id)
    handleClose()
  }

  // Start editing a conversation title
  const handleStartEdit = (e: React.MouseEvent, conv: ConversationMeta) => {
    e.stopPropagation()
    setEditingId(conv.id)
    setEditingTitle(conv.title || '')
  }

  // Save edited title
  const handleSaveEdit = () => {
    if (editingId && editingTitle.trim()) {
      const spaceId = useSpaceStore.getState().currentSpace?.id
      if (spaceId) useChatStore.getState().renameConversation(spaceId, editingId, editingTitle.trim())
    }
    setEditingId(null)
    setEditingTitle('')
  }

  // Cancel editing
  const handleCancelEdit = () => {
    setEditingId(null)
    setEditingTitle('')
  }

  // Handle input key events
  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSaveEdit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      handleCancelEdit()
    }
  }

  // Render a single conversation item (used by Virtuoso)
  const renderHistoryItem = useCallback((_index: number, conv: ConversationMeta) => (
    <div
      onClick={() => handleSelectConversation(conv.id)}
      className={`
        w-full px-4 py-3 text-left transition-all duration-150
        hover:bg-white/5 group relative cursor-pointer
        ${conv.id === currentConversationId ? 'bg-primary/10' : ''}
        ${menuOpenId === conv.id ? 'z-50' : ''}
      `}
    >
      {/* Selection indicator */}
      {conv.id === currentConversationId && (
        <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-8 bg-primary rounded-r" />
      )}

      <div className="flex items-start justify-between gap-3 relative">
        <div className="flex-1 min-w-0">
          {/* Title / Preview - with edit mode */}
          {editingId === conv.id ? (
            <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
              <input
                ref={editInputRef}
                type="text"
                value={editingTitle}
                onChange={(e) => setEditingTitle(e.target.value)}
                onKeyDown={handleEditKeyDown}
                onBlur={handleSaveEdit}
                className="flex-1 text-sm font-medium bg-input border border-border rounded px-2 py-1 focus:outline-none focus:border-primary"
                placeholder={t('Enter conversation title...')}
              />
              <button
                onClick={handleSaveEdit}
                className="p-1 hover:bg-primary/20 text-primary rounded transition-colors"
                title={t('Save')}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </button>
              <button
                onClick={handleCancelEdit}
                className="p-1 hover:bg-destructive/20 text-muted-foreground hover:text-destructive rounded transition-colors"
                title={t('Cancel')}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <TaskStatusDot status={conversationStatuses.get(conv.id) ?? 'idle'} size="sm" />
              <p className={`text-sm font-medium truncate ${
                conv.id === currentConversationId ? 'text-primary' : 'text-foreground'
              }`}>
                {conv.title || getConversationPreview(conv, t)}
              </p>
            </div>
          )}

          {/* Meta info */}
          {editingId !== conv.id && (
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs text-muted-foreground">
                {formatRelativeTime(conv.updatedAt, t)}
              </span>
              {conv.messageCount > 0 && (
                <>
                  <span className="text-muted-foreground/30">·</span>
                  <span className="text-xs text-muted-foreground">
                    {t('{{count}} messages', { count: conv.messageCount })}
                  </span>
                </>
              )}
            </div>
          )}
        </div>

        {/* More button (on hover) - absolutely positioned */}
        {editingId !== conv.id && (
          <>
            <div className={`absolute right-0 top-[1px] ${isMobile ? 'block' : 'hidden group-hover:block'}`}>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setMenuOpenId(menuOpenId === conv.id ? null : conv.id)
                }}
                className="px-2 py-1.5 rounded transition-colors bg-card/80 text-foreground/60 hover:text-foreground hover:bg-secondary"
                title={t('More')}
              >
                <EllipsisVertical className="w-4 h-4" />
              </button>
            </div>
            {menuOpenId === conv.id && (
              <div className="absolute right-0 top-[1px]">
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setMenuOpenId(null)
                  }}
                  className="px-2 py-1.5 rounded bg-secondary text-foreground"
                  title={t('More')}
                >
                  <EllipsisVertical className="w-4 h-4" />
                </button>
                <div
                  ref={menuRef}
                  className="absolute right-0 top-full mt-1 z-[9999] min-w-[150px] bg-popover border border-border rounded-lg shadow-lg py-1"
                >
                  <button
                      onClick={(e) => {
                        e.stopPropagation()
                        const spaceId = useSpaceStore.getState().currentSpace?.id
                        if (spaceId) useChatStore.getState().toggleStarConversation(spaceId, conv.id, !conv.starred)
                        setMenuOpenId(null)
                      }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-secondary transition-colors"
                    >
                      <Pin className={`w-4 h-4 ${conv.starred ? 'text-primary' : ''}`} />
                      <span>{conv.starred ? t('Unpin') : t('Pin')}</span>
                    </button>
                    <button
                      onClick={(e) => {
                        handleStartEdit(e, conv)
                        setMenuOpenId(null)
                      }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-secondary transition-colors"
                    >
                      <Pencil className="w-4 h-4" />
                      <span>{t('Rename')}</span>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        const spaceId = useSpaceStore.getState().currentSpace?.id
                        if (spaceId) useChatStore.getState().deleteConversation(spaceId, conv.id)
                        setMenuOpenId(null)
                      }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                      <span>{t('Delete')}</span>
                    </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  ), [editingId, editingTitle, currentConversationId, conversationStatuses, menuOpenId, isMobile, t])

  // Shared conversation list content - virtualized
  const renderConversationList = (height: string) => (
    <>
      {conversations.length === 0 ? (
        <div className="px-4 py-8 text-center">
          <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-muted/50 flex items-center justify-center">
            <svg className="w-6 h-6 text-muted-foreground/50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
          </div>
          <p className="text-sm text-muted-foreground">{t('No conversations yet')}</p>
          <p className="text-xs text-muted-foreground/60 mt-1">{t('Start a new conversation to create history')}</p>
        </div>
      ) : (
        <div style={{ height }}>
          <Virtuoso
            data={conversations}
            overscan={200}
            itemContent={renderHistoryItem}
          />
        </div>
      )}
    </>
  )

  // Desktop footer
  const renderFooter = () => (
    <div className="px-4 py-2 border-t border-border/30 flex items-center justify-between">
      <span className="text-xs text-muted-foreground/60">
        {conversations.length > 5
          ? t('Showing last {{count}} conversations', { count: conversations.length })
          : '\u00A0' /* Non-breaking space to maintain height */
        }
      </span>
    </div>
  )

  return (
    <div ref={panelRef} className="relative">
      {/* Toggle button - always visible, text hidden on mobile */}
      <button
        ref={buttonRef}
        onClick={handleToggle}
        className={`
          flex items-center gap-1 sm:gap-2 px-2 sm:px-3 py-1.5 rounded-lg transition-all duration-200
          ${isExpanded
            ? 'bg-primary/20 text-primary'
            : 'hover:bg-secondary text-muted-foreground hover:text-foreground'
          }
        `}
        title={t('Conversation history')}
      >
        <svg
          className={`w-4 h-4 transition-transform duration-300 ${isExpanded ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
        <span className="text-sm font-medium hidden sm:inline">
          {conversations.length > 0
            ? t('{{count}} conversations', { count: conversations.length })
            : t('Conversation history')}
        </span>
      </button>

      {/* Expanded panel */}
      {isExpanded && (
        <>
          {/* Backdrop - click to close */}
          <div
            onClick={handleClose}
            className={`fixed inset-0 bg-black/40 z-40 ${isAnimatingOut ? 'animate-fade-out' : 'animate-fade-in'}`}
            style={{ animationDuration: '0.2s' }}
          />

          {isMobile ? (
            /* Mobile: Bottom Sheet */
            <div
              className={`
                fixed inset-x-0 bottom-0 z-50
                bg-card rounded-t-2xl border-t border-border/50
                shadow-2xl overflow-hidden
                ${isAnimatingOut ? 'animate-slide-out-bottom' : 'animate-slide-in-bottom'}
              `}
              style={{ maxHeight: '70vh' }}
            >
              {/* Drag handle */}
              <div className="flex justify-center py-2">
                <div className="w-10 h-1 bg-muted-foreground/30 rounded-full" />
              </div>

              {/* Header */}
              <div className="px-4 py-2 border-b border-border/50 flex items-center justify-between">
                <div>
                  <h3 className="text-base font-semibold text-foreground">{spaceName}</h3>
                  <p className="text-xs text-muted-foreground">
                    {t('{{count}} conversations', { count: conversations.length })}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      const spaceId = useSpaceStore.getState().currentSpace?.id
                      if (spaceId) useChatStore.getState().createConversation(spaceId)
                      handleClose()
                    }}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium
                      bg-primary/10 hover:bg-primary/20 text-primary rounded-lg transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                    {t('New conversation')}
                  </button>
                  <button
                    onClick={handleClose}
                    className="p-2 hover:bg-secondary rounded-lg transition-colors"
                  >
                    <X className="w-5 h-5 text-muted-foreground" />
                  </button>
                </div>
              </div>

              {/* Conversation list - taller on mobile (virtualized) */}
              {renderConversationList('calc(70vh - 100px)')}
            </div>
          ) : (
            /* Desktop: Dropdown Panel */
            <div
              className={`
                fixed z-50
                bg-card/95 backdrop-blur-xl rounded-xl border border-border/50
                shadow-2xl shadow-black/20 overflow-hidden
                min-w-[320px] max-w-[400px]
                ${isAnimatingOut ? 'animate-slide-out-top' : 'animate-slide-in-top'}
              `}
              style={{
                animationDuration: '0.25s',
                top: panelPosition.top,
                left: panelPosition.left
              }}
            >
              {/* Header */}
              <div className="px-4 py-3 border-b border-border/50 flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold text-foreground">{spaceName}</h3>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {t('{{count}} conversations', { count: conversations.length })}
                  </p>
                </div>
                <button
                  onClick={() => {
                    const spaceId = useSpaceStore.getState().currentSpace?.id
                    if (spaceId) useChatStore.getState().createConversation(spaceId)
                    handleClose()
                  }}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium
                    bg-primary/10 hover:bg-primary/20 text-primary rounded-lg transition-colors"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  {t('New conversation')}
                </button>
              </div>

              {/* Conversation list (virtualized) */}
              {renderConversationList('320px')}

              {/* Footer */}
              {renderFooter()}
            </div>
          )}
        </>
      )}
    </div>
  )
}
