/**
 * ImChatView
 *
 * Read-only viewer for IM session conversations. Displays persisted
 * message history and real-time streaming state (thoughts, browser tasks,
 * streaming text) for the selected IM session.
 *
 * No input area — IM interactions happen in the external IM channel.
 * Reuses the same atomic chat components as AppChatView for consistency.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { Loader2, AlertCircle, Radio, Eraser, Square } from 'lucide-react'
import { api } from '../../api'
import { useChatStore } from '../../stores/chat.store'
import { MessageList } from '../chat/MessageList'
import type { MessageListHandle } from '../chat/MessageList'
import { ScrollToBottomButton } from '../chat/ScrollToBottomButton'
import { useRemoteSubscription } from '../../hooks/useRemoteSubscription'
import { useWsRecovery } from '../../hooks/useWsRecovery'
import { useTranslation } from '../../i18n'
import type { Message } from '../../types'
import type { ImSessionRecord } from '../../../shared/types/im-channel'
import { buildImSessionKey } from '../../../shared/apps/im-keys'
import { CHANNEL_LABELS } from './im-channel-labels'

interface ImChatViewProps {
  appId: string
  spaceId: string
  session: ImSessionRecord
  /** Incrementing key to trigger message reload after external clear (e.g., from ImSessionPanel) */
  clearKey?: number
}

type LoadState = 'loading' | 'loaded' | 'error' | 'empty'

