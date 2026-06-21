/**
 * Message List - Displays chat messages with streaming and thinking support
 * Layout: User message -> [Thinking Process above] -> [Assistant Reply]
 * Thinking process is always displayed ABOVE the assistant message (like ChatGPT/Cursor)
 *
 * Uses react-virtuoso for virtualized scrolling — only visible messages are in DOM.
 * This provides smooth performance even with 100+ messages containing thoughts/tool calls.
 *
 * Key Feature: StreamingBubble with scroll animation
 * When AI outputs text -> calls tool -> outputs more text:
 * - Old content smoothly scrolls up and out of view
 * - New content appears in place
 * - Creates a clean, focused reading experience
 *
 * @see docs/streaming-scroll-animation.md for detailed implementation notes
 */

import { useEffect, useRef, useMemo, useCallback, forwardRef, useImperativeHandle } from 'react'
import type { ReactNode } from 'react'
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso'
import { MessageRow } from './MessageRow'
import { StreamingSection } from './StreamingSection'
import { useBrowserToolCalls, type BrowserToolCall } from './useBrowserToolCalls'
import { CompactNotice } from './CompactNotice'
import { InterruptedBubble } from './InterruptedBubble'
import type { Message, Thought, CompactInfo, AgentErrorType, PendingQuestion } from '../../types'
import { useTranslation } from '../../i18n'
import { useChatStore } from '../../stores/chat.store'

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
  isCompact?: boolean  // Compact mode when Canvas is open
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
   * live streaming section). Set true where Canvas/BrowserView is unavailable
   * (automation app / IM contexts).
   */
  hideBrowserViewButton?: boolean
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
  scrollToIndex: (index: number, behavior?: ScrollBehavior) => void
  scrollToBottom: (behavior?: ScrollBehavior) => void
}

/**
 * StreamingFooterContent — Isolated component for high-frequency streaming updates.
 * Reads volatile props from a ref to avoid rebuilding the parent Footer callback.
 * This prevents Virtuoso from unmounting/remounting Footer on every token.
 */
interface StreamingRevision {
  streamingContent: string
  isStreaming: boolean
  thoughts: Thought[]
  isThinking: boolean
  textBlockVersion: number
  streamingBrowserToolCalls: BrowserToolCall[]
  pendingQuestion: PendingQuestion | null
  onAnswerQuestion?: (answers: Record<string, string>) => void
}

