import { invalidateTeamSessionHistory, loadTeamSessionHistory, matchesTeamHistory, peekTeamSessionHistory, retainTeamSessionHistory } from './session-history'
/**
 * TeamSessionChat — the ONE team session surface, shared by the member panel and
 * the Conversation tab (spec §6.2: "must share one set of session components,
 * never a second UI"). It renders a team-channel session
 * (`app-chat:{appId}:team:{teamId}:{epochId}`) exactly like the digital-human
 * chat: persisted history + live streaming (thoughts, tool calls, output) + an
 * input box, with the send routed locally (owner) or over the office link
 * (remote owner). Callers supply only the framing (header, chips, banners); the
 * chat engine lives here once.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { Loader2, AlertCircle, LockKeyhole, MessageSquareMore } from 'lucide-react'
import { api } from '../../api'
import { usePeopleViewStore } from '../../stores/people-view.store'
import { useChatStore } from '../../stores/chat.store'
import { useSmartScroll } from '../../hooks/useSmartScroll'
import { MessageRow } from '../chat/MessageRow'
import { CompactNotice } from '../chat/CompactNotice'
import { StreamingSection } from '../chat/StreamingSection'
import { useBrowserToolCalls } from '../chat/useBrowserToolCalls'
import { InterruptedBubble } from '../chat/InterruptedBubble'
import { InputArea } from '../chat/InputArea'
import { useRemoteSubscription } from '../../hooks/useRemoteSubscription'
import { useTranslation } from '../../i18n'
import type { Message, Thought, ImageAttachment } from '../../types'
import { shouldShowRelayedTranscript } from '../../../shared/apps/team-types'
import { buildTeamSessionKey } from '../../../shared/apps/im-keys'

export interface TeamSessionChatProps {
  /** The member (or lead) whose team-channel session is shown. */
  appId: string
  spaceId: string
  teamId: string
  /** The epoch (run or conversation) identifying which transcript to load. */
  epochId: string | null
  /** True when the owner runs on another machine (routes send over the office link). */
  isRemote: boolean
  /** Owner's name for honest remote-failure copy. */
  ownerName?: string | null
  /** Owner reachability: 'offline' replaces the input with a calm notice. */
  reachability?: 'online' | 'away' | 'offline'
  /**
   * Read-only surface (e.g. an IM chat answered elsewhere): no input. Saying WHY
   * it is read-only is the caller's job — that reason lives in the caller's
   * framing, not in the chat engine.
   */
  readonly?: boolean
  /** Persistent explanation shown where the composer would normally be. */
  readonlyMessage?: string
  placeholder?: string
  emptyTitle?: string
  emptyContent?: React.ReactNode
  emptyHint?: string
  /** Rendered above the messages (offline banner, IM notice, etc). */
  topSlot?: React.ReactNode
  /** Rendered directly above the input (e.g. an "away" hint or active-door card). */
  aboveInput?: React.ReactNode
  /**
   * Draft mode: when `epochId` is null, this lazily creates the conversation on
   * the FIRST send and returns its epoch id — so the user lands on a ready input
   * (parity with the space chat) and no empty epoch is created until they speak.
   * Returns null on failure (the send is then surfaced as an error).
   */
  ensureEpochId?: (firstMessage: string) => Promise<string | null>
  toolbarSlot?: React.ReactNode
  renderAfterStreaming?: (thoughts: Thought[]) => React.ReactNode
  renderMessages?: (messages: Message[], liveThoughts: Thought[]) => React.ReactNode
  isBackgroundTurn?: (messages: Message[]) => boolean
  draftKey?: string
}

type LoadState = 'loading' | 'loaded' | 'error' | 'empty'

