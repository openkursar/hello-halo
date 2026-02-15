/**
 * MessageItem - Single message display with enhanced streaming visualization
 * Includes collapsible thought process and file changes footer for assistant messages
 *
 * Working State Design:
 * - During generation: subtle breathing glow + "AI working" indicator
 * - The indicator is gentle, not intrusive, letting user focus on content
 * - When complete: indicator fades out smoothly
 */

import { useState, useMemo, useCallback, memo } from 'react'
import {
  Lightbulb,
  Wrench,
  CheckCircle2,
  XCircle,
  Info,
  FileText,
  ChevronRight,
  Sparkles,
  Copy,
  Check,
  Loader2,
} from 'lucide-react'
import { getToolIcon } from '../icons/ToolIcons'
import { BrowserTaskCard, isBrowserTool } from '../tool/BrowserTaskCard'
import { MarkdownRenderer } from './MarkdownRenderer'
import { FileChangesFooter } from '../diff'
import { MessageImages } from './ImageAttachmentPreview'
import { TokenUsageIndicator } from './TokenUsageIndicator'
import { truncateText, getToolFriendlyFormat } from './thought-utils'
import type { Message, Thought, ThoughtsSummary } from '../../types'
import { useTranslation } from '../../i18n'
import { useChatStore } from '../../stores/chat.store'

interface MessageItemProps {
  message: Message
  previousCost?: number  // Previous message's cumulative cost
  hideThoughts?: boolean
  isInContainer?: boolean
  isWorking?: boolean  // True when AI is still generating (not yet complete)
  isWaitingMore?: boolean  // True when content paused (e.g., during tool call), show "..." animation
}

// Collapsible thought history component
// Supports both inline thoughts (Thought[]) and lazy-loaded thoughts (null + summary)
interface ThoughtHistoryProps {
  thoughts: Thought[] | null
  thoughtsSummary?: ThoughtsSummary
  onLoadThoughts?: () => Promise<Thought[]>
}

function ThoughtHistory({ thoughts, thoughtsSummary, onLoadThoughts }: ThoughtHistoryProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [loadedThoughts, setLoadedThoughts] = useState<Thought[] | null>(null)
  const { t } = useTranslation()

  // Use loaded thoughts if available, otherwise inline thoughts
  const resolvedThoughts = loadedThoughts ?? thoughts

  // Filter out result type (final reply is in message bubble)
  const displayThoughts = resolvedThoughts
    ? resolvedThoughts.filter(t => t.type !== 'result')
    : null

  // For loaded thoughts, compute stats from actual data
  // For separated thoughts (null), use the summary
  const thinkingCount = displayThoughts
    ? displayThoughts.filter(t => t.type === 'thinking').length
    : (thoughtsSummary?.types.thinking || 0)
  const toolCount = displayThoughts
    ? displayThoughts.filter(t => t.type === 'tool_use').length
    : (thoughtsSummary?.types.tool_use || 0)
  const totalCount = displayThoughts
    ? displayThoughts.length
    : ((thoughtsSummary?.count || 0) - (thoughtsSummary?.types.result || 0))

  // Nothing to show
  if (totalCount === 0) return null

  const handleToggle = async () => {
    if (!isExpanded && thoughts === null && !loadedThoughts && onLoadThoughts) {
      // Lazy load thoughts from separated storage
      setIsLoading(true)
      try {
        const loaded = await onLoadThoughts()
        setLoadedThoughts(loaded)
      } catch (err) {
        console.error('[ThoughtHistory] Failed to load thoughts:', err)
      } finally {
        setIsLoading(false)
      }
    }
    setIsExpanded(!isExpanded)
  }

  return (
    <div className="mt-3 border-t border-border/30 pt-2">
      <button
        onClick={handleToggle}
        className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors w-full"
        disabled={isLoading}
      >
        {isLoading ? (
          <Loader2 size={12} className="animate-spin" />
        ) : (
          <ChevronRight
            size={12}
            className={`transition-transform ${isExpanded ? 'rotate-90' : ''}`}
          />
        )}
        <span>{t('View thought process')}</span>
        <span className="text-muted-foreground/50">
          ({thinkingCount > 0 && `${thinkingCount} ${t('thoughts')}`}
          {thinkingCount > 0 && toolCount > 0 && ', '}
          {toolCount > 0 && `${toolCount} ${t('tools')}`})
        </span>
      </button>

      {isExpanded && displayThoughts && (
        <div className="mt-2 space-y-2 animate-slide-down">
          {displayThoughts.map((thought, index) => (
            <ThoughtItem key={`${thought.id}-${index}`} thought={thought} />
          ))}
        </div>
      )}
    </div>
  )
}


