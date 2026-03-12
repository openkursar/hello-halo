/**
 * Message Queue Panel - Display and manage pending messages in queue
 *
 * Features:
 * - Shows list of queued messages above input area
 * - Allows editing message content
 * - Allows removing individual messages
 * - Allows clearing entire queue
 * - Collapsible when not needed
 */

import { useState } from 'react'
import { ChevronDown, ChevronUp, Edit2, Trash2, X, ListOrdered } from 'lucide-react'
import type { PendingMessage } from '../../stores/chat.store'
import { useTranslation } from '../../i18n'

interface MessageQueuePanelProps {
  queue: PendingMessage[]
  onRemove: (queueId: string) => void
  onEdit: (queueId: string, content: string) => void
  onClear: () => void
}

// Maximum characters to show in queue item preview
const MAX_PREVIEW_LENGTH = 50

export function MessageQueuePanel({ queue, onRemove, onEdit, onClear }: MessageQueuePanelProps) {
  const { t } = useTranslation()
  const [isExpanded, setIsExpanded] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editContent, setEditContent] = useState('')

  if (queue.length === 0) return null

  const handleEditStart = (item: PendingMessage) => {
    setEditingId(item.id)
    setEditContent(item.content)
  }

  const handleEditSave = () => {
    if (editingId && editContent.trim()) {
      onEdit(editingId, editContent.trim())
    }
    setEditingId(null)
    setEditContent('')
  }

  const handleEditCancel = () => {
    setEditingId(null)
    setEditContent('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleEditSave()
    } else if (e.key === 'Escape') {
      handleEditCancel()
    }
  }

  // Truncate content for display
  const truncateContent = (content: string) => {
    if (content.length <= MAX_PREVIEW_LENGTH) return content
    return content.slice(0, MAX_PREVIEW_LENGTH) + '...'
  }

  return (
    <div className="border-b border-border/50 bg-background">
      {/* Header - always visible */}
      <div
        className="flex items-center justify-between px-4 py-2 cursor-pointer hover:bg-muted/30 transition-colors"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <ListOrdered size={16} />
          <span>
            {queue.length === 1
              ? t('1 message queued')
              : t('{{count}} messages queued', { count: queue.length })}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {/* Clear all button */}
          <button
            onClick={(e) => {
              e.stopPropagation()
              onClear()
            }}
            className="p-1.5 text-muted-foreground/60 hover:text-destructive hover:bg-destructive/10
              rounded-md transition-colors"
            title={t('Clear all')}
          >
            <X size={14} />
          </button>
          {/* Expand/collapse button */}
          <button
            className="p-1.5 text-muted-foreground/60 hover:text-muted-foreground hover:bg-muted/50
              rounded-md transition-colors"
          >
            {isExpanded ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
          </button>
        </div>
      </div>

      {/* Queue items - visible when expanded */}
      {isExpanded && (
        <div className="px-4 pb-2 space-y-1">
          {queue.map((item, index) => (
            <div
              key={item.id}
              className="group flex items-start gap-2 py-2 px-3 rounded-lg bg-muted/30
                hover:bg-muted/50 transition-colors"
            >
              {/* Queue number */}
              <span className="flex-shrink-0 w-5 h-5 flex items-center justify-center
                text-xs font-medium text-muted-foreground bg-muted rounded-full">
                {index + 1}
              </span>

              {/* Content */}
              <div className="flex-1 min-w-0">
                {editingId === item.id ? (
                  <textarea
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    onKeyDown={handleKeyDown}
                    onBlur={handleEditSave}
                    autoFocus
                    className="w-full bg-background border border-primary/30 rounded px-2 py-1
                      text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary/30
                      resize-none"
                    rows={2}
                  />
                ) : (
                  <p className="text-sm text-foreground truncate">
                    {truncateContent(item.content)}
                  </p>
                )}
                {/* Meta info */}
                <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground/60">
                  {item.images && item.images.length > 0 && (
                    <span>{t('{{count}} images', { count: item.images.length })}</span>
                  )}
                  {item.thinkingEnabled && (
                    <span className="text-primary/60">{t('Deep Thinking')}</span>
                  )}
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100
                transition-opacity">
                {/* Edit button */}
                <button
                  onClick={() => handleEditStart(item)}
                  className="p-1.5 text-muted-foreground/60 hover:text-primary hover:bg-primary/10
                    rounded-md transition-colors"
                  title={t('Edit')}
                >
                  <Edit2 size={14} />
                </button>
                {/* Remove button */}
                <button
                  onClick={() => onRemove(item.id)}
                  className="p-1.5 text-muted-foreground/60 hover:text-destructive hover:bg-destructive/10
                    rounded-md transition-colors"
                  title={t('Remove')}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
