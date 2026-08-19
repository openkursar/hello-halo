/**
 * StreamingSection - Renders the real-time streaming content area.
 *
 * Pure presentational component — no store coupling. Composes
 * ThoughtProcess + BrowserTaskCard + StreamingBubble + AskUserQuestionCard.
 *
 * Shared across: MessageList (main chat), AppChatView, ImChatView.
 */

import { ThoughtProcess } from './ThoughtProcess'
import { StreamingBubble } from './StreamingBubble'
import { BrowserTaskCard } from '../tool/BrowserTaskCard'
import { TerminalTaskCard } from '../tool/TerminalTaskCard'
import { AskUserQuestionCard } from './AskUserQuestionCard'
import { TeamPanel } from './TeamPanel'
import { QueuedMessagesPanel } from './QueuedMessagesPanel'
import type { Thought, PendingQuestion } from '../../types'
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
   *  Set false in automation app contexts where Canvas/BrowserView is unavailable. */
  showBrowserViewButton?: boolean

  /** Active question from AskUserQuestion tool */
  pendingQuestion?: PendingQuestion | null

  /** Callback when user answers a pending question */
  onAnswerQuestion?: (answers: Record<string, string>) => void

  /** Additional className for the outer wrapper */
  className?: string

  /** Messages queued for mid-turn injection (shown below StreamingBubble) */
  queuedMessages?: string[]
}

export function StreamingSection({
  streamingContent,
  isStreaming,
  thoughts,
  isThinking,
  textBlockVersion = 0,
  browserToolCalls = [],
  terminalToolCalls = [],
  showBrowserViewButton = true,
  pendingQuestion,
  onAnswerQuestion,
  className = '',
  queuedMessages = [],
}: StreamingSectionProps) {
  return (
    <div className={`flex justify-start animate-fade-in pb-4 ${className}`}>
      <div className="w-[85%] relative">
        {/* Real-time thought process */}
        {(thoughts.length > 0 || isThinking) && (
          <ThoughtProcess thoughts={thoughts} isThinking={isThinking} />
        )}

        {/* Agent Team panel — multi-agent collaboration status */}
        <TeamPanel thoughts={thoughts} />

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
              showOpenButton={showBrowserViewButton}
            />
          </div>
        )}

        {/* Streaming text content with scroll animation */}
        <StreamingBubble
          content={streamingContent}
          isStreaming={isStreaming}
          thoughts={thoughts}
          textBlockVersion={textBlockVersion}
        />

        {/* AskUserQuestion card — shown when AI needs user input */}
        {pendingQuestion && onAnswerQuestion && (
          <AskUserQuestionCard
            pendingQuestion={pendingQuestion}
            onAnswer={onAnswerQuestion}
          />
        )}

        {/* Mid-turn queued messages — shown while user types during active generation */}
        <QueuedMessagesPanel messages={queuedMessages} />
      </div>
    </div>
  )
}