// Format tool result output for display
function formatResultOutput(output: string, maxLen = 300) {
  if (!output) return ''
  try {
    const parsed = JSON.parse(output)
    const formatted = JSON.stringify(parsed, null, 2)
    return formatted.length > maxLen ? formatted.substring(0, maxLen) + '...' : formatted
  } catch {
    return output.length > maxLen ? output.substring(0, maxLen) + '...' : output
  }
}

// Single thought item
function ThoughtItem({ thought }: { thought: Thought }) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [showResult, setShowResult] = useState(true)  // Default show result
  const { t } = useTranslation()

  // Check if tool has result (merged tool_result)
  const hasToolResult = thought.type === 'tool_use' && thought.toolResult

  const getTypeInfo = () => {
    switch (thought.type) {
      case 'thinking':
        return { label: t('Thinking'), color: 'text-blue-400', Icon: Lightbulb }
      case 'tool_use':
        return {
          label: `${t('Calling')} ${thought.toolName}`,
          color: 'text-amber-400',
          Icon: thought.toolName ? getToolIcon(thought.toolName) : Wrench
        }
      case 'tool_result':
        return {
          label: t('Tool result'),
          color: thought.isError ? 'text-red-400' : 'text-green-400',
          Icon: thought.isError ? XCircle : CheckCircle2
        }
      case 'system':
        return { label: t('System'), color: 'text-muted-foreground', Icon: Info }
      case 'error':
        return { label: t('Error'), color: 'text-red-400', Icon: XCircle }
      default:
        return { label: thought.type, color: 'text-muted-foreground', Icon: FileText }
    }
  }

  const info = getTypeInfo()
  // Use friendly format for tool_use
  const content = thought.type === 'tool_use'
    ? getToolFriendlyFormat(thought.toolName || '', thought.toolInput)
    : thought.type === 'tool_result'
      ? thought.toolOutput
      : thought.content

  const previewLength = 100
  const needsTruncate = content && content.length > previewLength

  return (
    <div className="flex gap-2 text-xs">
      <info.Icon size={14} className={info.color} />
      <div className="flex-1 min-w-0">
        <span className={`font-medium ${info.color}`}>{info.label}</span>
        {content && (
          <div className="mt-0.5 text-muted-foreground/70">
            <span className="whitespace-pre-wrap break-words">
              {isExpanded || !needsTruncate ? content : content.substring(0, previewLength) + '...'}
            </span>
            {needsTruncate && (
              <button
                onClick={() => setIsExpanded(!isExpanded)}
                className="ml-1 text-primary/60 hover:text-primary"
              >
                {isExpanded ? t('Collapse') : t('Expand')}
              </button>
            )}
          </div>
        )}
        {/* Show/Hide result button for tool_use with result */}
        {hasToolResult && thought.toolResult!.output && (
          <div className="mt-1">
            <button
              onClick={() => setShowResult(!showResult)}
              className="text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors"
            >
              {showResult ? t('Hide result') : t('Show result')}
            </button>
            {showResult && (
              <div className={`mt-1 p-1.5 rounded text-[10px] overflow-x-auto ${
                thought.toolResult!.isError
                  ? 'bg-destructive/10 text-destructive'
                  : 'bg-muted/30 text-muted-foreground'
              }`}>
                <pre className="whitespace-pre-wrap break-words">
                  {formatResultOutput(thought.toolResult!.output, isExpanded ? 10000 : 300)}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export const MessageItem = memo(function MessageItem({ message, previousCost = 0, hideThoughts = false, isInContainer = false, isWorking = false, isWaitingMore = false }: MessageItemProps) {
  const isUser = message.role === 'user'
  const isStreaming = (message as any).isStreaming
  const [copied, setCopied] = useState(false)
  const { t } = useTranslation()
  const { loadMessageThoughts, currentSpaceId, currentConversationId } = useChatStore(s => ({
    loadMessageThoughts: s.loadMessageThoughts,
    currentSpaceId: s.currentSpaceId,
    currentConversationId: s.getCurrentSpaceState().currentConversationId,
  }))

  // Whether thoughts are stored separately (null = separated, not yet loaded)
  const hasThoughts = Array.isArray(message.thoughts) && message.thoughts.length > 0
  const hasSeparatedThoughts = message.thoughts === null && !!message.thoughtsSummary

  // Handle copying message content to clipboard
  const handleCopyMessage = useCallback(async () => {
    if (!message.content) return
    try {
      await navigator.clipboard.writeText(message.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy message:', err)
    }
  }, [message.content])

  // Extract browser tools from thoughts (tool_use type with browser tool names)
  // Note: Tool calls are stored in thoughts, not in message.toolCalls
  // When thoughts are stored separately (null), browser tools won't show until thoughts are loaded
  const browserToolCalls = useMemo(() => {
    if (!Array.isArray(message.thoughts)) return []
    return message.thoughts
      .filter(t => t.type === 'tool_use' && t.toolName && isBrowserTool(t.toolName))
      .map(t => ({
        id: t.id,
        name: t.toolName!,
        status: 'success' as const,  // Thoughts are recorded after completion
        input: t.toolInput || {},
      }))
  }, [message.thoughts])

  // Check if there are running browser tools (based on isWorking state)
  const hasBrowserActivity = isWorking && browserToolCalls.length > 0

  // Error-only message (no content): render standalone error block without bubble wrapper
  const isErrorOnly = !isUser && !message.content && !!message.error && !isWorking

  // Message bubble content
  const bubble = isErrorOnly ? (
    <div className={`${!isInContainer ? 'w-[85%]' : 'w-full'}`}>
      <div className="rounded-2xl px-4 py-3 bg-destructive/10 border border-destructive/30">
        <div className="flex items-center gap-2 text-destructive">
          <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span className="text-sm font-medium">{t('Something went wrong')}</span>
        </div>
        <p className="mt-1.5 text-sm text-destructive/80">{message.error}</p>
      </div>
    </div>
  ) : (
    <div
      className={`rounded-2xl px-4 py-3 ${
        isUser ? 'message-user' : 'message-assistant'
      } ${isStreaming ? 'streaming-message' : ''} ${isWorking ? 'message-working' : ''} ${!isInContainer ? 'max-w-[85%]' : 'w-full'}`}
    >
      {/* Working indicator - shows when AI is working */}
      {isWorking && !isUser && (
        <div className="flex items-center gap-1.5 mb-2 pb-2 border-b border-border/30 working-indicator-fade">
          <Sparkles size={12} className="text-primary/60 animate-pulse-gentle" />
          <span className="text-xs text-muted-foreground/70">{t('Halo is working')}</span>
        </div>
      )}

      {/* User message images (displayed before text) */}
      {isUser && message.images && message.images.length > 0 && (
        <MessageImages images={message.images} />
      )}

      {/* Message content with streaming cursor */}
      <div className="break-words leading-relaxed" data-message-content>
        {message.content && (
          isUser ? (
            // User messages: simple whitespace-preserving text
            <span className="whitespace-pre-wrap">{message.content}</span>
          ) : (
            // Assistant messages: full markdown rendering
            <MarkdownRenderer content={message.content} />
          )
        )}
        {/* Streaming cursor when actively receiving tokens */}
        {isStreaming && (
          <span className="inline-block w-0.5 h-5 ml-0.5 bg-primary streaming-cursor align-middle" />
        )}
        {/* Waiting dots when content paused but still working (e.g., tool call in progress) */}
        {isWaitingMore && !isStreaming && (
          <span className="waiting-dots ml-1 text-muted-foreground/60" />
        )}
      </div>

      {/* Persisted error - shown for assistant messages that failed (e.g., 429 rate limit) */}
      {!isUser && message.error && (
        <div className="mt-2 rounded-xl px-3 py-2.5 bg-destructive/10 border border-destructive/30">
          <div className="flex items-center gap-2 text-destructive">
            <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span className="text-sm font-medium">{t('Something went wrong')}</span>
          </div>
          <p className="mt-1.5 text-sm text-destructive/80">{message.error}</p>
        </div>
      )}

      {/* Browser task card - browser tools displayed separately */}
      {browserToolCalls.length > 0 && (
        <BrowserTaskCard
          browserToolCalls={browserToolCalls}
          isActive={isWorking || hasBrowserActivity}
        />
      )}

      {/* Thought history - only for assistant messages with thoughts (when not hidden) */}
      {/* Supports both inline thoughts (v1/loaded) and separated thoughts (v2, lazy loaded on expand) */}
      {!hideThoughts && !isUser && (hasThoughts || hasSeparatedThoughts) && (
        <ThoughtHistory
          thoughts={message.thoughts ?? null}
          thoughtsSummary={message.thoughtsSummary}
          onLoadThoughts={
            hasSeparatedThoughts && currentSpaceId && currentConversationId
              ? () => loadMessageThoughts(currentSpaceId, currentConversationId, message.id)
              : undefined
          }
        />
      )}

      {/* File changes footer - shows immediately from metadata, or from loaded thoughts */}
      {/* Diff content is lazy-loaded from thoughts when user clicks a file */}
      {!isUser && (message.metadata?.fileChanges || hasThoughts) && (
        <FileChangesFooter
          fileChangesSummary={message.metadata?.fileChanges}
          thoughts={message.thoughts}
          onLoadThoughts={
            hasSeparatedThoughts && currentSpaceId && currentConversationId
              ? () => loadMessageThoughts(currentSpaceId, currentConversationId, message.id)
              : undefined
          }
        />
      )}

      {/* Token usage indicator + copy button - only for completed assistant messages with tokenUsage */}
      {!isUser && !isWorking && message.tokenUsage && (
        <div className="flex justify-end items-center gap-2 mt-2 pt-1">
          {/* Token usage indicator */}
          <TokenUsageIndicator tokenUsage={message.tokenUsage} previousCost={previousCost} />

          {/* Copy button */}
          <button
            onClick={handleCopyMessage}
            className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground/60
              hover:text-foreground hover:bg-white/5 rounded-md transition-all"
            title={t('Copy message')}
          >
            {copied ? (
              <>
                <Check size={14} className="text-green-400" />
                <span className="text-green-400">{t('Copied')}</span>
              </>
            ) : (
              <Copy size={14} />
            )}
          </button>
        </div>
      )}
    </div>
  )

  // When in container, just return the bubble without wrapper
  if (isInContainer) {
    // Even in container, we need data-message-id for search navigation
    return (
      <div data-message-id={message.id}>
        {bubble}
      </div>
    )
  }

  // Normal case: wrap with flex container
  return (
    <div
      className={`flex ${isUser ? 'justify-end' : 'justify-start'} animate-fade-in`}
      data-message-id={message.id}
    >
      {bubble}
    </div>
  )
})
