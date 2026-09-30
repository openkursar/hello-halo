/**
 * Message List - Displays chat messages with streaming and thinking support
 * Layout: User message -> [Thinking Process above] -> [Assistant Reply]
 * Thinking process is always displayed ABOVE the assistant message (like ChatGPT/Cursor)
 *
 * Scrolling is native: rows are ordinary DOM in one scroll container, so the
 * browser owns heights and scroll position. Cost is bounded by the transcript
 * primitives instead of list virtualization — contained rows skip layout and
 * paint off-screen, a history window bounds how many rows React builds, and a
 * size-driven follower keeps the view on the newest content. See
 * `./transcript/DESIGN.md`.
 *
 * Key Feature: StreamingBubble with scroll animation
 * When AI outputs text -> calls tool -> outputs more text:
 * - Old content smoothly scrolls up and out of view
 * - New content appears in place
 * - Creates a clean, focused reading experience
 */

import { useRef, useMemo, useCallback, forwardRef, useImperativeHandle } from 'react'
import type { ReactNode } from 'react'
import { MessageRow } from './MessageRow'
import { StreamingSection } from './StreamingSection'
import { useBrowserToolCalls, type BrowserToolCall } from './useBrowserToolCalls'
import { useTerminalToolCalls, type TerminalToolCall } from './useTerminalToolCalls'
import { CompactNotice } from './CompactNotice'
import { InterruptedBubble } from './InterruptedBubble'
import { useStickToBottom, useHistoryWindow, transcriptRowClass, revealRowInView, type ScrollMotion } from './transcript'
import type { Message, Thought, CompactInfo, AgentErrorType, PendingQuestion } from '../../types'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { useChatStore } from '../../stores/chat.store'
import { useAppsStore } from '../../stores/apps.store'
import { appChatAppId } from '../../../shared/apps/im-keys'
import { resolveSpecI18n } from '../../utils/spec-i18n'
import { messageRowKeys } from '../../utils/message-row-key'

export interface MessageListProps {
  /**
   * Conversation this list belongs to. Drives the streaming session subscription
   * in the footer (queued messages + per-token re-render). This is the only link
   * to chat.store — the store is the shared real-time bus, keyed by conversationId,
   * not a "main chat" singleton. Surfaces using virtual ids (e.g. "app-chat:{appId}"
   * or IM session keys) pass that id here.
   */
  conversationId?: string
  messages: Message[]
  streamingContent: string
  isGenerating: boolean
  isStreaming?: boolean  // True during token-level text streaming
  thoughts?: Thought[]
  isThinking?: boolean
  compactInfo?: CompactInfo | null
  error?: string | null  // Error message to display when generation fails
  errorType?: AgentErrorType | null  // Special error type for custom UI handling
  onContinue?: () => void  // Callback to continue after interrupt (for InterruptedBubble)
  /** Stops the running turn; offered on the live retry notice. */
  onStop?: () => void
  isCompact?: boolean  // Compact mode when Canvas is open
  /** Side padding for the transcript; defaults to the main chat's. */
  sidePadClassName?: string
  textBlockVersion?: number  // Increments on each new text block (for StreamingBubble reset)
  pendingQuestion?: PendingQuestion | null  // Active question from AskUserQuestion tool
  onAnswerQuestion?: (answers: Record<string, string>) => void  // Callback when user answers
  onAtBottomStateChange?: (atBottom: boolean) => void  // Callback when at-bottom state changes
  /**
   * Lazily load a message's separated thoughts (v2 format). Source-agnostic: the
   * space surface loads from .thoughts.json; other surfaces can pass inline/no-op.
   * Omit to disable lazy loading (LazyCollapsedThoughtProcess degrades gracefully).
   */
  thoughtsLoader?: (messageId: string) => Promise<Thought[]>
  /**
   * Hide the "View live feed" button on BrowserTaskCard (both persisted rows and the
   * live streaming section). Set true where the conversation has no live browser
   * view to show (automation runs, IM and team transcripts).
   */
  hideBrowserLiveView?: boolean
  /**
   * Hide the "Open" button on TerminalTaskCard. Set true where there is no
   * canvas to open a terminal in (automation runs, IM and team transcripts).
   */
  hideTerminalOpen?: boolean
  /**
   * Older messages exist beyond the loaded ones: called when the reader reaches
   * the top of everything loaded. Pass only while more exists; the surface
   * reads the next page in and the list keeps the view where it is.
   */
  onLoadEarlier?: () => void
  /**
   * Start every message's thought panel expanded. For trace/debug viewers
   * (automation run detail) where the full execution timeline is the point.
   */
  defaultThoughtsExpanded?: boolean
  /**
   * Start every message's thought panel in full-height mode. Pairs with
   * defaultThoughtsExpanded for trace viewers.
   */
  defaultThoughtsMaximized?: boolean
  /**
   * Slot rendered at the end of the footer. The shell stays domain-agnostic — callers
   * inject surface-specific affordances (Continue, live indicator, clear, ...) here.
   */
  footerExtra?: ReactNode
}

