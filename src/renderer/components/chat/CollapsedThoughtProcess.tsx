/**
 * CollapsedThoughtProcess - Displays saved thought history above completed messages
 * Collapsed by default, expandable to show full details
 *
 * TodoWrite is rendered separately at the bottom (only one instance)
 */

import { useState, useMemo, useRef, type RefObject } from 'react'
import {
  Lightbulb,
  Loader2,
  XCircle,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  Braces,
} from 'lucide-react'
import { TodoCard, parseTodoInput } from '../tool/TodoCard'
import { ToolResultViewer } from './tool-result'
import {
  getThoughtIcon,
  getThoughtColor,
  getThoughtLabelKey,
  getToolFriendlyFormat,
} from './thought-utils'
import { useLazyVisible } from '../../hooks/useLazyVisible'
import type { Thought, ThoughtsSummary } from '../../types'
import { getCurrentLanguage, useTranslation } from '../../i18n'

interface CollapsedThoughtProcessProps {
  thoughts: Thought[]
  defaultExpanded?: boolean
}


// Single thought item in expanded view
function ThoughtItem({ thought }: { thought: Thought }) {
  const { t } = useTranslation()
  const [showRawJson, setShowRawJson] = useState(false)
  const [showResult, setShowResult] = useState(true)  // Default show result
  const [isContentExpanded, setIsContentExpanded] = useState(false)  // For thinking content expand
  const color = getThoughtColor(thought.type, thought.isError)
  const Icon = getThoughtIcon(thought.type, thought.toolName)

  // Check if tool has result (merged tool_result)
  const hasToolResult = thought.type === 'tool_use' && thought.toolResult

  // Use friendly format for tool_use, raw content for others
  const content = thought.type === 'tool_use'
    ? getToolFriendlyFormat(thought.toolName || '', thought.toolInput)
    : thought.type === 'tool_result'
      ? (thought.toolOutput || '').substring(0, 200)
      : thought.content

  const maxLen = 120
  const needsTruncate = content.length > maxLen

  return (
    <div className="py-1.5 text-xs border-b border-border/20 last:border-b-0">
      {/* First row: Icon + Tool name + Timestamp */}
      <div className="flex items-center gap-2">
        <Icon size={14} className={`${color} shrink-0`} />
        <span className={`font-medium ${color} flex-1 min-w-0 truncate`}>
          {(() => {
            const label = getThoughtLabelKey(thought.type)
            return label === 'AI' ? label : t(label)
          })()}
          {thought.toolName && ` - ${thought.toolName}`}
        </span>
        <span className="text-muted-foreground/40 text-[10px] shrink-0">
          {new Intl.DateTimeFormat(getCurrentLanguage(), {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
          }).format(new Date(thought.timestamp))}
        </span>
      </div>

      {/* Content area with actions on the right */}
      <div className="flex items-end gap-3 mt-0.5 ml-[22px]">
        {/* Content - takes available space */}
        <div className="flex-1 min-w-0">
          {content && (
            <div className="text-muted-foreground/70 whitespace-pre-wrap break-words">
              {isContentExpanded || !needsTruncate ? content : content.substring(0, maxLen) + '...'}
              {thought.type === 'thinking' && needsTruncate && (
                <button
                  onClick={() => setIsContentExpanded(!isContentExpanded)}
                  className="ml-1 text-primary/60 hover:text-primary"
                >
                  {isContentExpanded ? t('Collapse') : t('Expand')}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Actions - right aligned, compact buttons */}
        {((thought.type === 'tool_use' && thought.toolInput && Object.keys(thought.toolInput).length > 0) || hasToolResult) && (
          <div className="flex items-center gap-0.5 shrink-0 text-[10px]">
            {/* Raw JSON button */}
            {thought.type === 'tool_use' && thought.toolInput && Object.keys(thought.toolInput).length > 0 && (
              <button
                onClick={() => setShowRawJson(!showRawJson)}
                className={`
                  flex items-center gap-0.5 px-1 py-px rounded transition-colors
                  ${showRawJson
                    ? 'bg-primary/20 text-primary'
                    : 'text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/50'
                  }
                `}
                title={showRawJson ? t('Hide raw JSON') : t('Show raw JSON')}
              >
                <Braces size={10} />
                {/* No need to display text, simplify visuals. */}
                {/* JSON */}
              </button>
            )}

            {/* Show/Hide result button */}
            {hasToolResult && thought.toolResult!.output && (
              <button
                onClick={() => setShowResult(!showResult)}
                className="flex items-center gap-0.5 px-1 py-px rounded text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/50 transition-colors"
                title={showResult ? t('Hide tool result') : t('Show tool result')}
              >
                {showResult ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                {showResult ? 'Hide' : 'Result'}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Raw JSON display (for tool_use) */}
      {thought.type === 'tool_use' && showRawJson && thought.toolInput && (
        <pre className="mt-2 ml-[22px] p-2 rounded bg-muted/30 text-[10px] text-muted-foreground overflow-x-auto">
          {JSON.stringify(thought.toolInput, null, 2)}
        </pre>
      )}

      {/* Tool result - shown/hidden based on toggle */}
      {hasToolResult && thought.toolResult!.output && showResult && (
        <div className="mt-1.5 ml-[22px]">
          <ToolResultViewer
            toolName={thought.toolName || ''}
            toolInput={thought.toolInput}
            output={thought.toolResult!.output}
            isError={thought.toolResult!.isError}
          />
        </div>
      )}
    </div>
  )
}

// Lazy wrapper for historical thought items — defers rendering until scrolled into view
const COLLAPSED_THOUGHT_ESTIMATED_HEIGHT = 36

function LazyCollapsedThoughtItem({
  thought,
  scrollContainerRef,
}: {
  thought: Thought
  scrollContainerRef: RefObject<HTMLDivElement | null>
}) {
  const [ref, isVisible] = useLazyVisible('150px', scrollContainerRef)

  if (isVisible) {
    return <ThoughtItem thought={thought} />
  }

  return (
    <div ref={ref} style={{ minHeight: COLLAPSED_THOUGHT_ESTIMATED_HEIGHT }} className="border-b border-border/20 last:border-b-0" />
  )
}

export function CollapsedThoughtProcess({ thoughts, defaultExpanded = false }: CollapsedThoughtProcessProps) {
  const { t } = useTranslation()
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)
  const [isMaximized, setIsMaximized] = useState(false)
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  // Get latest todo data (only render one TodoCard at bottom)
  const latestTodos = useMemo(() => {
    const todoThoughts = thoughts.filter(
      t => t.type === 'tool_use' && t.toolName === 'TodoWrite' && t.toolInput
    )
    if (todoThoughts.length === 0) return null

    const latest = todoThoughts[todoThoughts.length - 1]
    return parseTodoInput(latest.toolInput!)
  }, [thoughts])

  // Filter thoughts for display (exclude TodoWrite and its results)
  const displayThoughts = useMemo(() => {
    return thoughts.filter(t => {
      if (t.type === 'result') return false
      if (t.toolName === 'TodoWrite') return false
      return true
    })
  }, [thoughts])

  // Check if there's anything to show
  const hasContent = displayThoughts.length > 0 || (latestTodos && latestTodos.length > 0)
  if (!hasContent) return null

  // Only count system-level errors, not tool execution failures
  const errorCount = thoughts.filter(t => t.type === 'error').length

  // Calculate duration from first to last thought
  const duration = useMemo(() => {
    if (thoughts.length < 1) return 0
    const first = new Date(thoughts[0].timestamp).getTime()
    const last = new Date(thoughts[thoughts.length - 1].timestamp).getTime()
    return (last - first) / 1000
  }, [thoughts])

  return (
    <div className="mb-2">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className={`
          flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs
          transition-all duration-200 w-full
          ${isExpanded
            ? 'bg-primary/10 border border-primary/30'
            : 'bg-muted/30 hover:bg-muted/50 border border-transparent'
          }
        `}
      >
        {/* Expand icon */}
        <ChevronRight
          size={12}
          className={`text-muted-foreground transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}
        />

        {/* Icon */}
        {errorCount > 0 ? (
          <XCircle size={14} className="text-destructive" />
        ) : (
          <Lightbulb size={14} className="text-primary" />
        )}

        {/* Label */}
        <span className="text-muted-foreground">{t('Thought process')}</span>

        {/* Stats: time only (file changes moved to message bubble footer) */}
        <div className="flex items-center gap-1.5 text-muted-foreground/60">
          <span>{duration.toFixed(1)}s</span>
        </div>
      </button>

      {/* Expanded content */}
      {isExpanded && (
        <div className="mt-1 py-2 bg-muted/20 rounded-lg border border-border/30 animate-slide-down thought-content">
          {/* Thought items — lazy-loaded: only items near the scroll viewport are rendered */}
          {displayThoughts.length > 0 && (
            <div ref={scrollContainerRef} className={`${isMaximized ? 'max-h-[80vh]' : 'max-h-[300px]'} scrollbar-overlay px-3 transition-all duration-200`}>
              {displayThoughts.map((thought, index) => (
                <LazyCollapsedThoughtItem
                  key={`${thought.id}-${index}`}
                  thought={thought}
                  scrollContainerRef={scrollContainerRef}
                />
              ))}
            </div>
          )}

          {/* TodoCard at bottom - only one instance */}
          {latestTodos && latestTodos.length > 0 && (
            <div className={`px-3 ${displayThoughts.length > 0 ? 'mt-2 pt-2 border-t border-border/20' : ''}`}>
              <TodoCard todos={latestTodos} isAgentActive={false} />
            </div>
          )}

          {/* Maximize toggle - bottom right, heuristic: show when likely to overflow */}
          {(displayThoughts.length > 8 || isMaximized) && (
            <div className="flex justify-end px-3 mt-1">
              <button
                onClick={() => setIsMaximized(!isMaximized)}
                className="flex items-center gap-0.5 px-1 py-px rounded text-xs text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted/50 transition-colors"
                title={isMaximized ? t('Compact view') : t('Full view')}
              >
                {isMaximized ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                {isMaximized ? 'Compact' : 'Full'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * LazyCollapsedThoughtProcess - For separated thoughts (v2 format).
 * Shows a collapsed summary bar initially, loads full thoughts on first expand,
 * then renders the full CollapsedThoughtProcess.
 */
interface LazyCollapsedThoughtProcessProps {
  thoughtsSummary: ThoughtsSummary
  onLoadThoughts: () => Promise<Thought[]>
}

export function LazyCollapsedThoughtProcess({ thoughtsSummary, onLoadThoughts }: LazyCollapsedThoughtProcessProps) {
  const { t } = useTranslation()
  const [loadedThoughts, setLoadedThoughts] = useState<Thought[] | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  // Once loaded, render expanded — user explicitly clicked to load thoughts
  if (loadedThoughts) {
    return <CollapsedThoughtProcess thoughts={loadedThoughts} defaultExpanded />
  }

  const duration = thoughtsSummary.duration

  const handleClick = async () => {
    console.log('[LazyCollapsedThoughtProcess] User clicked to load thoughts')
    setIsLoading(true)
    try {
      const thoughts = await onLoadThoughts()
      console.log(`[LazyCollapsedThoughtProcess] Loaded ${thoughts.length} thoughts, rendering full view`)
      setLoadedThoughts(thoughts)
    } catch (err) {
      console.error('[LazyCollapsedThoughtProcess] Failed to load thoughts:', err)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="mb-2">
      <button
        onClick={handleClick}
        disabled={isLoading}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs transition-all duration-200 w-full bg-muted/30 hover:bg-muted/50 border border-transparent"
      >
        {isLoading ? (
          <Loader2 size={12} className="text-muted-foreground animate-spin" />
        ) : (
          <ChevronRight size={12} className="text-muted-foreground" />
        )}
        <Lightbulb size={14} className="text-primary" />
        <span className="text-muted-foreground">{t('Thought process')}</span>
        <div className="flex items-center gap-1.5 text-muted-foreground/60">
          {duration != null && <span>{duration.toFixed(1)}s</span>}
        </div>
      </button>
    </div>
  )
}
