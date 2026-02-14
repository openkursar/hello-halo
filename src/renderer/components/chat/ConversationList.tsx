/**
 * Conversation List - Resizable sidebar for multiple conversations
 * Supports drag-to-resize, inline title editing, and conversation management
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { ConversationMeta } from '../../types'
import { MessageSquare, Plus } from '../icons/ToolIcons'
import { ChevronLeft, EllipsisVertical, Pin, Pencil, Trash2 } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useConversationTaskStatus } from '../../stores/chat.store'
import { TaskStatusDot } from '../pulse/TaskStatusDot'
import { PulseSidebarSection } from '../pulse/PulseSidebarSection'

// Width constraints (in pixels)
const MIN_WIDTH = 140
const MAX_WIDTH = 360
const DEFAULT_WIDTH = 260
const clampWidth = (v: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, v))

interface ConversationListProps {
  conversations: ConversationMeta[]
  currentConversationId?: string
  onSelect: (id: string) => void
  onNew: () => void
  onDelete?: (id: string) => void
  onRename?: (id: string, newTitle: string) => void
  onStar?: (id: string, starred: boolean) => void
  onClose?: () => void
  initialWidth?: number
  onWidthChange?: (width: number) => void
}

export function ConversationList({
  conversations,
  currentConversationId,
  onSelect,
  onNew,
  onDelete,
  onRename,
  onStar,
  onClose,
  initialWidth,
  onWidthChange,
}: ConversationListProps) {
  const { t } = useTranslation()
  const [width, setWidth] = useState(initialWidth != null ? clampWidth(initialWidth) : DEFAULT_WIDTH)
  const [isDragging, setIsDragging] = useState(false)
  const widthRef = useRef(width)

  // Sync width when initialWidth arrives from async config load
  useEffect(() => {
    if (initialWidth !== undefined && !isDragging) {
      const clamped = clampWidth(initialWidth)
      setWidth(clamped)
      widthRef.current = clamped
    }
  }, [initialWidth, isDragging])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const editInputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const onWidthChangeRef = useRef(onWidthChange)
  onWidthChangeRef.current = onWidthChange

  // Handle drag resize
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return
      const containerRect = containerRef.current.getBoundingClientRect()
      const newWidth = e.clientX - containerRect.left
      const clampedWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, newWidth))
      setWidth(clampedWidth)
      widthRef.current = clampedWidth
    }

    const handleMouseUp = () => {
      setIsDragging(false)
      onWidthChangeRef.current?.(widthRef.current)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging])

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
        setMenuPosition(null)
      }
    }
    document.addEventListener('click', handleClickOutside)
    return () => document.removeEventListener('click', handleClickOutside)
  }, [menuOpenId])

  // Reset menu state when conversations change (e.g. space switch)
  useEffect(() => {
    setMenuOpenId(null)
    setMenuPosition(null)
  }, [conversations])

  // Format date
  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr)
    const now = new Date()
    const isToday = date.toDateString() === now.toDateString()

    if (isToday) {
      return t('Today')
    }

    return `${date.getMonth() + 1}-${date.getDate()}`
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
    <>
    <div
      ref={containerRef}
      className="border-r border-border flex flex-col bg-card/50 relative"
      style={{ width, transition: isDragging ? 'none' : 'width 0.2s ease' }}
    >
      {/* Header */}
      <div className="p-3 border-b border-border flex items-center justify-between">
        <span className="text-sm font-medium text-muted-foreground">{t('Conversations')}</span>
        {onClose && (
          <button
            onClick={onClose}
            className="relative p-1 hover:bg-secondary rounded-md transition-colors text-muted-foreground hover:text-foreground before:content-[''] before:absolute before:-inset-2"
            title={t('Close sidebar')}
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Pinned section - pinned conversations at top of sidebar */}
      <PulseSidebarSection />

      {/* Conversation list */}
      <div className="flex-1 py-2 overflow-auto">
        {conversations.map((conversation) => (
          <div
            key={conversation.id}
            onClick={() => editingId !== conversation.id && onSelect(conversation.id)}
            className={`w-full px-3 py-2 text-left hover:bg-secondary/50 transition-colors cursor-pointer group relative ${
              conversation.id === currentConversationId ? 'bg-primary/10 border-l-2 border-primary' : ''
            }`}
          >
            {/* Edit mode */}
            {editingId === conversation.id ? (
              <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                <input
                  ref={editInputRef}
                  type="text"
                  value={editingTitle}
                  onChange={(e) => setEditingTitle(e.target.value)}
                  onKeyDown={handleEditKeyDown}
                  onBlur={handleSaveEdit}
                  className="flex-1 text-sm bg-input border border-border rounded px-2 py-1 focus:outline-none focus:border-primary min-w-0"
                  placeholder={t('Conversation title...')}
                />
                <button
                  onClick={handleSaveEdit}
                  className="p-1 hover:bg-primary/20 text-primary rounded transition-colors flex-shrink-0"
                  title={t('Save')}
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                </button>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 relative">
                  <MessageSquare className="w-4 h-4 text-blue-500 flex-shrink-0" />
                  <span className="text-sm truncate flex-1">
                    {conversation.title}
                  </span>
                  {/* Absolutely positioned so idle placeholder doesn't steal title space */}
                  <div className="absolute right-0 top-1/2 -translate-y-1/2 pointer-events-none">
                    <ConversationStatusDot conversationId={conversation.id} />
                  </div>
                  {/* More button (on hover) - absolutely positioned to not take layout space */}
                  <div className="absolute -right-1 top-[calc(50%+1px)] -translate-y-1/2 hidden group-hover:block">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        if (menuOpenId === conversation.id) {
                          setMenuOpenId(null)
                          setMenuPosition(null)
                        } else {
                          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                          const MENU_HEIGHT_ESTIMATE = 120
                          const spaceBelow = window.innerHeight - rect.bottom - 4
                          const top = spaceBelow >= MENU_HEIGHT_ESTIMATE
                            ? rect.bottom + 4
                            : Math.max(4, rect.top - MENU_HEIGHT_ESTIMATE - 4)
                          setMenuPosition({ top, left: rect.right })
                          setMenuOpenId(conversation.id)
                        }
                      }}
                      className="px-1.5 py-1 rounded transition-colors bg-secondary text-foreground/80 hover:text-foreground hover:bg-secondary"
                      title={t('More')}
                    >
                      <EllipsisVertical className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  {/* Keep menu open even when not hovering */}
                  {menuOpenId === conversation.id && (
                    <div className="absolute -right-1 top-[calc(50%+1px)] -translate-y-1/2">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setMenuOpenId(null)
                          setMenuPosition(null)
                        }}
                        className="px-1.5 py-1 rounded bg-secondary text-foreground"
                        title={t('More')}
                      >
                        <EllipsisVertical className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  {formatDate(conversation.updatedAt)}
                </p>
              </>
            )}
          </div>
        ))}
      </div>

      {/* New conversation button */}
      <div className="p-2 border-t border-border">
        <button
          onClick={onNew}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm text-primary hover:bg-primary/10 rounded-lg transition-colors"
        >
          <Plus className="w-4 h-4" />
          {t('New conversation')}
        </button>
      </div>

      {/* Drag handle - on right side */}
      <div
        className={`absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-primary/50 transition-colors z-20 ${
          isDragging ? 'bg-primary/50' : ''
        }`}
        onMouseDown={handleMouseDown}
        title={t('Drag to resize width')}
      />
    </div>

    {/* Dropdown menu — Portal to document.body, fully outside flex layout */}
    {menuOpenId && menuPosition && (() => {
      const conv = conversations.find(c => c.id === menuOpenId)
      if (!conv) return null
      return createPortal(
        <div
          ref={menuRef}
          className="fixed z-[9999] min-w-[140px] bg-popover border border-border rounded-lg shadow-lg py-1"
          style={{ top: menuPosition.top, left: menuPosition.left, transform: 'translateX(-100%)' }}
        >
          {onStar && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                onStar(conv.id, !conv.starred)
                setMenuOpenId(null)
                setMenuPosition(null)
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-secondary transition-colors"
            >
              <Pin className={`w-3.5 h-3.5 ${conv.starred ? 'text-primary' : ''}`} />
              <span>{conv.starred ? t('Unpin') : t('Pin')}</span>
            </button>
          )}
          {onRename && (
            <button
              onClick={(e) => {
                handleStartEdit(e, conv)
                setMenuOpenId(null)
                setMenuPosition(null)
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-secondary transition-colors"
            >
              <Pencil className="w-3.5 h-3.5" />
              <span>{t('Rename')}</span>
            </button>
          )}
          {onDelete && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                onDelete(conv.id)
                setMenuOpenId(null)
                setMenuPosition(null)
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>{t('Delete')}</span>
            </button>
          )}
        </div>,
        document.body
      )
    })()}
    </>
  )
}

/** Extracted sub-component so useConversationTaskStatus hook is called per conversation */
function ConversationStatusDot({ conversationId }: { conversationId: string }) {
  const status = useConversationTaskStatus(conversationId)
  return <TaskStatusDot status={status} size="sm" />
}
