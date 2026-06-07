/**
 * TeamMemberChatView — the member's live work surface inside the team view.
 *
 * Renders the member's team-channel session (`app-chat:{appId}:team:{teamId}`)
 * exactly like the digital-human chat: persisted history + live streaming
 * (thoughts, tool calls, output) + an input box. This is the "open the desk and
 * watch them work" panel — the user sees the real process and can privately
 * message the member in the team context.
 *
 * Reuses the shared chat infrastructure (chat.store sessions keyed by
 * conversationId, MessageRow / StreamingSection / InputArea), so there is no
 * new chat engine — only a different conversationId + history source.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { Loader2, AlertCircle, X, Star } from 'lucide-react'
import { api } from '../../api'
import { useChatStore } from '../../stores/chat.store'
import { useAppsStore } from '../../stores/apps.store'
import { useSmartScroll } from '../../hooks/useSmartScroll'
import { MessageRow } from '../chat/MessageRow'
import { StreamingSection } from '../chat/StreamingSection'
import { useBrowserToolCalls } from '../chat/useBrowserToolCalls'
import { InterruptedBubble } from '../chat/InterruptedBubble'
import { CompactNotice } from '../chat/CompactNotice'
import { InputArea } from '../chat/InputArea'
import { EscalationPanel } from './EscalationPanel'
import { useRemoteSubscription } from '../../hooks/useRemoteSubscription'
import { useTranslation } from '../../i18n'
import type { Message, ImageAttachment } from '../../types'
import type { RosterMember, TeamMemberRuntimeStatus } from '../../../shared/apps/team-types'
import { buildTeamSessionKey } from '../../../shared/apps/im-keys'

interface TeamMemberChatViewProps {
  member: RosterMember
  teamId: string
  /**
   * The run (epoch) whose session is shown. Each run is an independent, persistent
   * session/history, so the epoch fully identifies which transcript to load. null
   * only when the team has never run (empty state).
   */
  epochId: string | null
  /** True when this epoch is the team's live/current run (enables private chat). */
  isCurrentEpoch: boolean
  onClose: () => void
}

type LoadState = 'loading' | 'loaded' | 'error' | 'empty'

function statusDot(status: TeamMemberRuntimeStatus): string {
  switch (status) {
    case 'working': return 'bg-emerald-500'
    case 'error': return 'bg-red-500'
    case 'waiting_user': return 'bg-amber-500'
    default: return 'bg-muted-foreground/40'
  }
}