function StreamingFooterContent({
  conversationId,
  showBrowserViewButton,
  revisionRef,
}: {
  conversationId: string
  showBrowserViewButton: boolean
  revisionRef: React.RefObject<StreamingRevision>
}) {
  // Subscribe to this conversation's session so the footer re-renders when
  // thoughts/streaming/queued update. Data is read from the ref (always fresh);
  // this selector only triggers the re-render. Keyed by conversationId — the store
  // is the shared real-time bus, not the "current conversation" singleton.
  // IMPORTANT: Must watch the entire session object — watching only queuedMessages breaks
  // streaming re-renders because queuedMessages never changes during normal streaming.
  const session = useChatStore(s => s.sessions.get(conversationId))
  const queuedMessages = session?.queuedMessages ?? []

  const rev = revisionRef.current!
  return (
    <StreamingSection
      streamingContent={rev.streamingContent}
      isStreaming={rev.isStreaming}
      thoughts={rev.thoughts}
      isThinking={rev.isThinking}
      textBlockVersion={rev.textBlockVersion}
      browserToolCalls={rev.streamingBrowserToolCalls}
      showBrowserViewButton={showBrowserViewButton}
      pendingQuestion={rev.pendingQuestion}
      onAnswerQuestion={rev.onAnswerQuestion}
      queuedMessages={queuedMessages}
    />
  )
}

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
  isCompact = false,
  textBlockVersion = 0,
  pendingQuestion = null,
  onAnswerQuestion,
  onAtBottomStateChange,
  thoughtsLoader,
  hideBrowserViewButton = false,
  defaultThoughtsExpanded = false,
  defaultThoughtsMaximized = false,
  footerExtra,
}, ref) {
  const { t } = useTranslation()
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  // Native DOM scroll container — captured via Virtuoso's scrollerRef prop
  const scrollerRef = useRef<HTMLElement | null>(null)
  // Track at-bottom state in a ref (not state) to avoid re-renders on every scroll event
  const isAtBottomRef = useRef(true)
  // Track which messages had their thought panel opened by the user.
  // When loadMessageThoughts updates the store, the component tree switches from
  // LazyCollapsedThoughtProcess to CollapsedThoughtProcess — this ref ensures the
  // new CollapsedThoughtProcess mounts with defaultExpanded=true so the panel stays open.
  const expandedThoughtIds = useRef(new Set<string>())

  // Expose scroll control to parent (ChatView)
  useImperativeHandle(ref, () => ({
    scrollToIndex: (index: number, behavior: ScrollBehavior = 'smooth') => {
      virtuosoRef.current?.scrollToIndex({ index, behavior, align: 'center' })
    },
    scrollToBottom: (behavior: ScrollBehavior = 'smooth') => {
      const el = scrollerRef.current
      if (el) {
        el.scrollTo({ top: el.scrollHeight, behavior })
      }
    },
  }), [])

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
  // This avoids a useCallback dependency on displayMessages that would cascade to itemContent
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

  // Track at-bottom state via native DOM scroll events (independent of Virtuoso).
  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    isAtBottomRef.current = atBottom
    onAtBottomStateChange?.(atBottom)
  }, [onAtBottomStateChange])

  /** Instantly snap scroll container to absolute bottom */
  const scrollToEnd = useCallback(() => {
    const el = scrollerRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'auto' })
  }, [])

  // --- Native DOM auto-scroll (replaces Virtuoso followOutput) ---

  // 1. Mount scroll: wait for Virtuoso to finish initial layout, then snap to bottom.
  useEffect(() => {
    const timer = setTimeout(scrollToEnd, 300)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 2. Streaming scroll: follow content growth while AI is generating
  useEffect(() => {
    if (!isAtBottomRef.current || !isGenerating) return
    requestAnimationFrame(scrollToEnd)
  }, [streamingContent, thoughts.length, isThinking, isGenerating, pendingQuestion, scrollToEnd])

  // 3. New-message scroll: when user sends a message (displayMessages grows)
  const prevDisplayCountRef = useRef(displayMessages.length)
  useEffect(() => {
    const prev = prevDisplayCountRef.current
    prevDisplayCountRef.current = displayMessages.length
    if (displayMessages.length > prev && isAtBottomRef.current) {
      requestAnimationFrame(scrollToEnd)
    }
  }, [displayMessages.length, scrollToEnd])

  // Content width class — applied per-item so Virtuoso scroll container stays full-width
  // (keeps scrollbar at the window edge, not next to message bubbles)
  const contentWidthClass = isCompact ? 'max-w-full' : 'max-w-3xl mx-auto'

  // Render a single message item (called by Virtuoso)
  const itemContent = useCallback((index: number, message: Message) => {
    const previousCost = previousCostMap.get(index) ?? 0
    return (
      <MessageRow
        message={message}
        previousCost={previousCost}
        defaultThoughtsExpanded={defaultThoughtsExpanded || expandedThoughtIds.current.has(message.id)}
        defaultThoughtsMaximized={defaultThoughtsMaximized}
        onLoadThoughts={thoughtsLoader
          ? (messageId) => {
              expandedThoughtIds.current.add(messageId)
              return thoughtsLoader(messageId)
            }
          : undefined}
        hideBrowserViewButton={hideBrowserViewButton}
        injectionMessages={injectionMap.get(message.id)}
        className={contentWidthClass}
      />
    )
  }, [previousCostMap, thoughtsLoader, hideBrowserViewButton, defaultThoughtsExpanded, defaultThoughtsMaximized, injectionMap, contentWidthClass])

  // Ref for onContinue — keeps Footer callback stable when parent re-renders
  const onContinueRef = useRef(onContinue)
  onContinueRef.current = onContinue

  // Streaming revision: combines all streaming state into a single object.
  // StreamingFooterContent reads this via ref (always fresh) and subscribes to
  // the store to trigger re-renders when streaming state changes.
  const streamingRevision = useMemo(() => {
    return { streamingContent, isStreaming, thoughts, isThinking, textBlockVersion,
             streamingBrowserToolCalls, pendingQuestion, onAnswerQuestion }
  }, [streamingContent, isStreaming, thoughts, isThinking, textBlockVersion,
      streamingBrowserToolCalls, pendingQuestion, onAnswerQuestion])
  const streamingRevisionRef = useRef(streamingRevision)
  streamingRevisionRef.current = streamingRevision

  // Footer: stable callback — only depends on low-frequency values
  // High-frequency streaming updates are handled by StreamingFooterContent internally
  const Footer = useCallback(() => {
    const hasFooterContent = isGenerating || (!isGenerating && error) || compactInfo || footerExtra
    if (!hasFooterContent) return <div className="pb-6" />

    return (
      <div className={contentWidthClass}>
        {/* Streaming area — isolated component reads from refs, re-renders independently */}
        {isGenerating && (
          <StreamingFooterContent
            conversationId={conversationId}
            showBrowserViewButton={!hideBrowserViewButton}
            revisionRef={streamingRevisionRef}
          />
        )}

        {/* Error message - shown when generation fails (not during generation) */}
        {/* Interrupted errors get special friendly UI, other errors show standard error bubble */}
        {!isGenerating && error && errorType === 'interrupted' && (
          <div className="pb-4">
            <InterruptedBubble error={error} onContinue={onContinueRef.current} />
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

        {/* Bottom padding to match original py-6 spacing */}
        <div className="pb-6" />
      </div>
    )
  }, [
    isGenerating,
    error, errorType,
    compactInfo, t, contentWidthClass,
    conversationId, hideBrowserViewButton, footerExtra,
  ])

  // Top padding spacer — matches original py-6
  const Header = useCallback(() => <div className="pt-6" />, [])

  // Stable components object — avoids Virtuoso re-initializing on every render
  const components = useMemo(() => ({ Header, Footer }), [Header, Footer])

  return (
    <Virtuoso
      ref={virtuosoRef}
      data={displayMessages}
      style={{ height: '100%' }}
      scrollerRef={(el) => { scrollerRef.current = el as HTMLElement }}
      initialTopMostItemIndex={displayMessages.length > 0 ? displayMessages.length - 1 : 0}
      defaultItemHeight={150}
      increaseViewportBy={800}
      atBottomThreshold={100}
      atBottomStateChange={handleAtBottomStateChange}
      itemContent={itemContent}
      components={components}
    />
  )
})