export function ImChatView({ appId, spaceId, session, clearKey }: ImChatViewProps) {
  const { t } = useTranslation()

  const conversationId = buildImSessionKey(appId, session.channel, session.chatType, session.chatId)

  // ── Subscribe to agent events (remote/Capacitor clients use WebSocket) ──
  useRemoteSubscription(conversationId)

  // Persisted messages
  const [messages, setMessages] = useState<Message[]>([])
  const [loadState, setLoadState] = useState<LoadState>('loading')

  // Streaming state from chat store
  const chatSession = useChatStore(s => s.getSession(conversationId))
  const {
    isGenerating,
    streamingContent,
    isStreaming,
    thoughts,
    isThinking,
    error,
    errorType,
    compactInfo,
    textBlockVersion,
  } = chatSession

  // Scroll control via the shared MessageList shell (Virtuoso-based)
  const messageListRef = useRef<MessageListHandle>(null)
  const [showScrollButton, setShowScrollButton] = useState(false)
  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    setShowScrollButton(!atBottom)
  }, [])

  // Load persisted messages
  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoadState('loading')
      try {
        const res = await api.appImChatMessages(appId, spaceId, session.channel, session.chatType, session.chatId)
        if (cancelled) return
        if (res.success && res.data) {
          const msgs = (res.data as Message[]) ?? []
          setMessages(msgs)
          setLoadState(msgs.length > 0 ? 'loaded' : 'empty')
        } else {
          setLoadState('empty')
        }
      } catch (err) {
        if (cancelled) return
        console.error('[ImChatView] Failed to load messages:', err)
        setLoadState('error')
      }
    }
    load()
    return () => { cancelled = true }
  }, [appId, spaceId, session.channel, session.chatType, session.chatId, clearKey])

  // Reload messages when generation starts (to show the incoming user IM message before
  // thinking begins) and when generation completes (to show the assistant response).
  const prevIsGeneratingRef = useRef(isGenerating)
  useEffect(() => {
    let cancelled = false
    const wasGenerating = prevIsGeneratingRef.current
    prevIsGeneratingRef.current = isGenerating

    if (wasGenerating !== isGenerating) {
      api.appImChatMessages(appId, spaceId, session.channel, session.chatType, session.chatId)
        .then(res => {
          if (cancelled) return
          if (res.success && res.data) {
            const msgs = (res.data as Message[]) ?? []
            setMessages(msgs)
            setLoadState(msgs.length > 0 ? 'loaded' : 'empty')
          }
        })
        .catch(err => { if (!cancelled) console.error('[ImChatView] Reload error:', err) })
    }
    return () => { cancelled = true }
  }, [isGenerating, appId, spaceId, session.channel, session.chatType, session.chatId])

  // ── WebSocket reconnect recovery (remote/Capacitor only) ──
  // Same pattern as AppChatView — reload messages and reconcile session state
  // after a WebSocket reconnect to recover any events lost during the gap.
  useWsRecovery(useCallback(() => {
    console.log(`[ImChatView] WS reconnected — reloading messages for ${conversationId}`)
    api.appImChatMessages(appId, spaceId, session.channel, session.chatType, session.chatId)
      .then(res => {
        if (res.success && res.data) {
          const msgs = (res.data as Message[]) ?? []
          setMessages(msgs)
          setLoadState(msgs.length > 0 ? 'loaded' : 'empty')
        }
      })
      .catch(err => {
        console.error('[ImChatView] WS recovery reload failed:', err)
      })

    // If frontend thinks we're still generating, verify with backend
    if (useChatStore.getState().getSession(conversationId).isGenerating) {
      api.getSessionState(conversationId).then(res => {
        if (res.success && res.data) {
          const { isActive } = res.data as { isActive: boolean }
          if (!isActive) {
            console.log(`[ImChatView] Backend session inactive — clearing stale generating state`)
            useChatStore.getState().resetSession(conversationId)
          }
        }
      }).catch(() => {})
    }
  }, [appId, spaceId, conversationId, session.channel, session.chatType, session.chatId]))

  // ── Clear session (with confirmation) ──
  const resetSession = useChatStore(s => s.resetSession)
  const [showClearConfirm, setShowClearConfirm] = useState(false)

  // ── Stop generation (with confirmation) ──
  // Aborts the current turn only; history is preserved. The chat store's
  // isGenerating flag flips to false once the abort propagates through the
  // stream processor — no manual resetSession needed.
  const [showStopConfirm, setShowStopConfirm] = useState(false)
  const [isStopping, setIsStopping] = useState(false)

  const handleStopSession = useCallback(async () => {
    if (isStopping) return
    setIsStopping(true)
    try {
      const res = await api.appImChatStop(appId, spaceId, session.channel, session.chatType, session.chatId)
      if (!res.success) {
        console.error('[ImChatView] Stop session error:', res.error)
      }
    } catch (err) {
      console.error('[ImChatView] Stop session error:', err)
    } finally {
      setIsStopping(false)
      setShowStopConfirm(false)
    }
  }, [appId, spaceId, session.channel, session.chatType, session.chatId, isStopping])

  const handleClearSession = useCallback(async () => {
    try {
      const res = await api.appImChatClear(appId, spaceId, session.channel, session.chatType, session.chatId)
      if (res.success) {
        setMessages([])
        setLoadState('empty')
        resetSession(conversationId)
      }
    } catch (err) {
      console.error('[ImChatView] Clear session error:', err)
    } finally {
      setShowClearConfirm(false)
    }
  }, [appId, spaceId, session.channel, session.chatType, session.chatId, conversationId, resetSession])

  const displayName = session.customName || session.displayName || session.chatId
  const channelLabel = CHANNEL_LABELS[session.channel] ?? session.channel
  const chatTypeLabel = session.chatType === 'group' ? t('Group') : t('Direct')
  const hasStreamingContent = isGenerating && (streamingContent || thoughts.length > 0 || isThinking)

  // Loading state
  if (loadState === 'loading') {
    return (
      <div className="flex flex-col h-full">
        <ImChatInfoBar name={displayName} channel={channelLabel} chatType={chatTypeLabel} isGenerating={false} hasMessages={false} showClearConfirm={false} onClearClick={() => {}} onClearConfirm={() => {}} onClearCancel={() => {}} showStopConfirm={false} isStopping={false} onStopClick={() => {}} onStopConfirm={() => {}} onStopCancel={() => {}} t={t} />
        <div className="flex-1 flex items-center justify-center">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">{t('Loading chat...')}</span>
          </div>
        </div>
      </div>
    )
  }

  // Error state
  if (loadState === 'error') {
    return (
      <div className="flex flex-col h-full">
        <ImChatInfoBar name={displayName} channel={channelLabel} chatType={chatTypeLabel} isGenerating={false} hasMessages={false} showClearConfirm={false} onClearClick={() => {}} onClearConfirm={() => {}} onClearCancel={() => {}} showStopConfirm={false} isStopping={false} onStopClick={() => {}} onStopConfirm={() => {}} onStopCancel={() => {}} t={t} />
        <div className="flex-1 flex items-center justify-center">
          <div className="flex flex-col items-center gap-2 text-muted-foreground">
            <AlertCircle className="w-5 h-5 text-destructive" />
            <p className="text-sm">{t('Failed to load chat')}</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <ImChatInfoBar
        name={displayName}
        channel={channelLabel}
        chatType={chatTypeLabel}
        isGenerating={isGenerating}
        hasMessages={messages.length > 0}
        showClearConfirm={showClearConfirm}
        onClearClick={() => setShowClearConfirm(true)}
        onClearConfirm={handleClearSession}
        onClearCancel={() => setShowClearConfirm(false)}
        showStopConfirm={showStopConfirm}
        isStopping={isStopping}
        onStopClick={() => setShowStopConfirm(true)}
        onStopConfirm={handleStopSession}
        onStopCancel={() => setShowStopConfirm(false)}
        t={t}
      />

      {/* Read-only: IM interactions happen in the external channel, so no input here. */}
      <div className="flex-1 relative overflow-hidden">
        {loadState === 'empty' && !hasStreamingContent ? (
          <div className="h-full flex items-center justify-center px-4">
            <p className="text-sm text-muted-foreground">{t('No messages yet')}</p>
          </div>
        ) : (
          <div className="h-full px-4">
            <MessageList
              ref={messageListRef}
              conversationId={conversationId}
              messages={messages}
              streamingContent={streamingContent}
              isGenerating={isGenerating}
              isStreaming={isStreaming}
              thoughts={thoughts}
              isThinking={isThinking}
              compactInfo={compactInfo}
              error={error}
              errorType={errorType}
              textBlockVersion={textBlockVersion}
              onAtBottomStateChange={handleAtBottomStateChange}
              hideBrowserViewButton
            />
          </div>
        )}

        <ScrollToBottomButton
          visible={showScrollButton && !(loadState === 'empty' && !hasStreamingContent)}
          onClick={() => messageListRef.current?.scrollToBottom('auto')}
        />
      </div>
    </div>
  )
}