export function TeamMemberChatView({ member, teamId, epochId, isCurrentEpoch, onClose }: TeamMemberChatViewProps) {
  const { t } = useTranslation()
  const appId = member.appId
  // The roster's spaceId can be null (the blackboard roster does not resolve it);
  // the installed app is the authoritative source, so look it up there. A wrong/
  // empty spaceId is what previously made history fail to load and sends fail.
  const appSpaceId = useAppsStore(s => s.apps.find(a => a.id === appId)?.spaceId)
  const spaceId = appSpaceId ?? member.spaceId ?? ''
  // A stable key even when epochId is null (no run yet) so hooks stay consistent;
  // loading is guarded on epochId below.
  const conversationId = buildTeamSessionKey(appId, teamId, epochId ?? 'none')

  useRemoteSubscription(conversationId)

  const [messages, setMessages] = useState<Message[]>([])
  const [loadState, setLoadState] = useState<LoadState>('loading')
  const scrollRef = useRef<HTMLDivElement>(null)

  const session = useChatStore(s => s.getSession(conversationId))
  const resetSession = useChatStore(s => s.resetSession)
  const answerQuestion = useChatStore(s => s.answerQuestion)
  const {
    isGenerating, streamingContent, isStreaming, thoughts, isThinking,
    pendingQuestion, error, errorType, compactInfo, textBlockVersion,
  } = session

  const { scrollToBottom, handleScroll } = useSmartScroll({
    containerRef: scrollRef,
    deps: [streamingContent, thoughts.length, isStreaming, isThinking, pendingQuestion, messages],
    behavior: 'auto',
  })

  const streamingBrowserToolCalls = useBrowserToolCalls(thoughts)

  const loadMessages = useCallback(async (silent = false) => {
    if (!epochId) { setLoadState('empty'); return }
    if (!silent) setLoadState('loading')
    try {
      const res = await api.teamChatMessages(appId, spaceId, teamId, epochId)
      if (res.success && res.data) {
        const msgs = (res.data as Message[]) ?? []
        setMessages(msgs)
        setLoadState(msgs.length > 0 ? 'loaded' : 'empty')
      } else {
        setLoadState('empty')
      }
    } catch (err) {
      console.error('[TeamMemberChatView] load error:', err)
      if (!silent) setLoadState('error')
    }
  }, [appId, spaceId, teamId, epochId])

  // Load history on member switch.
  useEffect(() => { void loadMessages() }, [loadMessages])

  // Reload from JSONL when a turn completes so the persisted transcript is current.
  const prevGen = useRef(isGenerating)
  useEffect(() => {
    if (prevGen.current && !isGenerating) void loadMessages(true)
    prevGen.current = isGenerating
  }, [isGenerating, loadMessages])

  const handleSend = useCallback(async (content: string, images?: ImageAttachment[], thinkingEnabled?: boolean) => {
    resetSession(conversationId)
    const userMsg: Message = {
      id: `user-${Date.now()}`,
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
    }
    setMessages(prev => [...prev, userMsg])
    setLoadState('loaded')

    // Carry team context so the member wakes in-team (Team Entry + halo-team tools).
    // Scoped to THIS run's epoch so the message lands in the right session/history.
    const teamContext = epochId
      ? { teamId, epochId, correlationId: `user-${Date.now()}`, fromAppId: null, wait: false }
      : undefined

    try {
      const apiImages = images && images.length > 0
        ? images.map(img => ({ type: img.type, media_type: img.mediaType, data: img.data }))
        : undefined
      const res = await api.appChatSend({ appId, spaceId, message: content, images: apiImages, thinkingEnabled, conversationId, teamContext })
      if (!res.success) {
        useChatStore.getState().setSessionError(conversationId, String(res.error || t('Failed to send message')))
      }
      requestAnimationFrame(() => scrollToBottom('auto'))
    } catch (err) {
      useChatStore.getState().setSessionError(conversationId, String((err as Error).message || t('Failed to send message')))
    }
  }, [appId, spaceId, teamId, conversationId, epochId, resetSession, scrollToBottom, t])

  const handleStop = useCallback(async () => {
    try {
      await api.appChatStop(appId)
      useChatStore.getState().resetSession(conversationId)
    } catch (err) {
      console.error('[TeamMemberChatView] stop error:', err)
    }
  }, [appId, conversationId])

  const handleAnswerQuestion = useCallback((answers: Record<string, string>) => {
    answerQuestion(conversationId, answers)
  }, [conversationId, answerQuestion])

  const hasStreaming = isGenerating && (streamingContent || thoughts.length > 0 || isThinking)

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <span className={`h-2.5 w-2.5 flex-shrink-0 rounded-full ${statusDot(member.status)}`} />
        <div className="flex min-w-0 items-center gap-1.5">
          {member.isLead && <Star className="h-3.5 w-3.5 flex-shrink-0 fill-current text-amber-500" />}
          <span className="truncate text-sm font-medium text-foreground">{member.memberName}</span>
          {member.role && <span className="truncate text-xs text-muted-foreground">· {member.role}</span>}
          {!isCurrentEpoch && epochId && (
            <span className="flex-shrink-0 rounded-full bg-secondary px-2 py-0.5 text-[10px] text-muted-foreground">{t('Past run')}</span>
          )}
        </div>
        <button
          onClick={onClose}
          className="ml-auto flex-shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          title={t('Close')}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Body */}
      {loadState === 'loading' ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          <span className="text-sm">{t('Loading chat...')}</span>
        </div>
      ) : (
        <div ref={scrollRef} className="flex-1 overflow-y-auto" onScroll={handleScroll}>
          <div className="mx-auto max-w-3xl px-4 py-5">
            {loadState === 'empty' && !hasStreaming && (
              <div className="flex flex-col items-center justify-center gap-1 py-16 text-center">
                <p className="text-sm text-muted-foreground">{t('No work yet in this team.')}</p>
                <p className="text-xs text-muted-foreground/60">{t('Run the team, or send a message to this member.')}</p>
              </div>
            )}

            {messages.map(message => (
              <MessageRow key={message.id} message={message} hideBrowserViewButton />
            ))}

            {hasStreaming && (
              <StreamingSection
                streamingContent={streamingContent}
                isStreaming={isStreaming}
                thoughts={thoughts}
                isThinking={isThinking}
                textBlockVersion={textBlockVersion}
                browserToolCalls={streamingBrowserToolCalls}
                showBrowserViewButton={false}
                pendingQuestion={pendingQuestion}
                onAnswerQuestion={handleAnswerQuestion}
              />
            )}

            {!isGenerating && error && errorType === 'interrupted' && (
              <div className="pb-4"><InterruptedBubble error={error} /></div>
            )}
            {!isGenerating && error && errorType !== 'interrupted' && (
              <div className="flex justify-start pb-4">
                <div className="w-[85%] rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3">
                  <div className="flex items-center gap-2 text-destructive">
                    <AlertCircle className="h-4 w-4" />
                    <span className="text-sm font-medium">{t('Something went wrong')}</span>
                  </div>
                  <p className="mt-2 text-sm text-destructive/80">{error}</p>
                </div>
              </div>
            )}
            {compactInfo && (
              <div className="pb-4"><CompactNotice trigger={compactInfo.trigger} preTokens={compactInfo.preTokens} /></div>
            )}
          </div>
        </div>
      )}

      {/* Escalation (拍板) — surfaced inline when this member awaits a decision */}
      {member.status === 'waiting_user' && (
        <div className="shrink-0 border-t border-amber-500/30 bg-amber-500/5 p-3">
          <EscalationPanel member={member} teamName="" />
        </div>
      )}

      {/* Input */}
      <div className="shrink-0 p-3">
        <InputArea
          onSend={handleSend}
          onStop={handleStop}
          isGenerating={isGenerating}
          placeholder={t('Message {{name}}…', { name: member.memberName })}
          isCompact
        />
      </div>
    </div>
  )
}
