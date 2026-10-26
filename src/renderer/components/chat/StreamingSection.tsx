/**
 * StreamingSection - Renders the real-time streaming content area.
 *
 * Pure presentational component — no store coupling. Composes
 * ThoughtProcess + BrowserTaskCard + StreamingBubble + AskUserQuestionCard.
 *
 * Shared across: MessageList (space and digital-human chat), ImChatView.
 */

import { memo, useMemo, useRef } from 'react'
import { ThoughtProcess } from './ThoughtProcess'
import { MessageRow } from './MessageRow'
import { InjectionAnnotation } from './InjectionAnnotation'
import { ArrivalCard } from './ArrivalCard'
import { ReplyOpeners } from './team-collab'
import { isArrivalRecord, isArrivalThought, mergeArrivalThoughts, projectArrivalThoughts, type ArrivalThought } from './transcript'
import { splitLiveInputSections, type LiveInputSection } from '../../utils/live-inputs'
import type { LiveInput, Message } from '../../types'
import { StreamingBubble } from './StreamingBubble'
import { BrowserTaskCard } from '../tool/BrowserTaskCard'
import { TerminalTaskCard } from '../tool/TerminalTaskCard'
import { AskUserQuestionCard } from './AskUserQuestionCard'
import { QueuedMessagesPanel } from './QueuedMessagesPanel'
import { ApiRetryNotice } from './ApiRetryNotice'
import type { Thought, PendingQuestion, ApiRetryNotice as ApiRetryNoticeState } from '../../types'
import type { BrowserToolCall } from './useBrowserToolCalls'
import type { TerminalToolCall } from './useTerminalToolCalls'

export interface StreamingSectionProps {
  /** Accumulated streaming text content */
  streamingContent: string

  /** Whether tokens are actively arriving */
  isStreaming: boolean

  /** Real-time thought array */
  thoughts: Thought[]

  /** Whether the agent is in a thinking phase */
  isThinking: boolean

  /** Increments on each new text block (for StreamingBubble reset) */
  textBlockVersion?: number

  /** Browser tool calls extracted from streaming thoughts */
  browserToolCalls?: BrowserToolCall[]

  /** Terminal tool calls extracted from streaming thoughts */
  terminalToolCalls?: TerminalToolCall[]

  /** Whether to show the "View live feed" button on BrowserTaskCard.
   *  Set false where there is no live browser view for the conversation. */
  showBrowserViewButton?: boolean

  /** Whether to show the "Open" button on TerminalTaskCard.
   *  Set false where there is no canvas to open a terminal in. */
  showTerminalOpenButton?: boolean

  /** Active question from AskUserQuestion tool */
  pendingQuestion?: PendingQuestion | null

  /** Callback when user answers a pending question */
  onAnswerQuestion?: (answers: Record<string, string>) => void

  /** Additional className for the outer wrapper */
  className?: string

  /** Inside a host card that frames and titles the turn: full width, steps inline. */
  embedded?: boolean

  /** Messages queued for mid-turn injection (shown below StreamingBubble) */
  queuedMessages?: string[]
  /** Inputs accepted while this turn runs, at the point each became visible. */
  liveInputs?: LiveInput[]
  /**
   * The turn's arrivals as stored (see transcript/arrivals); without it they
   * are taken from `liveInputs`.
   */
  arrivals?: Message[]

  /** Teammates' deliveries that started this turn; drawn on the sender line, as the saved reply draws them. */
  openers?: readonly Message[]

  /**
   * Reply-sender name — the digital-human's display name for an
   * app-chat conversation, or "Halo" for a regular one. Resolved by the
   * caller from conversationId, not stored on the message itself. Shown
   * before the streaming reply starts producing text, since the name is
   * known from the conversation, not the content.
   */
  senderName?: string

  /** A failed model request the engine is waiting to resend. */
  apiRetry?: ApiRetryNoticeState | null

  /** Stops the turn; offered on the retry notice. */
  onStop?: () => void
}

const EMPTY_INPUTS: LiveInput[] = []
const EMPTY_MESSAGES: Message[] = []
const EMPTY_THOUGHTS: Thought[] = []
const EMPTY_ARRIVAL_THOUGHTS: ArrivalThought[] = []

const ArrivedInputSection = memo(function ArrivedInputSection({ input, thoughts, text, embedded }: LiveInputSection & { embedded: boolean }) {
  return <>
    <div className={embedded ? 'w-full' : 'w-[85%]'}>
      {thoughts.length > 0 && <ThoughtProcess thoughts={thoughts} isThinking={thoughts.some(thought => thought.isStreaming || (thought.type === 'tool_use' && !thought.toolResult))} embedded={embedded} />}
      {text && <StreamingBubble content={text} isStreaming={false} thoughts={[]} textBlockVersion={input.textBlockVersion} />}
    </div>
    <MessageRow message={input.message} hideBrowserLiveView hideTerminalOpen />
  </>
})

