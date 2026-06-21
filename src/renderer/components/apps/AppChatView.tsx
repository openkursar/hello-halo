/**
 * AppChatView
 *
 * Interactive chat view for automation Apps (digital humans).
 * Allows users to chat with an App's AI agent in real-time,
 * reusing the same streaming infrastructure as the main Agent chat.
 *
 * Architecture:
 * - Uses the virtual conversationId "app-chat:{appId}" for event routing
 * - The existing agent event listeners in App.tsx are GLOBAL — they dispatch
 *   to chat.store.ts sessions by conversationId. App chat events automatically
 *   flow to sessions.get("app-chat:{appId}") without any extra wiring.
 * - Persisted messages loaded from JSONL via app:chat-messages IPC
 * - Reuses shared rendering components (MessageRow, StreamingSection) from main chat
 *   for consistent message and streaming display across all chat views.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Loader2, AlertCircle, Eraser } from 'lucide-react'
import { api } from '../../api'
import { useChatStore } from '../../stores/chat.store'
import { MessageList } from '../chat/MessageList'
import type { MessageListHandle } from '../chat/MessageList'
import { ScrollToBottomButton } from '../chat/ScrollToBottomButton'
import { InputArea } from '../chat/InputArea'
import { useRemoteSubscription } from '../../hooks/useRemoteSubscription'
import { useWsRecovery } from '../../hooks/useWsRecovery'
import { useTranslation } from '../../i18n'
import type { Message, ImageAttachment, Artifact } from '../../types'
import type { SlashCommandItem } from '../../types/slash-command'
import { getAppChatConversationId } from '../../../shared/apps/im-keys'

interface AppChatViewProps {
  /** App ID */
  appId: string
  /** Space ID (for loading messages and sending chat) */
  spaceId: string
}

type LoadState = 'loading' | 'loaded' | 'error' | 'empty'

