/**
 * ChatHistoryPanel - Collapsible top panel for browsing conversation history
 * Features smooth animations, elegant design, and intuitive interactions
 * Supports inline title editing
 */

import { useState, useRef, useEffect } from 'react'
import type { ConversationMeta } from '../../types'
import { useTranslation, getCurrentLanguage } from '../../i18n'

interface ChatHistoryPanelProps {
  conversations: ConversationMeta[]
  currentConversationId: string | undefined
  onSelect: (id: string) => void
  onNew: () => void
  onDelete?: (id: string) => void
  onRename?: (id: string, newTitle: string) => void
  spaceName: string
}

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

export function ChatHistoryPanel({
  conversations,
  currentConversationId,
  onSelect,
  onNew,
  onDelete,
  onRename,
  spaceName
}: ChatHistoryPanelProps) {
  const { t } = useTranslation()
  const [isExpanded, setIsExpanded] = useState(false)
  const [isAnimatingOut, setIsAnimatingOut] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const panelRef = useRef<HTMLDivElement>(null)
  const editInputRef = useRef<HTMLInputElement>(null)

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

  const handleClose = () => {
    // Cancel any editing
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

    onSelect(id)
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
    if (editingId && editingTitle.trim() && onRename) {
      onRename(editingId, editingTitle.trim())
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

  return (
    <div ref={panelRef} className="relative">
      {/* Toggle button - always visible */}
      <button
        onClick={handleToggle}
        className={`
          flex items-center gap-2 px-3 py-1.5 rounded-lg transition-all duration-200
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
        <span className="text-sm font-medium">
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
            className={`fixed inset-0 bg-black/20 z-40 ${isAnimatingOut ? 'animate-fade-out' : 'animate-fade-in'}`}
            style={{ animationDuration: '0.2s' }}
          />

          {/* Panel content */}
          <div
            className={`
              absolute top-full left-0 right-0 mt-2 z-50
              bg-card/95 backdrop-blur-xl rounded-xl border border-border/50
              shadow-2xl shadow-black/20 overflow-hidden
              min-w-[320px] max-w-[400px]
              ${isAnimatingOut ? 'animate-slide-out-top' : 'animate-slide-in-top'}
            `}
            style={{ animationDuration: '0.25s' }}
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
                onClick={onNew}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium
                  bg-primary/10 hover:bg-primary/20 text-primary rounded-lg transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                {t('New conversation')}
              </button>
            </div>

            {/* Conversation list */}
            <div className="max-h-[320px] overflow-auto">
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
                <div className="py-2">
                  {conversations.map((conv, index) => (
                    <div
                      key={conv.id}
                      onClick={() => handleSelectConversation(conv.id)}
                      className={`
                        w-full px-4 py-3 text-left transition-all duration-150
                        hover:bg-white/5 group relative cursor-pointer
                        ${conv.id === currentConversationId ? 'bg-primary/10' : ''}
                      `}
                      style={{
                        animationDelay: `${index * 30}ms`,
                        animation: !isAnimatingOut ? 'fade-in 0.2s ease-out forwards' : undefined
                      }}
                    >
                      {/* Selection indicator */}
                      {conv.id === currentConversationId && (
                        <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-8 bg-primary rounded-r" />
                      )}

                      <div className="flex items-start justify-between gap-3">
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
                            <p className={`text-sm font-medium truncate ${
                              conv.id === currentConversationId ? 'text-primary' : 'text-foreground'
                            }`}>
                              {conv.title || getConversationPreview(conv, t)}
                            </p>
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

                        {/* Action buttons (on hover) */}
                        {editingId !== conv.id && (
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all">
                            {/* Edit button */}
                            {onRename && (
                              <button
                                onClick={(e) => handleStartEdit(e, conv)}
                                className="p-1.5 hover:bg-primary/10 text-muted-foreground hover:text-primary rounded transition-colors"
                                title={t('Edit title')}
                              >
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                                </svg>
                              </button>
                            )}

                            {/* Delete button */}
                            {onDelete && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation()
                                  onDelete(conv.id)
                                }}
                                className="p-1.5 hover:bg-destructive/10 text-muted-foreground hover:text-destructive rounded transition-colors"
                                title={t('Delete conversation')}
                              >
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Footer */}
            {conversations.length > 5 && (
              <div className="px-4 py-2 border-t border-border/30 text-center">
                <span className="text-xs text-muted-foreground/60">
                  {t('Showing last {{count}} conversations', { count: conversations.length })}
                </span>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