// ── Info bar sub-component ──

interface ImChatInfoBarProps {
  name: string
  channel: string
  chatType: string
  isGenerating: boolean
  hasMessages: boolean
  showClearConfirm: boolean
  onClearClick: () => void
  onClearConfirm: () => void
  onClearCancel: () => void
  showStopConfirm: boolean
  isStopping: boolean
  onStopClick: () => void
  onStopConfirm: () => void
  onStopCancel: () => void
  t: (key: string) => string
}

function ImChatInfoBar({ name, channel, chatType, isGenerating, hasMessages, showClearConfirm, onClearClick, onClearConfirm, onClearCancel, showStopConfirm, isStopping, onStopClick, onStopConfirm, onStopCancel, t }: ImChatInfoBarProps) {
  return (
    <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-muted/30 flex-shrink-0">
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <span className="text-sm font-medium truncate">{name}</span>
        <span className="text-[11px] text-muted-foreground">
          {channel} · {chatType}
        </span>
      </div>
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        {isGenerating && <Radio className="w-3 h-3 text-primary animate-pulse" />}
        {showStopConfirm ? (
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground/80">{t('Stop?')}</span>
            <button
              onClick={onStopConfirm}
              disabled={isStopping}
              className="px-1.5 py-0.5 text-destructive hover:bg-destructive/10 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isStopping ? t('Stopping...') : t('Confirm')}
            </button>
            <button
              onClick={onStopCancel}
              disabled={isStopping}
              className="px-1.5 py-0.5 text-muted-foreground hover:bg-secondary rounded transition-colors disabled:opacity-50"
            >
              {t('Cancel')}
            </button>
          </div>
        ) : showClearConfirm ? (
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground/80">{t('Clear?')}</span>
            <button
              onClick={onClearConfirm}
              className="px-1.5 py-0.5 text-destructive hover:bg-destructive/10 rounded transition-colors"
            >
              {t('Confirm')}
            </button>
            <button
              onClick={onClearCancel}
              className="px-1.5 py-0.5 text-muted-foreground hover:bg-secondary rounded transition-colors"
            >
              {t('Cancel')}
            </button>
          </div>
        ) : (
          <>
            {isGenerating && (
              <button
                onClick={onStopClick}
                className="p-1 rounded hover:bg-secondary transition-colors"
                title={t('Stop generation')}
              >
                <Square className="w-3.5 h-3.5 text-destructive/80 hover:text-destructive" fill="currentColor" />
              </button>
            )}
            {hasMessages && !isGenerating && (
              <button
                onClick={onClearClick}
                className="p-1 rounded hover:bg-secondary transition-colors"
                title={t('Clear session')}
              >
                <Eraser className="w-3.5 h-3.5 text-muted-foreground/60 hover:text-muted-foreground" />
              </button>
            )}
            <span>{t('Read-only · Interact via IM channel')}</span>
          </>
        )}
      </div>
    </div>
  )
}