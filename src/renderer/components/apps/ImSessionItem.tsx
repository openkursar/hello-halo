/**
 * ImSessionItem
 *
 * Renders a single IM session entry in the session panel list.
 * Shows session name, channel badge, chat type icon, last message preview,
 * relative time, and an active indicator when the session is generating.
 *
 * Supports an optional onClear callback to trigger session clearing
 * from a hover-revealed clear button.
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import { Eraser, User, Users, MessageSquare, Pencil, Trash2, Check, X } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useChatStore } from '../../stores/chat.store'
import type { ImSessionRecord } from '../../../shared/types/im-channel'
import { buildImSessionKey, buildLocalSessionKey } from '../../../shared/apps/im-keys'
import { CHANNEL_LABELS } from './im-channel-labels'

interface ImSessionItemProps {
  session: ImSessionRecord
  isSelected: boolean
  onClick: () => void
  /** Called when the user confirms clearing this session (IM/HTTP sessions) */
  onClearConfirm?: (session: ImSessionRecord) => void
  /** Called with a new name to rename this session (native local sessions) */
  onRenameConfirm?: (session: ImSessionRecord, name: string) => void
  /** Called when the user confirms deleting this session (native local sessions) */
  onDeleteConfirm?: (session: ImSessionRecord) => void
}

