/**
 * MessageRow - Renders a single persisted message with its thought process.
 *
 * Pure presentational component — no store coupling. Handles both inline
 * thoughts (Thought[]) and separated/lazy thoughts (v2 format with ThoughtsSummary).
 *
 * Shared across: MessageList (space and digital-human chat), ImChatView, SessionDetailView.
 */

import { memo, useMemo, type ReactNode } from 'react'
import { MessageItem } from './MessageItem'
import { CollapsedThoughtProcess, LazyCollapsedThoughtProcess } from './CollapsedThoughtProcess'
import { InjectionAnnotation } from './InjectionAnnotation'
import {
  CrossConversationMessage,
  CrossConversationNotice,
  isCrossConversationMessage,
  isCrossConversationNotice,
} from './cross-conversation'
import { ReplyOpeners, isTeamMessage, type OpenerReveal } from './team-collab'
import { TrailingArrivals } from './ArrivalCard'
import { mergeArrivalThoughts, toArrivalThought } from './transcript'
import { PushedMessageLabel, isPushedMessage } from './PushedMessageLabel'
import { ContinuityNotice, isContinuityNotice } from './ContinuityNotice'
import { ReplyEndingNote } from './ReplyEndingNote'
import type { Message, Thought } from '../../types'

export interface MessageRowProps {
  afterThoughts?: ReactNode
  /** The message to render */
  message: Message

  /** Previous assistant message's cumulative cost (for token usage delta display) */
  previousCost?: number

  /** Whether the reply's work should start open (e.g., the user opened it before) */
  defaultThoughtsExpanded?: boolean

  /** Show every operation of the work from the start. For trace views, where the full execution is the point. */
  showOperations?: boolean

  /** Callback to lazily load separated thoughts (v2 format).
   *  Called with messageId. If not provided, LazyCollapsedThoughtProcess
   *  falls back to a no-op loader (graceful degradation). */
  onLoadThoughts?: (messageId: string) => Promise<Thought[]>

  /** For the reply that just finished: the steps streamed for it, shown while its saved steps load. */
  streamedThoughts?: Thought[]

  /** Hide the "View live feed" button in BrowserTaskCard.
   *  Set true where there is no live browser view to show for the conversation. */
  hideBrowserLiveView?: boolean

  /** Hide the "Open" button in TerminalTaskCard.
   *  Set true where there is no canvas to open a terminal in. */
  hideTerminalOpen?: boolean

  /** Enable only when this transcript can open its replies in the space canvas. */
  allowViewChanges?: boolean

  /** Mid-turn injection messages associated with this assistant message.
   *  Rendered as a permanent annotation at the bottom of the assistant bubble. */
  injectionMessages?: Message[]

  /** Records received while this reply was written (see transcript/arrivals): drawn in
   *  its process, or after it when it has none. */
  arrivals?: Message[]

  /** Reveal the reply's copy and token usage on hover only (every reply but the latest). */
  actionsOnHover?: boolean

  /** Teammates' deliveries that started this reply (see transcript/transcript-rows); drawn on its sender line.
   *  On a team message, the consecutive ones its line stands for. */
  openers?: Message[]

  /** Opens the openers to show one of them (a search or reference jump). */
  openerReveal?: OpenerReveal

  /** A sender line the caller drew itself, for deliveries that are not transcript messages. */
  openersLine?: ReactNode

  /** Drawn under an assistant reply, e.g. what it handed on to teammates. */
  afterReply?: ReactNode

  /** Additional className for the outer wrapper (e.g., width constraints from the list) */
  className?: string

  /**
   * Reply-sender name, resolved by the caller (MessageList) from
   * conversationId — the digital human's name for app-chat, "Halo" otherwise.
   * Only meaningful for assistant messages; pass undefined for user messages.
   */
  senderName?: string

  /**
   * The person who wrote this transcript's user messages, when that is not the
   * reader (someone else's digital human). Their messages move to the left under
   * this name, so the right side always means the reader.
   */
  authorName?: string

  /** The chat shows how this reply ended right below it (the notice after a stop), so the reply's own note steps aside. */
  endingShownBelow?: boolean
}