export function TeamSessionChat({
  appId, spaceId, teamId, epochId, isRemote, ownerName, reachability = 'online',
  readonly = false, readonlyMessage, placeholder, emptyTitle, emptyHint, emptyContent, topSlot, aboveInput, ensureEpochId, toolbarSlot, renderMessages, renderAfterStreaming, isBackgroundTurn, draftKey,
}: TeamSessionChatProps) {
  const { t } = useTranslation()
  const conversationId = buildTeamSessionKey(appId, teamId, epochId ?? 'none')

  useRemoteSubscription(conversationId)

  // Seeded from the transcript this session last showed (the member panel is
  // remounted per member, so a switch would otherwise always start from blank).
  const [messages, setMessages] = useState<Message[]>(
    () => peekTeamSessionHistory(appId, spaceId, teamId, epochId ?? '') ?? []
  )
  const [loadState, setLoadState] = useState<LoadState>(
    () => (peekTeamSessionHistory(appId, spaceId, teamId, epochId ?? '')?.length ? 'loaded' : 'loading')
  )
  const [isStale, setIsStale] = useState(false)
  /**
   * A send that arrived but started no turn, so no reply is coming on this
   * screen. Deliberately not routed through `setSessionError`: that is the error
   * channel, and `errorType` / `InterruptedBubble` / the failure branches below
   * all key off it — a success told through it reads as a failure everywhere
   * that asks. Cleared as soon as anything actually happens here.
   */
  const [deliveredNoReply, setDeliveredNoReply] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const restoredScroll = useRef(false)
  const savedScroll = useRef(usePeopleViewStore.getState().scrolls[`team-chat:${conversationId}`])

  const session = useChatStore(s => s.getSession(conversationId))
  const resetSession = useChatStore(s => s.resetSession)
  const answerQuestion = useChatStore(s => s.answerQuestion)
  const {
    isGenerating, streamingContent, isStreaming, thoughts, isThinking, compactInfo,
    pendingQuestion, error, errorType, textBlockVersion,
  } = session

  const backgroundTurn = isBackgroundTurn?.(messages) ?? false
  const { scrollToBottom, handleScroll } = useSmartScroll({
    containerRef: scrollRef,
    deps: [backgroundTurn ? '' : streamingContent, backgroundTurn ? 0 : thoughts.length, !backgroundTurn && isStreaming, !backgroundTurn && isThinking, pendingQuestion, backgroundTurn ? null : messages],
    behavior: 'auto',
  })

  const streamingBrowserToolCalls = useBrowserToolCalls(thoughts)

  useEffect(() => {
    if (restoredScroll.current || (loadState !== 'loaded' && loadState !== 'empty') || !scrollRef.current) return
    restoredScroll.current = true
    if (savedScroll.current !== undefined) {
      scrollRef.current.scrollTop = savedScroll.current
      handleScroll()
    }
  }, [loadState, messages, handleScroll])

  const inputIdentity = useRef({ appId, epochId, key: draftKey ?? conversationId })
  if (inputIdentity.current.appId !== appId || inputIdentity.current.epochId !== epochId) {
    const committedDraft = inputIdentity.current.appId === appId && inputIdentity.current.epochId === null && epochId !== null
    inputIdentity.current = { appId, epochId, key: committedDraft ? inputIdentity.current.key : draftKey ?? conversationId }
  }

  const historyGeneration = useRef(0)
  const seqCursorRef = useRef(0)
  // A draft conversation (epochId null) becomes real on first send. That one
  // transition must NOT show a loading spinner or wipe the just-sent optimistic
  // message + live stream — the epoch has no persisted rows yet.
  const prevEpochRef = useRef(epochId)
  const draftCommitRef = useRef(false)
  // True while a turn started from THIS surface is in flight: its user bubble is
  // already on screen optimistically, so it must not trigger the pull below.
  const ownTurnRef = useRef(false)
  useEffect(() => {
    draftCommitRef.current = prevEpochRef.current === null && epochId !== null
    prevEpochRef.current = epochId
    seqCursorRef.current = 0
    ownTurnRef.current = false
    setIsStale(false)
    setDeliveredNoReply(null)
  }, [appId, epochId])

  useEffect(() => retainTeamSessionHistory(appId, spaceId, teamId, epochId ?? ''), [appId, spaceId, teamId, epochId])

  /** What this session last showed, still held by the shared source. */
  const cachedHistory = useCallback(
    () => peekTeamSessionHistory(appId, spaceId, teamId, epochId ?? '') ?? [],
    [appId, spaceId, teamId, epochId]
  )

  /**
   * A refresh that failed. With nothing on screen this is the error state and its
   * retry; once a transcript is already painted, replacing it with an error page
   * would throw away good messages — say they may be out of date instead.
   */
  const failedRefresh = useCallback(() => {
    if (cachedHistory().length > 0) {
      setLoadState('loaded')
      setIsStale(true)
    } else {
      setLoadState('error')
    }
  }, [cachedHistory])

  const loadMessages = useCallback(async (silent = false) => {
    if (silent) invalidateTeamSessionHistory(appId, spaceId, teamId, epochId ?? '')
    const generation = historyGeneration.current
    const draftCommit = draftCommitRef.current
    if (!silent && !draftCommit) {
      // Paint what this session last showed and refresh underneath it. A blank
      // spinner here costs the full read every time — and mid-run, when a remote
      // member's copy is coldest, that read is the slowest it ever gets.
      const cached = cachedHistory()
      if (cached.length > 0) {
        setMessages(cached)
        setLoadState('loaded')
      } else {
        setLoadState('loading')
      }
    }
    try {
      const cursor = seqCursorRef.current
      const incremental = silent && cursor > 0
      const res = await loadTeamSessionHistory(
        appId, spaceId, teamId, epochId ?? '',
        incremental && cursor > 1 ? cursor - 1 : undefined
      )
      if (generation !== historyGeneration.current) return
      if (res.success && res.data) {
        setIsStale(res.stale === true)
        const batch = (res.data as Message[]) ?? []
        const seqOf = (m: Message): number | undefined => (m as { seq?: number }).seq
        const maxSeq = batch.reduce((hi, m) => Math.max(hi, seqOf(m) ?? 0), cursor)
        if (incremental) {
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
              const supersededKeys = new Set(fresh.map((m) => `${m.role}\u0000${m.content}`))
              const base = replaced.filter(
                (m) => seqOf(m) !== undefined || !supersededKeys.has(`${m.role}\u0000${m.content}`)
              )
              return [...base, ...fresh]
            })
          }
          seqCursorRef.current = maxSeq
          setLoadState('loaded')
        } else if (draftCommit && batch.length === 0) {
          // Freshly-created draft epoch not yet persisted: keep the optimistic
          // first message + live stream; a later reload (turn-complete / history
          // event) will adopt the real transcript.
          draftCommitRef.current = false
          setLoadState('loaded')
        } else {
          setMessages(batch)
          seqCursorRef.current = maxSeq
          draftCommitRef.current = false
          setLoadState(batch.length > 0 ? 'loaded' : 'empty')
        }
      } else {
        console.warn('[TeamSessionChat] History rejected', { teamId, appId, epochId, error: res.error })
        if (!silent) failedRefresh()
      }
    } catch (err) {
      console.error('[TeamSessionChat] load error:', err)
      if (generation !== historyGeneration.current) return
      if (!silent) failedRefresh()
    }
  }, [appId, spaceId, teamId, epochId, cachedHistory, failedRefresh])

  useEffect(() => {
    historyGeneration.current++
    void loadMessages()
    return () => { historyGeneration.current++ }
  }, [loadMessages])

  const prevGen = useRef(isGenerating)
  useEffect(() => {
    const started = !prevGen.current && isGenerating
    const ended = prevGen.current && !isGenerating
    prevGen.current = isGenerating
    // A turn set off elsewhere — an answered decision, a teammate's message —
    // persisted its trigger before streaming. Pull it in now, or the reply shows
    // up without the words it answers until the whole turn is over.
    if (started && !ownTurnRef.current) void loadMessages(true)
    if (ended) {
      ownTurnRef.current = false
      void loadMessages(true)
    }
  }, [isGenerating, loadMessages])

  useEffect(() => {
    return api.onTeamMemberHistory((data) => {
      const d = data as { teamId?: string; epochId?: string; appId?: string }
      if (epochId && matchesTeamHistory(d, teamId, epochId, appId)) void loadMessages(true)
    })
  }, [teamId, appId, loadMessages])

  const markSendFailed = useCallback((messageId: string, reason: string) => {
    // The turn never started: release the latch, or the next turn started
    // elsewhere is mistaken for ours and its trigger goes unread.
    ownTurnRef.current = false
    setMessages(prev => prev.map(m => (m.id === messageId ? { ...m, error: reason } : m)))
  }, [])

  const handleSend = useCallback(async (content: string, images?: ImageAttachment[], thinkingEnabled?: boolean) => {
    // Draft mode: create the conversation on the first send, then use its epoch
    // for the whole turn (session key + teamContext). No pre-click gate.
    let eid = epochId
    if (!eid && ensureEpochId) {
      eid = await ensureEpochId(content)
      if (!eid) {
        useChatStore.getState().setSessionError(conversationId, t('Couldn\u2019t start the conversation. Please try again.'))
        return false
      }
    }
    if (!eid) {
      console.warn('[TeamSessionChat] Send rejected: missing task', { teamId, appId })
      return false
    }
    const convId = buildTeamSessionKey(appId, teamId, eid)

    resetSession(convId)
    ownTurnRef.current = true
    // A new send answers the previous one's notice, whatever it said.
    setDeliveredNoReply(null)
    const userMsg: Message = {
      id: `user-${Date.now()}`,
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
      ...(images && images.length > 0 ? { images } : {}),
    }
    setMessages(prev => [...prev, userMsg])
    setLoadState('loaded')

    const teamContext = { teamId, epochId: eid, correlationId: `user-${Date.now()}`, fromAppId: null, wait: false }

    try {
      const res = isRemote
        ? await api.teamSendToMember({ teamId, appId, epochId: eid, message: content, images, thinkingEnabled })
        : await api.appChatSend({ appId, spaceId, message: content, images, thinkingEnabled, conversationId: convId, teamContext })

      const remoteResult = isRemote && res.success
        ? (res.data as { ok?: boolean; reason?: string; delivery?: 'queued' | 'mid_turn' } | undefined)
        : undefined
      // Accepted, but no turn starts from this surface now — the message is
      // either waiting behind the teammate's current turn or was folded into
      // it. Two consequences, and both are needed.
      //
      // The latch must come off, otherwise the turn this message eventually
      // influences is mistaken for ours and the words it answers are never
      // pulled into view.
      //
      // And it must be SAID. This screen otherwise shows a sent bubble and then
      // nothing at all, for as long as the teammate stays busy — indistinguishable
      // from a message that vanished. The two cases are told apart on purpose:
      // "queued" means they have not read it yet, "mid_turn" means they already
      // have and any answer arrives as its own message, so telling someone to
      // wait here would be wrong.
      const owner = ownerName || t('this teammate')
      if (remoteResult?.delivery === 'queued') {
        ownTurnRef.current = false
        // "Queued", not "Delivered": on the bus this means the mailbox took it
        // and the target's session has not. Saying delivered would be the one
        // thing this notice exists to prevent. And the turn it waits behind runs
        // in THIS conversation — same app, same team, same epoch, so the same
        // session key — which is why it is named as the turn above rather than
        // as other work somewhere else.
        setDeliveredNoReply(
          t('Queued. {{owner}} is still finishing the turn above — yours is next in line.', { owner })
        )
      } else if (remoteResult?.delivery === 'mid_turn') {
        ownTurnRef.current = false
        setDeliveredNoReply(
          t('Delivered. {{owner}} picked it up inside the work in progress; a reply will arrive as a separate message.', { owner })
        )
      }
      const failed = isRemote ? !res.success || remoteResult?.ok === false : !res.success
      if (failed) {
        const remoteReason = (): string => {
          switch (remoteResult?.reason) {
            case 'TIMEOUT': return t('No reply from {{owner}} in time — they may be busy. Try again shortly.', { owner })
            case 'UNDELIVERED': return t('Couldn\u2019t reach {{owner}} — your message was not delivered. Try again when they\u2019re back online.', { owner })
            case 'MEMBER_NOT_FOUND': return t('{{owner}} is no longer in this team.', { owner })
            default: return t('Couldn\u2019t send your message just now. Please try again.')
          }
        }
        const reason = isRemote ? remoteReason() : String(res.error || t('Failed to send message'))
        useChatStore.getState().setSessionError(convId, reason)
        markSendFailed(userMsg.id, reason)
        return false
      }
      requestAnimationFrame(() => scrollToBottom('auto'))
      return true
    } catch (err) {
      const reason = isRemote
        ? t('Couldn\u2019t reach {{owner}} just now — your message was not delivered. Try again when they\u2019re back online.', { owner: ownerName || t('this teammate') })
        : String((err as Error).message || t('Failed to send message'))
      useChatStore.getState().setSessionError(convId, reason)
      markSendFailed(userMsg.id, reason)
      return false
    }
  }, [appId, spaceId, teamId, conversationId, epochId, ensureEpochId, isRemote, ownerName, resetSession, scrollToBottom, markSendFailed, t])

  const handleStop = useCallback(async () => {
    // Settle the UI first and unconditionally. The abort may be swallowed
    // downstream (a killed subprocess emits no completion) or answered only
    // after the drain timeout, and a stop button that stays spinning reads as a
    // dead button. `markSessionStopped`, not `resetSession`: the latter wipes the
    // messages and thoughts already on screen, which is not what stopping means.
    useChatStore.getState().markSessionStopped(conversationId)
    try {
      // A remote member's turn runs in ITS owner's process; the local app-chat
      // abort would find no session here and report success while the member
      // kept working. Same split as the send path above.
      if (isRemote) {
        await api.teamStopMember({ teamId, appId, ...(epochId ? { epochId } : {}) })
      } else {
        await api.appChatStop(appId, conversationId)
      }
    } catch (err) {
      console.error('[TeamSessionChat] stop error:', err)
    }
  }, [appId, teamId, epochId, conversationId, isRemote])

  const handleAnswerQuestion = useCallback((answers: Record<string, string>) => {
    answerQuestion(conversationId, answers)
  }, [conversationId, answerQuestion])

  const hasStreaming = isGenerating && (streamingContent || thoughts.length > 0 || isThinking)
  const showRelayedTranscript = shouldShowRelayedTranscript({
    isRemote,
    hasStreaming: !!hasStreaming,
    messageCount: messages.length,
    streamingContentLength: streamingContent.length,
    thoughtCount: thoughts.length,
  })

  const readonlyQuestion = readonly && pendingQuestion && pendingQuestion.status !== 'answered' ? <section className="mt-3 overflow-hidden rounded-xl border border-halo-warning/30 bg-halo-warning/5">
    <header className="flex items-center gap-2 border-b border-halo-warning/20 px-4 py-2.5 text-xs text-halo-warning">
      <MessageSquareMore size={15} />
      <span className="font-medium">{pendingQuestion.status === 'cancelled' ? t('Decision request closed') : ownerName ? t('Waiting for {{owner}}’s decision', { owner: ownerName }) : t('Waiting for the owner’s decision')}</span>
      <span className="ml-auto text-[11px] text-muted-foreground">{t('Read only')}</span>
    </header>
    <div className="space-y-4 px-4 py-3">{pendingQuestion.questions.map((question, index) => <div key={`${pendingQuestion.id}:${index}`} className="space-y-2">
      <span className="inline-block rounded-md bg-halo-warning/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-halo-warning">{question.header}</span>
      <p className="text-sm font-medium text-foreground">{question.question}</p>
      {question.options.length > 0 && <ul className="space-y-1.5">{question.options.map(option => <li key={option.label} className="rounded-lg border border-border bg-background/70 px-3 py-2">
        <p className="text-sm text-foreground/90">{option.label}</p>
        {option.description && <p className="mt-0.5 text-xs text-muted-foreground">{option.description}</p>}
      </li>)}</ul>}
    </div>)}</div>
  </section> : null

  const streamingSection = <StreamingSection
    streamingContent={streamingContent}
    isStreaming={isStreaming}
    thoughts={thoughts}
    isThinking={isThinking}
    textBlockVersion={textBlockVersion}
    browserToolCalls={streamingBrowserToolCalls}
    showBrowserViewButton={false}
    pendingQuestion={readonly ? undefined : pendingQuestion}
    onAnswerQuestion={readonly ? undefined : handleAnswerQuestion}
  />

  return (
    <>
      {loadState === 'loading' && topSlot && <div className="shrink-0 overflow-y-auto px-4 py-3">{topSlot}</div>}
      {loadState === 'loading' ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          <span className="text-sm">{t('Loading chat...')}</span>
        </div>
      ) : (
        <div ref={scrollRef} className="flex-1 overflow-y-auto" onScroll={event => { handleScroll(); if (restoredScroll.current) usePeopleViewStore.getState().saveScroll(`team-chat:${conversationId}`, event.currentTarget.scrollTop) }}>
          <div className="mx-auto max-w-3xl px-4 py-5">
            {topSlot}

            {loadState === 'empty' && !epochId && !hasStreaming && !showRelayedTranscript && (
              <div className="py-10 sm:py-16">
                {emptyContent ?? <div className="flex flex-col items-center justify-center gap-1 text-center">
                <p className="text-sm text-muted-foreground">{emptyTitle ?? t('No work yet in this team.')}</p>
                {emptyHint && <p className="text-xs text-muted-foreground/60">{emptyHint}</p>}
                </div>}
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
              <div className="mb-3 rounded-lg border border-halo-warning/30 bg-halo-warning/5 px-3 py-2">
                <p className="text-xs text-halo-warning">
                  {t('Offline — showing saved messages, which may not be up to date.')}
                </p>
              </div>
            )}

            {(loadState !== 'error' || messages.length > 0) && (renderMessages ? renderMessages(messages, hasStreaming ? thoughts : []) : messages.map(message => (
              <MessageRow key={message.id} message={message} hideBrowserViewButton />
            )))}

            {(hasStreaming || showRelayedTranscript || pendingQuestion) && <div className="mt-4">{readonlyQuestion ?? (isBackgroundTurn?.(messages)
              ? pendingQuestion && <StreamingSection streamingContent="" isStreaming={false} thoughts={[]} isThinking={false} textBlockVersion={0} showBrowserViewButton={false} pendingQuestion={pendingQuestion} onAnswerQuestion={handleAnswerQuestion} />
              : streamingSection)}</div>}
            {hasStreaming && renderAfterStreaming?.(thoughts)}

            {showRelayedTranscript && !isBackgroundTurn?.(messages) && (
              <p className="pb-4 pt-1 text-center text-xs text-muted-foreground/60">
                {t('This is what they did just now.')}
              </p>
            )}

            {/*
              Only while this view is otherwise quiet. A remote member's turn IS
              relayed into this store (`agent-events` preserves it as the only
              local record), so the turn this message waits behind is usually on
              screen and streaming — and a notice explaining the wait, printed
              beside the thing being waited for, is noise.

              The cost is real and worth stating: for `queued` the quiet window
              can be brief — it opens when that turn ends and closes when this
              message gets its own turn — so the notice may barely appear. The
              alternative, showing it regardless, needs a rule for taking it down
              again or it outlives what it describes, and a line that says
              "yours is next in line" long after the answer arrived is worse than
              one that flashed. Unverified in practice: this path needs a remote
              member, so it has never been watched live.
            */}
            {deliveredNoReply && !isGenerating && !error && (
              <div className="flex justify-start pb-4">
                <div className="w-[85%] rounded-2xl border border-halo-warning/30 bg-halo-warning/5 px-4 py-3">
                  <p className="text-sm text-foreground">{deliveredNoReply}</p>
                </div>
              </div>
            )}

            {!backgroundTurn && compactInfo && <CompactNotice trigger={compactInfo.trigger} preTokens={compactInfo.preTokens} />}
            {!isGenerating && error && errorType === 'interrupted' && (
              <div className="pb-4"><InterruptedBubble error={error} /></div>
            )}
            {!isGenerating && error && errorType !== 'interrupted' && isRemote && (
              <div className="flex justify-start pb-4">
                <div className="w-[85%] rounded-2xl border border-halo-warning/30 bg-halo-warning/5 px-4 py-3">
                  <p className="text-sm text-foreground">{error}</p>
                </div>
              </div>
            )}
            {!isGenerating && error && errorType !== 'interrupted' && !isRemote && (
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
          </div>
        </div>
      )}

      {/* Input region — a read-only surface keeps its permission boundary visible. */}
      {readonly ? <div className="shrink-0 border-t border-border p-3">
        <div role="status" className="flex min-h-11 items-center gap-2 rounded-xl bg-secondary/60 px-3 py-2 text-xs text-muted-foreground">
          <LockKeyhole size={14} className="shrink-0" />
          <span className="min-w-0 flex-1">{readonlyMessage ?? t('This conversation is read-only.')}</span>
          {/* Read-only means this person may not WRITE here, not that they may
              not interrupt. A teammate's turn runs on its owner's machine and
              this is the only screen that shows it, so without this the work
              visibly running in front of someone cannot be stopped by anyone. */}
          {isGenerating && (
            <button
              onClick={handleStop}
              className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg bg-destructive/10 px-2 text-destructive transition-colors hover:bg-destructive/20 active:bg-destructive/30"
              title={t('Stop generation')}
            >
              <span className="h-2.5 w-2.5 rounded-sm border-2 border-current" />
              <span className="hidden sm:inline">{t('Stop')}</span>
            </button>
          )}
        </div>
      </div> : reachability === 'offline' ? (
        <div className="shrink-0 border-t border-border p-3">
          <div className="rounded-xl border border-halo-warning/30 bg-halo-warning/5 px-4 py-3">
            <p className="text-sm font-medium text-foreground">
              {t('{{name}} is offline right now.', { name: ownerName || t('This teammate') })}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('Messages can’t reach them while their machine is disconnected. Wait for them to come back online, then continue here.')}
            </p>
          </div>
        </div>
      ) : (
        <div className="shrink-0 p-3">
          {reachability === 'away' && (
            <p className="mb-2 px-1 text-xs text-halo-warning">
              {t('{{owner}} seems to have stepped away — replies may take a moment.', { owner: ownerName || t('This teammate') })}
            </p>
          )}
          {aboveInput}
          <InputArea
            key={inputIdentity.current.key}
            draftKey={draftKey}
            toolbarSlot={toolbarSlot}
            hideToolsetControls
            hideKnowledgeControls
            onSend={handleSend}
            onStop={handleStop}
            isGenerating={isGenerating}
            placeholder={placeholder ?? t('Type a message…')}
            isCompact
          />
        </div>
      )}
    </>
  )
}
