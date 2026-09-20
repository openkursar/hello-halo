/**
 * MessageRow - Renders a single persisted message with its thought process.
 *
 * Pure presentational component — no store coupling. Handles both inline
 * thoughts (Thought[]) and separated/lazy thoughts (v2 format with ThoughtsSummary).
 *
 * Shared across: MessageList (main chat), AppChatView, ImChatView, SessionDetailView.
 */

import { memo, type ReactNode } from 'react'
import { MessageItem } from './MessageItem'
import { CollapsedThoughtProcess, LazyCollapsedThoughtProcess } from './CollapsedThoughtProcess'
import { TeamSnapshotPanel } from './TeamPanel'
import { InjectionAnnotation } from './InjectionAnnotation'
import {
  CrossConversationMessage,
  CrossConversationNotice,
  isCrossConversationMessage,
  isCrossConversationNotice,
} from './cross-conversation'
import type { Message, Thought } from '../../types'

export interface MessageRowProps {
  afterThoughts?: ReactNode
  /** The message to render */
  message: Message

  /** Previous assistant message's cumulative cost (for token usage delta display) */
  previousCost?: number

  /** Whether the thought panel should start expanded (e.g., user previously opened it) */
  defaultThoughtsExpanded?: boolean

  /** Whether the thought panel should start in full-height mode. Useful for debugging views. */
  defaultThoughtsMaximized?: boolean

  /** Callback to lazily load separated thoughts (v2 format).
   *  Called with messageId. If not provided, LazyCollapsedThoughtProcess
   *  falls back to a no-op loader (graceful degradation). */
  onLoadThoughts?: (messageId: string) => Promise<Thought[]>

  /** Hide the "View live feed" button in BrowserTaskCard.
   *  Set true in automation app contexts where Canvas/BrowserView is unavailable. */
  hideBrowserViewButton?: boolean

  /** Mid-turn injection messages associated with this assistant message.
   *  Rendered as a permanent annotation at the bottom of the assistant bubble. */
  injectionMessages?: Message[]

  /** Additional className for the outer wrapper (e.g., width constraints from Virtuoso) */
  className?: string

  /**
   * Reply-sender name, resolved by the caller (MessageList) from
   * conversationId — the digital human's name for app-chat, "Halo" otherwise.
   * Only meaningful for assistant messages; pass undefined for user messages.
   */
  senderName?: string
}

export const MessageRow = memo(function MessageRow({
  message,
  afterThoughts,
  previousCost,
  defaultThoughtsExpanded = false,
  defaultThoughtsMaximized = false,
  onLoadThoughts,
  hideBrowserViewButton = false,
  injectionMessages,
  className = '',
  senderName,
}: MessageRowProps) {
  // System-sourced rows are routed before the bubble branches below: MessageItem
  // only distinguishes user from assistant, so anything reaching it would be
  // dressed as one of the two. This is the only place that decision is made.
  if (isCrossConversationMessage(message)) {
    return (
      <div className={`pb-4 ${className}`}>
        <CrossConversationMessage message={message} />
      </div>
    )
  }

  if (isCrossConversationNotice(message)) {
    return (
      <div className={className}>
        <CrossConversationNotice message={message} />
      </div>
    )
  }

  const hasInlineThoughts = Array.isArray(message.thoughts) && message.thoughts.length > 0
  const hasSeparatedThoughts = message.thoughts === null && !!message.thoughtsSummary

  // Reply-sender label — plain text, always the topmost element of
  // the reply (above thoughts, above the bubble), assistant messages only.
  const senderLabel = message.role === 'assistant' && senderName ? (
    <div className="mb-1 text-xs font-medium text-muted-foreground">{senderName}</div>
  ) : null

  // Assistant messages with thoughts: show collapsed thoughts above message bubble
  if (message.role === 'assistant' && (hasInlineThoughts || hasSeparatedThoughts)) {
    return (
      <div className={`flex justify-start pb-5 ${className}`}>
        <div className="w-[85%]">
          {senderLabel}
          {hasInlineThoughts ? (
            <CollapsedThoughtProcess
              thoughts={message.thoughts as Thought[]}
              defaultExpanded={defaultThoughtsExpanded}
              defaultMaximized={defaultThoughtsMaximized}
            />
          ) : (
            <LazyCollapsedThoughtProcess
              thoughtsSummary={message.thoughtsSummary!}
              onLoadThoughts={
                onLoadThoughts
                  ? () => onLoadThoughts(message.id)
                  : () => Promise.resolve([])
              }
            />
          )}

          {afterThoughts && <div className="my-3 space-y-3">{afterThoughts}</div>}
          {/* Agent Team snapshot — shows completed team collaboration for this turn.
              Derived from thoughts — automatically persisted and available in history. */}
          {hasInlineThoughts && (
            <TeamSnapshotPanel thoughts={message.thoughts as Thought[]} />
          )}

          {/* Only render bubble if there is text content.
              Assistant events with only tool_use/thinking blocks have empty content —
              rendering MessageItem for those would produce empty visible bubbles. */}
          {message.content && (
            <MessageItem
              message={message}
              previousCost={previousCost}
              hideThoughts
              isInContainer
              hideBrowserViewButton={hideBrowserViewButton}
            />
          )}

          {/* Injection annotation — permanently shows mid-turn user messages */}
          {injectionMessages && injectionMessages.length > 0 && (
            <InjectionAnnotation messages={injectionMessages} />
          )}
        </div>
      </div>
    )
  }

  // Regular messages (user, or assistant without thoughts)
  // Assistant messages without thoughts may still have injection annotations
  const hasInjections = injectionMessages && injectionMessages.length > 0
  if (message.role === 'assistant' && hasInjections) {
    return (
      <div className={`pb-5 ${className}`}>
        <div className="flex justify-start">
          <div className="w-[85%]">
            {senderLabel}
            <MessageItem
              message={message}
              previousCost={previousCost}
              hideBrowserViewButton={hideBrowserViewButton}
              isInContainer
            />
            <InjectionAnnotation messages={injectionMessages} />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={`pb-5 ${className}`}>
      {senderLabel}
      <MessageItem
        message={message}
        previousCost={previousCost}
        hideBrowserViewButton={hideBrowserViewButton}
      />
    </div>
  )
})