export function StreamingSection({
  streamingContent,
  isStreaming,
  thoughts,
  isThinking,
  textBlockVersion = 0,
  browserToolCalls = [],
  terminalToolCalls = [],
  showBrowserViewButton = true,
  showTerminalOpenButton = true,
  pendingQuestion,
  onAnswerQuestion,
  className = '',
  embedded = false,
  queuedMessages = [],
  liveInputs = EMPTY_INPUTS,
  arrivals,
  openers,
  senderName,
  apiRetry = null,
  onStop,
}: StreamingSectionProps) {
  const conversationInputs = useMemo(() => liveInputs.filter(input => input.message.source !== 'injection' && !isArrivalRecord(input.message)), [liveInputs])
  const injectionMessages = useMemo(() => liveInputs.filter(input => input.message.source === 'injection').map(input => input.message), [liveInputs])
  const arrivalMessages = useMemo(() => arrivals ?? liveInputs.filter(input => isArrivalRecord(input.message)).map(input => input.message), [liveInputs, arrivals])
  const hasOwnThoughts = thoughts.length > 0
  const previousArrivalThoughts = useRef<ArrivalThought[]>([])
  const arrivalThoughts = useMemo(() => {
    const next = hasOwnThoughts ? projectArrivalThoughts(arrivalMessages, previousArrivalThoughts.current) : EMPTY_ARRIVAL_THOUGHTS
    previousArrivalThoughts.current = next
    return next
  }, [arrivalMessages, hasOwnThoughts])
  const processThoughts = useMemo(() => mergeArrivalThoughts(thoughts, arrivalThoughts), [thoughts, arrivalThoughts])
  const priorSections = useRef<LiveInputSection[]>([])
  const layout = useMemo(() => {
    const next = splitLiveInputSections(processThoughts, textBlockVersion, conversationInputs, priorSections.current)
    priorSections.current = next.sections
    return next
  }, [processThoughts, textBlockVersion, conversationInputs])
  const bubbleThoughts = useMemo(() => arrivalThoughts.length === 0 ? layout.thoughts : layout.thoughts.filter(thought => !isArrivalThought(thought)), [layout.thoughts, arrivalThoughts.length])
  // Received where the reply has no work beside them — before its first step, or
  // after its last split — they are cards after it until work joins them, as the record draws them.
  const arrivalsOnly = bubbleThoughts.length === 0 && layout.thoughts.length > 0
  const replyThoughts = arrivalsOnly ? EMPTY_THOUGHTS : layout.thoughts
  const trailingArrivals = useMemo(() => !hasOwnThoughts ? arrivalMessages
    : arrivalsOnly ? layout.thoughts.flatMap(thought => isArrivalThought(thought) ? [thought.arrival] : [])
    : EMPTY_MESSAGES, [hasOwnThoughts, arrivalMessages, arrivalsOnly, layout.thoughts])
  return (
    <div className={`animate-fade-in pb-4 ${className}`}>
      {layout.sections.map(section => <ArrivedInputSection key={section.input.message.clientKey ?? section.input.message.id} {...section} embedded={embedded} />)}
      <div className={`${embedded ? 'w-full' : 'w-[85%]'} relative`}>
        {openers?.length ? (
          <ReplyOpeners senderName={senderName} openers={openers} />
        ) : senderName && (
          <div className="mb-2 text-xs font-medium text-muted-foreground">{senderName}</div>
        )}

        {/* Real-time thought process */}
        {(replyThoughts.length > 0 || isThinking) && (
          <ThoughtProcess thoughts={replyThoughts} isThinking={isThinking} embedded={embedded} />
        )}

        {/* The model request failed and is waiting to be sent again */}
        {apiRetry && <ApiRetryNotice retry={apiRetry} onStop={onStop} />}

        {/* Real-time browser task card */}
        {browserToolCalls.length > 0 && (
          <div className="mb-4">
            <BrowserTaskCard
              browserToolCalls={browserToolCalls}
              isActive={isThinking}
              showViewButton={showBrowserViewButton}
            />
          </div>
        )}

        {/* Real-time terminal task card */}
        {terminalToolCalls.length > 0 && (
          <div className="mb-4">
            <TerminalTaskCard
              terminalToolCalls={terminalToolCalls}
              isActive={isThinking}
              showOpenButton={showTerminalOpenButton}
            />
          </div>
        )}

        {/* Streaming text content with scroll animation */}
        <StreamingBubble
          key={conversationInputs.at(-1)?.message.id ?? 'reply'}
          content={streamingContent.slice(layout.textOffset)}
          isStreaming={isStreaming}
          thoughts={bubbleThoughts}
          textBlockVersion={textBlockVersion}
        />

        {/* AskUserQuestion card — shown when AI needs user input */}
        {pendingQuestion && onAnswerQuestion && (
          <AskUserQuestionCard
            pendingQuestion={pendingQuestion}
            onAnswer={onAnswerQuestion}
          />
        )}

        {injectionMessages.length > 0 && <InjectionAnnotation messages={injectionMessages} />}

        {trailingArrivals.length > 0 && (
          <div className="mt-3 space-y-2">
            {trailingArrivals.map(message => <ArrivalCard key={message.clientKey ?? message.id} message={message} />)}
          </div>
        )}

        {/* Mid-turn queued messages — shown while user types during active generation */}
        <QueuedMessagesPanel messages={queuedMessages} />
      </div>
    </div>
  )
}