/** Handle exposed to parent for scroll control */
export interface MessageListHandle {
  /**
   * Bring a message to the middle of the view, mounting older history if
   * needed. Returns false when the message is not part of this transcript.
   */
  scrollToMessage: (messageId: string, behavior?: ScrollMotion) => boolean
  scrollToBottom: (behavior?: ScrollMotion) => void
}

/**
 * Live turn area. Subscribes to this conversation's session itself so queued
 * messages and the retry notice update without routing through the list.
 */
function StreamingFooter({
  conversationId,
  streamingContent,
  isStreaming,
  thoughts,
  isThinking,
  textBlockVersion,
  browserToolCalls,
  terminalToolCalls,
  showBrowserViewButton,
  showTerminalOpenButton,
  pendingQuestion,
  onAnswerQuestion,
  onStop,
  senderName,
}: {
  conversationId: string
  streamingContent: string
  isStreaming: boolean
  thoughts: Thought[]
  isThinking: boolean
  textBlockVersion: number
  browserToolCalls: BrowserToolCall[]
  terminalToolCalls: TerminalToolCall[]
  showBrowserViewButton: boolean
  showTerminalOpenButton: boolean
  pendingQuestion: PendingQuestion | null
  onAnswerQuestion?: (answers: Record<string, string>) => void
  onStop?: () => void
  senderName?: string
}) {
  const queuedMessages = useChatStore(s => s.sessions.get(conversationId)?.queuedMessages)
  const apiRetry = useChatStore(s => s.sessions.get(conversationId)?.apiRetry ?? null)

  return (
    <StreamingSection
      streamingContent={streamingContent}
      isStreaming={isStreaming}
      thoughts={thoughts}
      isThinking={isThinking}
      textBlockVersion={textBlockVersion}
      browserToolCalls={browserToolCalls}
      terminalToolCalls={terminalToolCalls}
      showBrowserViewButton={showBrowserViewButton}
      showTerminalOpenButton={showTerminalOpenButton}
      pendingQuestion={pendingQuestion}
      onAnswerQuestion={onAnswerQuestion}
      queuedMessages={queuedMessages ?? EMPTY_QUEUE}
      senderName={senderName}
      apiRetry={apiRetry}
      onStop={onStop}
    />
  )
}

const EMPTY_QUEUE: never[] = []

