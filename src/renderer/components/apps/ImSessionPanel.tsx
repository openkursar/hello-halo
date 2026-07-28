/**
 * ImSessionPanel
 *
 * Right-side panel showing all conversations for the current digital human.
 * First item is always "Halo Chat" (native conversation), followed by
 * IM sessions sorted by lastActiveAt descending.
 *
 * Sessions data is managed centrally in apps-page.store (single fetch loop).
 * Real-time updates via app:im-session-updated event.
 *
 * Supports clearing individual IM sessions via a confirmation dialog.
 */

import { useEffect, useCallback, useMemo } from 'react'
import { MessageSquare, X, Plus } from 'lucide-react'
import { api } from '../../api'
import { useTranslation } from '../../i18n'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { useChatStore } from '../../stores/chat.store'
import { useIsMobile } from '../../hooks/useIsMobile'
import { buildImSessionKey, buildLocalSessionKey } from '../../../shared/apps/im-keys'
import { LOCAL_SESSION_CHANNEL } from '../../../shared/types/im-channel'
import { ImSessionItem } from './ImSessionItem'
import type { ImSessionRecord } from '../../../shared/types/im-channel'

interface ImSessionPanelProps {
  appId: string
  spaceId: string
  /** Called after an IM session is successfully cleared */
  onSessionCleared?: (session: ImSessionRecord) => void
}