export const MessageRow = memo(function MessageRow({
  message,
  afterThoughts,
  previousCost,
  defaultThoughtsExpanded = false,
  showOperations = false,
  onLoadThoughts,
  streamedThoughts,
  hideBrowserLiveView = false,
  hideTerminalOpen = false,
  allowViewChanges = false,
  injectionMessages,
  arrivals,
  openers,
  openerReveal,
  openersLine,
  afterReply,
  actionsOnHover = false,
  className = '',
  senderName,
  authorName,
  endingShownBelow = false,
}: MessageRowProps) {
  const hasInlineThoughts = Array.isArray(message.thoughts) && message.thoughts.length > 0
  const processThoughts = useMemo(() => hasInlineThoughts && arrivals?.length
    ? mergeArrivalThoughts(message.thoughts as Thought[], arrivals.map(toArrivalThought))
    : message.thoughts as Thought[], [hasInlineThoughts, message.thoughts, arrivals])

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

  if (isContinuityNotice(message)) {
    return (
      <div className={className}>
        <ContinuityNotice message={message} />
      </div>
    )
  }

  // No reply follows it: the line a reply would carry, on its own.
  if (isTeamMessage(message)) {
    return (
      <div className={`pb-3 ${className}`}>
        <div className="w-[85%]">
          <ReplyOpeners senderName={senderName} openers={openers?.length ? openers : [message]} reveal={openerReveal} />
        </div>
      </div>
    )
  }

  const hasSeparatedThoughts = message.thoughts === null && !!message.thoughtsSummary

  // Sender label — plain text, always the topmost element of the row (above
  // thoughts, above the bubble): the reply's sender, or another person's name.
  const fromOther = message.role === 'user' && !!authorName
  const senderLabel = message.role !== 'assistant'
    ? fromOther ? <div className="mb-2 text-sm font-semibold text-foreground">{authorName}</div> : null
    : openersLine ? openersLine
    : openers?.length ? <ReplyOpeners senderName={senderName} openers={openers} reveal={openerReveal} />
    : senderName ? <div className="mb-2 text-sm font-semibold text-foreground">{senderName}</div>
    : null

  // A reply without a process of its own shows what it received after it.
  const trailingArrivals = arrivals?.length && !hasInlineThoughts && !hasSeparatedThoughts
    ? <TrailingArrivals arrivals={arrivals} senderName={senderName} />
    : null

  // Assistant messages with thoughts: show collapsed thoughts above message bubble
  if (message.role === 'assistant' && (hasInlineThoughts || hasSeparatedThoughts)) {
    return (
      <div className={`group/reply flex justify-start pb-5 ${className}`}>
        <div className="w-[85%]">
          {senderLabel}
          {hasInlineThoughts ? (
            <CollapsedThoughtProcess
              thoughts={processThoughts}
              messageId={message.id}
              answer={message.content}
              defaultExpanded={defaultThoughtsExpanded}
              showOperations={showOperations}
            />
          ) : (
            <LazyCollapsedThoughtProcess
              thoughtsSummary={message.thoughtsSummary!}
              answer={message.content}
              showOperations={showOperations}
              arrivals={arrivals}
              messageId={message.id}
              streamedThoughts={streamedThoughts}
              onLoadThoughts={
                onLoadThoughts
                  ? () => onLoadThoughts(message.id)
                  : () => Promise.resolve([])
              }
            />
          )}

          {afterThoughts && <div className="my-3 space-y-3">{afterThoughts}</div>}
          {/* Empty tool/thinking output has no bubble; a persisted error still needs its existing error block. */}
          {(message.content || message.error) ? (
            <MessageItem
              message={message}
              previousCost={previousCost}
              hideThoughts
              isInContainer
              hideBrowserLiveView={hideBrowserLiveView}
              hideTerminalOpen={hideTerminalOpen}
              allowViewChanges={allowViewChanges}
              actionsOnHover={actionsOnHover}
              hideEnding={endingShownBelow}
            />
          ) : message.metadata?.ending && !endingShownBelow && (
            <ReplyEndingNote ending={message.metadata.ending} hasAnswer={false} />
          )}

          {/* Injection annotation — permanently shows mid-turn user messages */}
          {injectionMessages && injectionMessages.length > 0 && (
            <InjectionAnnotation messages={injectionMessages} />
          )}
          {afterReply}
        </div>
      </div>
    )
  }

  // Regular messages (user, or assistant without thoughts)
  // Assistant messages without thoughts may still have injection annotations
  const hasInjections = injectionMessages && injectionMessages.length > 0
  if (message.role === 'assistant' && hasInjections) {
    return (
      <div className={`group/reply pb-5 ${className}`}>
        <div className="flex justify-start">
          <div className="w-[85%]">
            {senderLabel}
            <MessageItem
              message={message}
              previousCost={previousCost}
              hideBrowserLiveView={hideBrowserLiveView}
              hideTerminalOpen={hideTerminalOpen}
              allowViewChanges={allowViewChanges}
              actionsOnHover={actionsOnHover}
              hideEnding={endingShownBelow}
              isInContainer
            />
            <InjectionAnnotation messages={injectionMessages} />
            {afterReply}
          </div>
        </div>
        {trailingArrivals}
      </div>
    )
  }

  return (
    <div className={`group/reply pb-5 ${className}`}>
      {senderLabel}
      {isPushedMessage(message) && <PushedMessageLabel via={message.metadata?.pushVia} by={message.metadata?.pushedByName} />}
      <MessageItem
        message={message}
        previousCost={previousCost}
        hideBrowserLiveView={hideBrowserLiveView}
        hideTerminalOpen={hideTerminalOpen}
        allowViewChanges={allowViewChanges}
        actionsOnHover={actionsOnHover}
        alignStart={fromOther}
        hideEnding={endingShownBelow}
      />
      {message.role === 'assistant' && afterReply}
      {trailingArrivals}
    </div>
  )
})