export const MessageList = forwardRef<MessageListHandle, MessageListProps>(function MessageList({
  conversationId = '',
  messages,
  streamingContent,
  isGenerating,
  isStreaming = false,
  thoughts = [],
  isThinking = false,
  compactInfo = null,
  error = null,
  errorType = null,
  onContinue,
  onStop,
  isCompact = false,
  sidePadClassName,
  textBlockVersion = 0,
  pendingQuestion = null,
  onAnswerQuestion,
  onAtBottomStateChange,
  thoughtsLoader,
  hideBrowserLiveView = false,
  hideTerminalOpen = false,
  onLoadEarlier,
  defaultThoughtsExpanded = false,
  defaultThoughtsMaximized = false,
  footerExtra,
}, ref) {
  const { t } = useTranslation()

  // Reply-sender name — derived from conversationId, not stored on
  // the message. Not app-chat → "Halo"; app-chat → the digital human's own
  // resolved display name (falls back to appId while the apps list hasn't
  // loaded yet, mirroring DigitalHumansTab's own fallback).
  const apps = useAppsStore(s => s.apps)
  const senderName = useMemo(() => {
    const appId = conversationId ? appChatAppId(conversationId) : null
    if (!appId) return t('Halo')
    const app = apps.find(a => a.id === appId)
    if (!app) return appId
    return resolveSpecI18n(app.spec, getCurrentLanguage()).name || appId
  }, [conversationId, apps, t])

  // Track which messages had their thought panel opened by the user.
  // When loadMessageThoughts updates the store, the component tree switches from
  // LazyCollapsedThoughtProcess to CollapsedThoughtProcess — this ref ensures the
  // new CollapsedThoughtProcess mounts with defaultExpanded=true so the panel stays open.
  const expandedThoughtIds = useRef(new Set<string>())

  // Filter out injection messages (shown as annotations on assistant bubbles, not as independent bubbles)
  // and empty assistant placeholder message during generation
  const displayMessages = useMemo(() => {
    let filtered = messages.filter(msg => msg.source !== 'injection')
    if (isGenerating) {
      filtered = filtered.filter((msg, idx) => {
        const isLastMessage = idx === filtered.length - 1
        const isEmptyAssistant = msg.role === 'assistant' && !msg.content
        return !(isLastMessage && isEmptyAssistant)
      })
    }
    return filtered
  }, [messages, isGenerating])

  const follower = useStickToBottom({ onAtBottomChange: onAtBottomStateChange, live: isGenerating })
  const rowKeys = useMemo(() => messageRowKeys(displayMessages), [displayMessages])
  const history = useHistoryWindow(rowKeys, follower.scroller, { onReachStart: onLoadEarlier })
  const { scroller, scrollToBottom, detach } = follower
  const { reveal } = history

  const displayMessagesRef = useRef(displayMessages)
  displayMessagesRef.current = displayMessages

  useImperativeHandle(ref, () => ({
    scrollToMessage: (messageId: string, behavior: ScrollMotion = 'smooth') => {
      const index = displayMessagesRef.current.findIndex(m => m.id === messageId)
      if (index < 0 || !scroller) return false
      detach()
      reveal(index, el => revealRowInView(scroller, el, behavior))
      return true
    },
    scrollToBottom,
  }), [scroller, detach, reveal, scrollToBottom])

  // Pre-compute injection map: assistant message ID → injection messages that follow it.
  // Injection messages are consecutive user messages with source='injection' after an assistant message.
  // O(n) scan, recomputed only when messages change.
  const injectionMap = useMemo(() => {
    const map = new Map<string, Message[]>()
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === 'assistant') {
        const injections: Message[] = []
        for (let j = i + 1; j < messages.length; j++) {
          if (messages[j].source === 'injection') {
            injections.push(messages[j])
          } else {
            break
          }
        }
        if (injections.length > 0) {
          map.set(messages[i].id, injections)
        }
      }
    }
    return map
  }, [messages])

  // Pre-compute cost map: index → previous assistant cost (O(n) once, then O(1) per lookup)
  const previousCostMap = useMemo(() => {
    const map = new Map<number, number>()
    let lastCost = 0
    for (let i = 0; i < displayMessages.length; i++) {
      map.set(i, lastCost)
      const msg = displayMessages[i]
      if (msg.role === 'assistant' && msg.tokenUsage?.totalCostUsd) {
        lastCost = msg.tokenUsage.totalCostUsd
      }
    }
    return map
  }, [displayMessages])

  // Extract real-time browser tool calls from streaming thoughts
  const streamingBrowserToolCalls = useBrowserToolCalls(thoughts)
  const streamingTerminalToolCalls = useTerminalToolCalls(thoughts)

  // One identity for the whole list lifetime, so memoized rows are not
  // re-rendered by a parent passing a fresh loader closure.
  const thoughtsLoaderRef = useRef(thoughtsLoader)
  thoughtsLoaderRef.current = thoughtsLoader
  const handleLoadThoughts = useCallback((messageId: string) => {
    expandedThoughtIds.current.add(messageId)
    return thoughtsLoaderRef.current ? thoughtsLoaderRef.current(messageId) : Promise.resolve([])
  }, [])
  const hasThoughtsLoader = !!thoughtsLoader

  const contentWidthClass = isCompact ? 'max-w-full' : 'max-w-chat mx-auto'
  const sidePadClass = sidePadClassName ?? (isCompact ? 'px-3' : 'px-6')

  // Built only when the transcript itself changes: tokens streaming into the
  // footer re-render this component but reuse these elements untouched.
  const { start } = history
  const rows = useMemo(() => displayMessages.slice(start).map((message, offset) => {
    const index = start + offset
    return (
      <div key={rowKeys[index]} data-transcript-index={index} className={transcriptRowClass(message)}>
        <MessageRow
          message={message}
          previousCost={previousCostMap.get(index) ?? 0}
          defaultThoughtsExpanded={defaultThoughtsExpanded || expandedThoughtIds.current.has(message.id)}
          defaultThoughtsMaximized={defaultThoughtsMaximized}
          onLoadThoughts={hasThoughtsLoader ? handleLoadThoughts : undefined}
          hideBrowserLiveView={hideBrowserLiveView}
          hideTerminalOpen={hideTerminalOpen}
          injectionMessages={injectionMap.get(message.id)}
          className={contentWidthClass}
          senderName={message.role === 'assistant' ? senderName : undefined}
        />
      </div>
    )
  }), [displayMessages, start, previousCostMap, defaultThoughtsExpanded, defaultThoughtsMaximized, hasThoughtsLoader, handleLoadThoughts, hideBrowserLiveView, hideTerminalOpen, rowKeys, injectionMap, contentWidthClass, senderName])

  // Keep the footer mounted for an active question independently of isGenerating:
  // a recovered question can be paused on the answer with isGenerating false, and
  // gating on it alone would drop the card and deadlock the conversation.
  const hasActiveQuestion = pendingQuestion?.status === 'active'

  return (
    <div
      ref={follower.scrollerRef}
      data-testid="transcript-scroller"
      tabIndex={-1}
      className="h-full overflow-y-auto overflow-x-hidden focus:outline-none"
    >
      <div ref={follower.contentRef} className={`pt-6 pb-6 ${sidePadClass}`}>
        <div ref={history.sentinelRef} aria-hidden="true" />

        {rows}

        <div className={contentWidthClass}>
          {(isGenerating || hasActiveQuestion) && (
            <StreamingFooter
              conversationId={conversationId}
              streamingContent={streamingContent}
              isStreaming={isStreaming}
              thoughts={thoughts}
              isThinking={isThinking}
              textBlockVersion={textBlockVersion}
              browserToolCalls={streamingBrowserToolCalls}
              terminalToolCalls={streamingTerminalToolCalls}
              showBrowserViewButton={!hideBrowserLiveView}
              showTerminalOpenButton={!hideTerminalOpen}
              pendingQuestion={pendingQuestion}
              onAnswerQuestion={onAnswerQuestion}
              onStop={onStop}
              senderName={senderName}
            />
          )}

          {/* Interrupted errors get special friendly UI, other errors show standard error bubble */}
          {!isGenerating && error && errorType === 'interrupted' && (
            <div className="pb-4">
              <InterruptedBubble error={error} onContinue={onContinue} />
            </div>
          )}
          {!isGenerating && error && errorType !== 'interrupted' && (
            <div className="flex justify-start animate-fade-in pb-4">
              <div className="w-[85%]">
                <div className="rounded-2xl px-4 py-3 bg-destructive/10 border border-destructive/30">
                  <div className="flex items-center gap-2 text-destructive">
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="8" x2="12" y2="12" />
                      <line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                    <span className="text-sm font-medium">{t('Something went wrong')}</span>
                  </div>
                  <p className="mt-2 text-sm text-destructive/80">{error}</p>
                </div>
              </div>
            </div>
          )}

          {/* Compact notice - shown when context was compressed (runtime notification) */}
          {compactInfo && (
            <div className="pb-4">
              <CompactNotice trigger={compactInfo.trigger} preTokens={compactInfo.preTokens} />
            </div>
          )}

          {/* Surface-specific footer slot (Continue / live indicator / clear / ...) */}
          {footerExtra}
        </div>
      </div>
    </div>
  )
})