export function ImSessionPanel({ appId, spaceId, onSessionCleared }: ImSessionPanelProps) {
  const { t } = useTranslation()
  const isMobile = useIsMobile()
  const {
    selectedImSession, selectImSession, toggleImPanel,
    imSessions, fetchImSessions,
  } = useAppsPageStore()
  const resetSession = useChatStore(s => s.resetSession)
  const markSessionStopped = useChatStore(s => s.markSessionStopped)

  // Fetch + poll from shared store
  useEffect(() => {
    fetchImSessions(appId)
    const interval = setInterval(() => fetchImSessions(appId), 15000)
    return () => clearInterval(interval)
  }, [appId, fetchImSessions])

  // Listen for real-time IM session updates
  useEffect(() => {
    const unsub = api.onImSessionUpdated?.((data: unknown) => {
      const update = data as { appId?: string }
      if (update.appId === appId) {
        fetchImSessions(appId)
      }
    })
    return () => { unsub?.() }
  }, [appId, fetchImSessions])

  const handleSelectHaloChat = () => {
    selectImSession(null)
    if (isMobile) toggleImPanel()
  }

  const handleSelectImSession = (session: typeof imSessions[number]) => {
    selectImSession(session)
    if (isMobile) toggleImPanel()
  }

  const handleClearConfirm = useCallback(async (session: ImSessionRecord) => {
    try {
      const res = await api.appImChatClear(appId, spaceId, session.channel, session.chatType, session.chatId)
      if (res.success) {
        const conversationId = buildImSessionKey(appId, session.channel, session.chatType, session.chatId)
        resetSession(conversationId)
        onSessionCleared?.(session)
      }
    } catch (err) {
      console.error('[ImSessionPanel] Clear session error:', err)
    }
  }, [appId, spaceId, resetSession, onSessionCleared])

  // Stop an IM session's active generation. Backend keeps the history, so settle
  // the generating state rather than resetting the session.
  const handleStopConfirm = useCallback(async (session: ImSessionRecord) => {
    try {
      const res = await api.appImChatStop(appId, spaceId, session.channel, session.chatType, session.chatId)
      if (res.success) {
        markSessionStopped(buildImSessionKey(appId, session.channel, session.chatType, session.chatId))
      } else {
        console.error('[ImSessionPanel] Stop session error:', res.error)
      }
    } catch (err) {
      console.error('[ImSessionPanel] Stop session error:', err)
    }
  }, [appId, spaceId, markSessionStopped])

  // ── Native local sessions: create / rename / delete ──
  // Local sessions surface in the same list (source==='local'); split them out
  // so they render as interactive native chats above the IM/HTTP sessions.
  const localSessions = useMemo(() => imSessions.filter(s => s.source === 'local'), [imSessions])
  const channelSessions = useMemo(() => imSessions.filter(s => s.source !== 'local'), [imSessions])

  const handleNewChat = useCallback(async () => {
    try {
      const res = await api.appSessionCreate(appId)
      if (res.success && res.data) {
        const record = (res.data as { record: ImSessionRecord }).record
        await fetchImSessions(appId)
        selectImSession(record)
        if (isMobile) toggleImPanel()
      }
    } catch (err) {
      console.error('[ImSessionPanel] New chat error:', err)
    }
  }, [appId, fetchImSessions, selectImSession, isMobile, toggleImPanel])

  const handleRenameConfirm = useCallback(async (session: ImSessionRecord, name: string) => {
    try {
      const res = await api.imSessionsSetCustomName({ appId, channel: session.channel, chatId: session.chatId, name })
      if (res.success) await fetchImSessions(appId)
    } catch (err) {
      console.error('[ImSessionPanel] Rename session error:', err)
    }
  }, [appId, fetchImSessions])

  const handleDeleteConfirm = useCallback(async (session: ImSessionRecord) => {
    try {
      const conversationId = buildLocalSessionKey(appId, session.chatId)
      const res = await api.appSessionDelete(appId, spaceId, conversationId)
      if (res.success) {
        resetSession(conversationId)
        // Deselect if the deleted session was active, falling back to the default.
        if (
          selectedImSession?.channel === LOCAL_SESSION_CHANNEL &&
          selectedImSession?.chatId === session.chatId
        ) {
          selectImSession(null)
        }
        await fetchImSessions(appId)
      }
    } catch (err) {
      console.error('[ImSessionPanel] Delete session error:', err)
    }
  }, [appId, spaceId, resetSession, selectedImSession, selectImSession, fetchImSessions])

  const isHaloChatSelected = selectedImSession === null

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Panel header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border flex-shrink-0">
        <span className="text-sm font-medium">{t('Conversations')}</span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={handleNewChat}
            className="p-1 rounded hover:bg-secondary transition-colors"
            title={t('New chat')}
          >
            <Plus className="w-4 h-4 text-muted-foreground" />
          </button>
          <button
            onClick={toggleImPanel}
            className="p-1 rounded hover:bg-secondary transition-colors"
          >
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto">
        {/* Fixed: Halo Chat (native default conversation) */}
        <button
          onClick={handleSelectHaloChat}
          className={`w-full text-left px-3 py-2.5 transition-colors ${
            isHaloChatSelected
              ? 'bg-secondary text-foreground'
              : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
          }`}
        >
          <div className="flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-primary flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium">{t('Halo Chat')}</div>
              <div className="text-[11px] text-muted-foreground/60 mt-0.5">
                {t('Native conversation')}
              </div>
            </div>
          </div>
        </button>

        {/* Native local sessions (interactive) */}
        {localSessions.map(session => (
          <ImSessionItem
            key={`${LOCAL_SESSION_CHANNEL}:${session.chatId}`}
            session={session}
            isSelected={
              selectedImSession?.source === 'local' &&
              selectedImSession?.chatId === session.chatId
            }
            onClick={() => handleSelectImSession(session)}
            onRenameConfirm={handleRenameConfirm}
            onDeleteConfirm={handleDeleteConfirm}
          />
        ))}

        {/* Divider before IM/HTTP channel sessions */}
        {channelSessions.length > 0 && <div className="border-b border-border" />}

        {/* IM / HTTP channel sessions (read-only viewers) */}
        {channelSessions.map(session => (
          <ImSessionItem
            key={`${session.channel}:${session.chatId}`}
            session={session}
            isSelected={
              selectedImSession?.channel === session.channel &&
              selectedImSession?.source !== 'local' &&
              selectedImSession?.chatId === session.chatId
            }
            onClick={() => handleSelectImSession(session)}
            onClearConfirm={handleClearConfirm}
            onStopConfirm={handleStopConfirm}
          />
        ))}

        {/* Empty state — only when there are no sessions of any kind */}
        {imSessions.length === 0 && (
          <div className="px-3 py-6 text-center">
            <p className="text-xs text-muted-foreground/50">
              {t('Start a new chat or connect an IM channel')}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
