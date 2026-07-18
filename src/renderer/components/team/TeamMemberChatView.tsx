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
import { MemberPresenceChip, OwnerLabel } from './MemberPresenceChip'
import { useRemoteSubscription } from '../../hooks/useRemoteSubscription'
import { useMemberPresence } from '../../stores/team.store'
import { useTranslation } from '../../i18n'
import type { Message, ImageAttachment } from '../../types'
import type { RosterMember, TeamMemberRuntimeStatus } from '../../../shared/apps/team-types'
import { shouldShowRelayedTranscript } from '../../../shared/apps/team-types'
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
  // True when the transcript shown is a cached copy served because the owner is
  // offline — it may be missing their latest messages, so we say so honestly.
  const [isStale, setIsStale] = useState(false)
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

  // Highest transcript seq currently held. A silent refresh (post-turn) pulls
  // only the tail above it (sinceSeq) and appends, instead of re-downloading the
  // whole transcript — the fix for a remote member's history reloading slowly on
  // every turn. Reset on member/epoch switch so a new member does a full load.
  const seqCursorRef = useRef(0)
  useEffect(() => { seqCursorRef.current = 0; setIsStale(false) }, [appId, epochId])

  const loadMessages = useCallback(async (silent = false) => {
    // No local "no epoch → skip" short-circuit: a remote member with no run yet
    // still has a per-member conversation epoch resolved SERVER-side (1:1 chat needs
    // no run — parity with local chat). The backend returns an empty list when there
    // is genuinely nothing to show.
    if (!silent) setLoadState('loading')
    try {
      const cursor = seqCursorRef.current
      const incremental = silent && cursor > 0
      // Re-fetch from one BELOW the cursor: the transcript's last message is
      // provisional while a turn runs (the reader flushes the in-flight turn at
      // end-of-file), so the row under the cursor may have been completed since
      // it was first seen — always refresh it rather than trusting the snapshot.
      const res = await api.teamChatMessages(
        appId, spaceId, teamId, epochId ?? '',
        incremental && cursor > 1 ? cursor - 1 : undefined
      )
      if (res.success && res.data) {
        // Honest offline signal: a stale response means these are cached messages
        // served because the owner is offline; a fresh one clears the notice.
        setIsStale(res.stale === true)
        const batch = (res.data as Message[]) ?? []
        const seqOf = (m: Message): number | undefined => (m as { seq?: number }).seq
        const maxSeq = batch.reduce((hi, m) => Math.max(hi, seqOf(m) ?? 0), cursor)
        if (incremental) {
          // Merge by seq: a known row is REPLACED (its provisional snapshot may
          // have been completed), a new one appended. An empty delta leaves the
          // screen exactly as it is.
          if (batch.length > 0) {
            setMessages((prev) => {
              const bySeq = new Map<number, Message>()
              for (const m of batch) {
                const s = seqOf(m)
                if (s !== undefined) bySeq.set(s, m)
              }
              const appendSeqs = new Set(bySeq.keys())
              const replaced = prev.map((m) => {
                const s = seqOf(m)
                if (s === undefined || !bySeq.has(s)) return m
                appendSeqs.delete(s)
                return bySeq.get(s)!
              })
              const fresh = batch.filter((m) => { const s = seqOf(m); return s !== undefined && appendSeqs.has(s) })
              // A locally-echoed send (optimistic, no seq) reappears in this
              // persisted batch with a seq — drop the echo it supersedes (matched
              // by role+content) so the user's own message is not rendered twice.
              // Echoes with no persisted counterpart yet are kept as-is.
              const supersededKeys = new Set(fresh.map((m) => `${m.role}\u0000${m.content}`))
              const base = replaced.filter(
                (m) => seqOf(m) !== undefined || !supersededKeys.has(`${m.role}\u0000${m.content}`)
              )
              return [...base, ...fresh]
            })
          }
          seqCursorRef.current = maxSeq
          setLoadState('loaded')
        } else {
          setMessages(batch)
          seqCursorRef.current = maxSeq
          setLoadState(batch.length > 0 ? 'loaded' : 'empty')
        }
      } else {
        // Only surface the error state on an explicit load — a silent
        // post-turn reload should leave whatever is already on screen.
        if (!silent) setLoadState('error')
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

  // Replicated transcript rows landed locally (a remote member's turn, or late
  // replication after a network outage): silently reload so the panel follows
  // without depending on live-stream continuity.
  useEffect(() => {
    return api.onTeamMemberHistory((data) => {
      const d = data as { teamId?: string; appId?: string }
      if (d?.teamId === teamId && d?.appId === appId) void loadMessages(true)
    })
  }, [teamId, appId, loadMessages])

  const presence = useMemberPresence(teamId, appId)
  const showOwner = presence.isRemote

  // Mark an optimistically-rendered user message as failed so a non-delivery is
  // never left looking like a successful send (the bubble carries the truth, not
  // just a transient banner).
  const markSendFailed = useCallback((messageId: string, reason: string) => {
    setMessages(prev => prev.map(m => (m.id === messageId ? { ...m, error: reason } : m)))
  }, [])

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

      // Local app-chat can't resolve a remote member's app ("App not found") —
      // route through the owner's team-wake path instead, which relays the result back.
      const res = presence.isRemote
        ? await api.teamSendToMember({ teamId, appId, epochId: epochId ?? '', message: content, images: apiImages, thinkingEnabled })
        : await api.appChatSend({ appId, spaceId, message: content, images: apiImages, thinkingEnabled, conversationId, teamContext })

      // The envelope's `success` only means the IPC/HTTP call itself succeeded. For
      // a remote member the ACTUAL delivery verdict is the inner sendToMember result
      // (`data.ok` + `data.reason`); a wake that never reached the owner returns
      // `success:true` with `data.ok:false`. Unwrap it so a non-delivery surfaces as
      // a failed bubble instead of being masked as a normally-sent one.
      const remoteResult =
        presence.isRemote && res.success
          ? (res.data as { ok?: boolean; reason?: string } | undefined)
          : undefined
      const failed = presence.isRemote ? !res.success || remoteResult?.ok === false : !res.success
      if (failed) {
        const owner = presence.ownerName || t('this teammate')
        // Keep remote failures people-centric AND HONEST — map each reason to what
        // actually happened, never collapse everything to "offline". Only a real
        // non-delivery (UNDELIVERED) says the teammate is unreachable.
        const remoteReason = (): string => {
          switch (remoteResult?.reason) {
            case 'TIMEOUT':
              return t('No reply from {{owner}} in time — they may be busy. Try again shortly.', { owner })
            case 'UNDELIVERED':
              return t('Couldn\u2019t reach {{owner}} — your message was not delivered. Try again when they\u2019re back online.', { owner })
            case 'NO_LEAD':
              return t('This office needs a lead before teammates can chat. Set one, then try again.')
            case 'MEMBER_NOT_FOUND':
              return t('{{owner}} is no longer in this office.', { owner })
            default:
              return t('Couldn\u2019t send your message just now. Please try again.')
          }
        }
        const reason = presence.isRemote ? remoteReason() : String(res.error || t('Failed to send message'))
        useChatStore.getState().setSessionError(conversationId, reason)
        markSendFailed(userMsg.id, reason)
      }
      requestAnimationFrame(() => scrollToBottom('auto'))
    } catch (err) {
      const reason = presence.isRemote
        ? t('Couldn\u2019t reach {{owner}} just now — your message was not delivered. Try again when they\u2019re back online.', { owner: presence.ownerName || t('this teammate') })
        : String((err as Error).message || t('Failed to send message'))
      useChatStore.getState().setSessionError(conversationId, reason)
      markSendFailed(userMsg.id, reason)
    }
  }, [appId, spaceId, teamId, conversationId, epochId, presence.isRemote, presence.ownerName, resetSession, scrollToBottom, markSendFailed, t])

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

  // A remote member's finished transcript has no local persistence to reload — keep
  // the relayed stream on screen until owner-served history backfills `messages`.
  const showRelayedTranscript = shouldShowRelayedTranscript({
    isRemote: presence.isRemote,
    hasStreaming: !!hasStreaming,
    messageCount: messages.length,
    streamingContentLength: streamingContent.length,
    thoughtCount: thoughts.length,
  })

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <span className={`h-2.5 w-2.5 flex-shrink-0 rounded-full ${statusDot(member.status)}`} />
        <div className="flex min-w-0 items-center gap-1.5">
          {member.isLead && <Star className="h-3.5 w-3.5 flex-shrink-0 fill-current text-amber-500" />}
          <span className="truncate text-sm font-medium text-foreground">{member.memberName}</span>
          {member.role && <span className="truncate text-xs text-muted-foreground">· {member.role}</span>}
          {showOwner && (
            <span className="flex min-w-0 items-center gap-1.5">
              <OwnerLabel ownerName={presence.ownerName} />
              <MemberPresenceChip
                reachability={presence.reachability}
                ownerName={presence.ownerName}
                showLabel={presence.reachability !== 'online'}
              />
            </span>
          )}
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
            {loadState === 'empty' && !hasStreaming && !showRelayedTranscript && (
              <div className="flex flex-col items-center justify-center gap-1 py-16 text-center">
                <p className="text-sm text-muted-foreground">{t('No work yet in this team.')}</p>
                <p className="text-xs text-muted-foreground/60">{t('Run the team, or send a message to this member.')}</p>
              </div>
            )}

            {loadState === 'error' && !hasStreaming && !showRelayedTranscript && (
              <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
                <p className="text-sm text-muted-foreground">{t('Couldn\u2019t load the chat history right now.')}</p>
                <button
                  onClick={() => void loadMessages()}
                  className="rounded-md px-3 py-1 text-xs text-muted-foreground/80 hover:bg-muted/50 hover:text-foreground transition-colors"
                >
                  {t('Try again')}
                </button>
              </div>
            )}

            {isStale && messages.length > 0 && (
              <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                <p className="text-xs text-amber-600 dark:text-amber-500">
                  {t('Offline — showing saved messages, which may not be up to date.')}
                </p>
              </div>
            )}

            {messages.map(message => (
              <MessageRow key={message.id} message={message} hideBrowserViewButton />
            ))}

            {(hasStreaming || showRelayedTranscript) && (
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

            {showRelayedTranscript && (
              <p className="pb-4 pt-1 text-center text-xs text-muted-foreground/60">
                {t('This is what they did just now.')}
              </p>
            )}

            {!isGenerating && error && errorType === 'interrupted' && (
              <div className="pb-4"><InterruptedBubble error={error} /></div>
            )}
            {/* Remote unreachability isn't an error — use calm amber, not alert red. */}
            {!isGenerating && error && errorType !== 'interrupted' && presence.isRemote && (
              <div className="flex justify-start pb-4">
                <div className="w-[85%] rounded-2xl border border-amber-500/30 bg-amber-500/5 px-4 py-3">
                  <p className="text-sm text-foreground">{error}</p>
                </div>
              </div>
            )}
            {!isGenerating && error && errorType !== 'interrupted' && !presence.isRemote && (
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

      {/* While the owner is offline, a send could only fail after a long
          timeout — show a plain notice instead of inviting one. An 'away'
          owner keeps the input, with a hint. */}
      {presence.reachability === 'offline' ? (
        <div className="shrink-0 border-t border-border p-3">
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3">
            <p className="text-sm font-medium text-foreground">
              {t('{{name}} is offline right now.', { name: member.memberName })}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('Messages can’t reach them while their machine is disconnected. Wait for {{owner}} to come back online, then continue here.', { owner: presence.ownerName || t('this teammate') })}
            </p>
          </div>
        </div>
      ) : (
        <div className="shrink-0 p-3">
          {presence.reachability === 'away' && (
            <p className="mb-2 px-1 text-xs text-amber-600 dark:text-amber-500">
              {t('{{owner}} seems to have stepped away — replies may take a moment.', { owner: presence.ownerName || t('This teammate') })}
            </p>
          )}
          <InputArea
            onSend={handleSend}
            onStop={handleStop}
            isGenerating={isGenerating}
            placeholder={t('Message {{name}}…', { name: member.memberName })}
            isCompact
          />
        </div>
      )}
    </div>
  )
}