export function AppChatView({ appId, spaceId }: AppChatViewProps) {
  const { t } = useTranslation()
  const conversationId = getAppChatConversationId(appId)

  // ── Subscribe to agent events (remote/Capacitor clients use WebSocket) ──
  useRemoteSubscription(conversationId)

  // ── Persisted messages ──
  const [messages, setMessages] = useState<Message[]>([])
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  // ── Streaming state from chat store (uses virtual conversationId) ──
  const session = useChatStore(s => s.getSession(conversationId))
  const sessionInitInfo = useChatStore(s => s.sessionInitInfo)
  const resetSession = useChatStore(s => s.resetSession)
  const answerQuestion = useChatStore(s => s.answerQuestion)
  const {
    isGenerating,
    streamingContent,
    isStreaming,
    thoughts,
    isThinking,
    pendingQuestion,
    error,
    errorType,
    compactInfo,
    textBlockVersion,
  } = session

  // ── Scroll control via the shared MessageList shell (Virtuoso-based) ──
  const messageListRef = useRef<MessageListHandle>(null)
  const [showScrollButton, setShowScrollButton] = useState(false)
  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    setShowScrollButton(!atBottom)
  }, [])

  // ── Slash-command list for this app-chat session (SDK system:init, keyed by conversationId) ──
  const slashCommands = useMemo<SlashCommandItem[]>(() => {
    const initInfo = sessionInitInfo.get(conversationId)
    if (!initInfo?.slashCommands) return []
    const skillsSet = new Set(initInfo.skills || [])
    const items: SlashCommandItem[] = []
    const seen = new Set<string>()
    for (const cmd of initInfo.slashCommands) {
      if (seen.has(cmd)) continue
      seen.add(cmd)
      const category = skillsSet.has(cmd) ? 'skill' : 'builtin'
      items.push({ id: `${category}-${cmd}`, command: `/${cmd}`, label: cmd, category })
    }
    return items
  }, [sessionInitInfo, conversationId])

  // ── Artifacts for @ mention suggestions (depth=5, mirrors space chat) ──
  const [mentionArtifacts, setMentionArtifacts] = useState<Artifact[]>([])
  useEffect(() => {
    if (!spaceId) {
      setMentionArtifacts([])
      return
    }
    let cancelled = false
    api.listArtifacts(spaceId, 5).then(response => {
      if (!cancelled && response.success && response.data) {
        setMentionArtifacts(response.data as Artifact[])
      }
    }).catch(err => {
      if (!cancelled) console.error('[AppChatView] Failed to load mention artifacts:', err)
    })
    return () => { cancelled = true }
  }, [spaceId])

  // ── Load persisted chat messages on mount ──
  useEffect(() => {
    let cancelled = false

    async function loadMessages() {
      setLoadState('loading')
      setErrorMsg(null)
      try {
        const res = await api.appChatMessages(appId, spaceId)
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
        console.error('[AppChatView] Failed to load messages:', err)
        setErrorMsg(String(err))
        setLoadState('error')
      }
    }

    loadMessages()
    return () => { cancelled = true }
  }, [appId, spaceId])

  // ── Reload messages when generation completes ──
  // This ensures the persisted messages include the latest assistant response
  const prevIsGeneratingRef = useRef(isGenerating)
  useEffect(() => {
    let cancelled = false
    if (prevIsGeneratingRef.current && !isGenerating) {
      // Generation just completed — reload messages from JSONL
      api.appChatMessages(appId, spaceId).then(res => {
        if (cancelled) return
        if (res.success && res.data) {
          const msgs = (res.data as Message[]) ?? []
          setMessages(msgs)
          setLoadState(msgs.length > 0 ? 'loaded' : 'empty')
        }
      }).catch(err => {
        if (!cancelled) console.error('[AppChatView] Failed to reload messages after completion:', err)
      })
    }
    prevIsGeneratingRef.current = isGenerating
    return () => { cancelled = true }
  }, [isGenerating, appId, spaceId])

  // ── WebSocket reconnect recovery (remote/Capacitor only) ──
  // When the WebSocket drops and reconnects, events during the gap are lost.
  // Reload messages and reconcile session state to ensure the UI is up-to-date.
  useWsRecovery(useCallback(() => {
    console.log(`[AppChatView] WS reconnected — reloading messages for ${conversationId}`)
    api.appChatMessages(appId, spaceId).then(res => {
      if (res.success && res.data) {
        const msgs = (res.data as Message[]) ?? []
        setMessages(msgs)
        setLoadState(msgs.length > 0 ? 'loaded' : 'empty')
      }
    }).catch(err => {
      console.error('[AppChatView] WS recovery reload failed:', err)
    })

    // If frontend thinks we're still generating, verify with backend
    if (useChatStore.getState().getSession(conversationId).isGenerating) {
      api.getSessionState(conversationId).then(res => {
        if (res.success && res.data) {
          const { isActive } = res.data as { isActive: boolean }
          if (!isActive) {
            console.log(`[AppChatView] Backend session inactive — clearing stale generating state`)
            useChatStore.getState().resetSession(conversationId)
          }
        }
      }).catch(() => {})
    }
  }, [appId, spaceId, conversationId]))

  // ── Clear chat (with confirmation) ──
  const [showClearConfirm, setShowClearConfirm] = useState(false)

  const handleClearChat = useCallback(async () => {
    try {
      const res = await api.appChatClear(appId, spaceId)
      if (res.success) {
        setMessages([])
        setLoadState('empty')
        // Reset session state to clear stale thoughts/streaming content
        resetSession(conversationId)
      }
    } catch (err) {
      console.error('[AppChatView] Clear chat error:', err)
    } finally {
      setShowClearConfirm(false)
    }
  }, [appId, spaceId, conversationId, resetSession])

  // ── Send message ──
  const handleSend = useCallback(async (content: string, images?: ImageAttachment[], thinkingEnabled?: boolean) => {
    // Reset session state before sending to clear any stale thoughts/content
    // from a previous conversation (mirrors normal chat's sendMessage behavior)
    resetSession(conversationId)

    // Optimistically add user message before API call for instant feedback
    const userMsg: Message = {
      id: `user-${Date.now()}`,
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
    }
    setMessages(prev => [...prev, userMsg])
    setLoadState('loaded')

    try {
      // Map ImageAttachment[] to API format { type, media_type, data }
      const apiImages = images && images.length > 0
        ? images.map(img => ({ type: img.type, media_type: img.mediaType, data: img.data }))
        : undefined
      const res = await api.appChatSend({
        appId,
        spaceId,
        message: content,
        images: apiImages,
        thinkingEnabled,
      })
      if (!res.success) {
        console.error('[AppChatView] Send failed:', res.error)
        // Surface error via chat store session state (rendered by error UI below)
        useChatStore.getState().setSessionError(conversationId, String(res.error || t('Failed to send message')))
      }

      // Scroll to bottom after sending
      requestAnimationFrame(() => messageListRef.current?.scrollToBottom('auto'))
    } catch (err) {
      console.error('[AppChatView] Send error:', err)
      useChatStore.getState().setSessionError(conversationId, String((err as Error).message || t('Failed to send message')))
    }
  }, [appId, spaceId, conversationId, resetSession, t])

  // ── Stop generation ──
  // Must eagerly clear frontend session state (isGenerating/isThinking) in addition
  // to sending the backend stop IPC. Without this, the UI stays stuck in "thinking"
  // because agent:complete may arrive late (backend drain) or not at all (drain race).
  // This mirrors the pattern in chat.store.ts stopGeneration() for space conversations.
  const handleStop = useCallback(async () => {
    try {
      await api.appChatStop(appId)
      useChatStore.setState((state) => {
        const newSessions = new Map(state.sessions)
        const session = newSessions.get(conversationId)
        if (session) {
          newSessions.set(conversationId, {
            ...session,
            isGenerating: false,
            isThinking: false,
            pendingQuestion: session.pendingQuestion?.status === 'active'
              ? { ...session.pendingQuestion, status: 'cancelled' as const }
              : session.pendingQuestion
          })
        }
        return { sessions: newSessions }
      })
    } catch (err) {
      console.error('[AppChatView] Stop error:', err)
    }
  }, [appId, conversationId])

  // ── Answer question from AskUserQuestionCard ──
  const handleAnswerQuestion = useCallback((answers: Record<string, string>) => {
    answerQuestion(conversationId, answers)
  }, [conversationId, answerQuestion])

  // ── Loading state ──
  if (loadState === 'loading') {
    return (
      <div className="flex flex-col h-full">
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">{t('Loading chat...')}</span>
          </div>
        </div>
        <div className="shrink-0 p-4">
          <InputArea
            onSend={handleSend}
            onStop={handleStop}
            isGenerating={false}
            placeholder={t('Chat with this App...')}
          />
        </div>
      </div>
    )
  }

  // ── Error state (load error) ──
  if (loadState === 'error') {
    return (
      <div className="flex flex-col h-full">
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="flex flex-col items-center gap-2 text-muted-foreground max-w-sm text-center">
            <AlertCircle className="w-5 h-5 text-destructive" />
            <p className="text-sm">{t('Failed to load chat')}</p>
            {errorMsg && <p className="text-xs text-muted-foreground/60">{errorMsg}</p>}
          </div>
        </div>
        <div className="shrink-0 p-4">
          <InputArea
            onSend={handleSend}
            onStop={handleStop}
            isGenerating={false}
            placeholder={t('Chat with this App...')}
          />
        </div>
      </div>
    )
  }

  // ── Active state: messages + streaming + input ──
  const hasStreamingContent = isGenerating && (streamingContent || thoughts.length > 0 || isThinking)
  const showEmptyHint = loadState === 'empty' && !hasStreamingContent

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 relative overflow-hidden">
        {showEmptyHint ? (
          <div className="h-full flex items-center justify-center px-4">
            <p className="text-sm text-muted-foreground">{t('Send a message to start chatting with this App')}</p>
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
              pendingQuestion={pendingQuestion}
              onAnswerQuestion={handleAnswerQuestion}
              onAtBottomStateChange={handleAtBottomStateChange}
              hideBrowserViewButton
            />
          </div>
        )}

        <ScrollToBottomButton
          visible={showScrollButton && !showEmptyHint}
          onClick={() => messageListRef.current?.scrollToBottom('auto')}
        />
      </div>

      {/* Clear chat + Input area */}
      <div className="shrink-0 p-4">
        {messages.length > 0 && !isGenerating && (
          <div className="mb-2">
            {showClearConfirm ? (
              <div className="flex items-center justify-end gap-2">
                <span className="text-[11px] text-muted-foreground/80">{t('Clear all chat history?')}</span>
                <button
                  onClick={handleClearChat}
                  className="px-2 py-0.5 text-[11px] text-destructive hover:bg-destructive/10 rounded transition-colors"
                >
                  {t('Confirm')}
                </button>
                <button
                  onClick={() => setShowClearConfirm(false)}
                  className="px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-secondary rounded transition-colors"
                >
                  {t('Cancel')}
                </button>
              </div>
            ) : (
              <div className="flex justify-end">
                <button
                  onClick={() => setShowClearConfirm(true)}
                  className="flex items-center gap-1 px-2 py-1 text-[11px] text-muted-foreground/60 hover:text-muted-foreground transition-colors rounded"
                  title={t('Clear chat history')}
                >
                  <Eraser className="w-3 h-3" />
                  {t('Clear chat')}
                </button>
              </div>
            )}
          </div>
        )}
        <InputArea
          onSend={handleSend}
          onStop={handleStop}
          isGenerating={isGenerating}
          placeholder={t('Chat with this App...')}
          slashCommands={slashCommands}
          mentionArtifacts={mentionArtifacts}
        />
      </div>
    </div>
  )
}