/** Format relative time from epoch ms — all strings go through t() for i18n. */
function formatRelativeTime(epochMs: number, t: (key: string, options?: Record<string, unknown>) => string): string {
  const diff = Date.now() - epochMs
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return t('now')
  if (minutes < 60) return t('{{count}}m', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('{{count}}h', { count: hours })
  const days = Math.floor(hours / 24)
  return t('{{count}}d', { count: days })
}

export function ImSessionItem({ session, isSelected, onClick, onClearConfirm, onRenameConfirm, onDeleteConfirm }: ImSessionItemProps) {
  const { t } = useTranslation()
  const [showClearConfirm, setShowClearConfirm] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)

  const isLocal = session.source === 'local'
  const conversationId = isLocal
    ? buildLocalSessionKey(session.appId, session.chatId)
    : buildImSessionKey(session.appId, session.channel, session.chatType, session.chatId)
  const isGenerating = useChatStore(s => s.getSession(conversationId).isGenerating)

  // Native local sessions have no channel/type; fall back through custom name →
  // first-message preview → a localized "New chat" so the row is never a raw uuid.
  const trimmedDisplay = session.displayName?.trim() ? session.displayName : ''
  const displayName = isLocal
    ? (session.customName || trimmedDisplay || session.lastMessage || t('New chat'))
    : (session.customName || session.displayName || session.chatId)
  const channelLabel = CHANNEL_LABELS[session.channel] ?? session.channel
  const chatTypeLabel = session.chatType === 'group' ? t('Group') : t('Direct')
  const ChatTypeIcon = session.chatType === 'group' ? Users : User

  useEffect(() => {
    if (isRenaming) renameInputRef.current?.focus()
  }, [isRenaming])

  const handleClearClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    setShowClearConfirm(true)
  }, [])

  const handleConfirm = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    onClearConfirm?.(session)
    setShowClearConfirm(false)
  }, [session, onClearConfirm])

  const handleCancel = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    setShowClearConfirm(false)
  }, [])

  const handleRenameClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    setRenameValue(session.customName || trimmedDisplay || '')
    setIsRenaming(true)
  }, [session.customName, trimmedDisplay])

  const submitRename = useCallback(() => {
    const name = renameValue.trim()
    if (name) onRenameConfirm?.(session, name)
    setIsRenaming(false)
  }, [renameValue, session, onRenameConfirm])

  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    setShowDeleteConfirm(true)
  }, [])

  const handleDeleteConfirm = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    onDeleteConfirm?.(session)
    setShowDeleteConfirm(false)
  }, [session, onDeleteConfirm])

  // Inline rename editor replaces the row content while active.
  if (isRenaming) {
    return (
      <div className="w-full px-3 py-2.5 bg-secondary">
        <div className="flex items-center gap-1.5">
          <input
            ref={renameInputRef}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitRename()
              else if (e.key === 'Escape') setIsRenaming(false)
            }}
            onClick={(e) => e.stopPropagation()}
            placeholder={t('Session name')}
            className="flex-1 min-w-0 bg-background border border-border rounded px-2 py-1 text-sm text-foreground outline-none focus:border-primary"
          />
          <button
            onClick={(e) => { e.stopPropagation(); submitRename() }}
            className="p-1 rounded hover:bg-background transition-colors"
            title={t('Confirm')}
          >
            <Check className="w-3.5 h-3.5 text-primary" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); setIsRenaming(false) }}
            className="p-1 rounded hover:bg-background transition-colors"
            title={t('Cancel')}
          >
            <X className="w-3.5 h-3.5 text-muted-foreground" />
          </button>
        </div>
      </div>
    )
  }

  return (
    <button
      onClick={onClick}
      className={`group w-full text-left px-3 py-2.5 transition-colors ${
        isSelected
          ? 'bg-secondary text-foreground'
          : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
      }`}
    >
      <div className="flex items-center gap-2 min-w-0">
        {/* Active indicator */}
        {isGenerating && (
          <span className="w-2 h-2 rounded-full bg-primary animate-pulse flex-shrink-0" />
        )}

        <div className="flex-1 min-w-0">
          {/* Name */}
          <div className="text-sm font-medium truncate">{displayName}</div>

          {/* Meta: channel + type (IM/HTTP) or a client-session label (local) */}
          <div className="flex items-center gap-1.5 mt-0.5">
            {isLocal ? (
              <>
                <MessageSquare className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                <span className="text-[11px] text-muted-foreground truncate">
                  {t('Client session')}
                </span>
              </>
            ) : (
              <>
                <ChatTypeIcon className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                <span className="text-[11px] text-muted-foreground truncate">
                  {channelLabel} · {chatTypeLabel}
                </span>
              </>
            )}
          </div>

          {/* Last message preview (skip when it's already the fallback title) */}
          {session.lastMessage && !(isLocal && displayName === session.lastMessage) && (
            <p className="text-[11px] text-muted-foreground/60 truncate mt-0.5">
              {session.lastSender ? `${session.lastSender}: ` : ''}{session.lastMessage}
            </p>
          )}
        </div>

        {/* Time + actions / inline confirmation */}
        <div className="flex flex-col items-end gap-1 flex-shrink-0 self-start mt-0.5">
          {showClearConfirm || showDeleteConfirm ? (
            <div className="flex items-center gap-1.5">
              <button
                onClick={showDeleteConfirm ? handleDeleteConfirm : handleConfirm}
                className="px-1.5 py-0.5 text-[11px] text-destructive hover:bg-destructive/10 rounded transition-colors"
              >
                {t('Confirm')}
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setShowClearConfirm(false); setShowDeleteConfirm(false) }}
                className="px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-secondary rounded transition-colors"
              >
                {t('Cancel')}
              </button>
            </div>
          ) : (
            <>
              <span className="text-[10px] text-muted-foreground/50">
                {formatRelativeTime(session.lastActiveAt, t)}
              </span>
              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-all">
                {onRenameConfirm && (
                  <button
                    onClick={handleRenameClick}
                    className="p-0.5 rounded hover:bg-background transition-all"
                    title={t('Rename')}
                  >
                    <Pencil className="w-3 h-3 text-muted-foreground/60 hover:text-foreground" />
                  </button>
                )}
                {onDeleteConfirm && !isGenerating && (
                  <button
                    onClick={handleDeleteClick}
                    className="p-0.5 rounded hover:bg-background transition-all"
                    title={t('Delete session')}
                  >
                    <Trash2 className="w-3 h-3 text-muted-foreground/60 hover:text-destructive" />
                  </button>
                )}
                {onClearConfirm && !isGenerating && (
                  <button
                    onClick={handleClearClick}
                    className="p-0.5 rounded hover:bg-background transition-all"
                    title={t('Clear session')}
                  >
                    <Eraser className="w-3 h-3 text-muted-foreground/60 hover:text-destructive" />
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </button>
  )
}
