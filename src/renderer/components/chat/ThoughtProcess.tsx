/**
 * ThoughtProcess - Displays agent reasoning process in real-time
 * Shows thinking, tool usage, and intermediate results as they happen
 *
 * TodoWrite is rendered separately at the bottom (above "processing...")
 * to keep it always visible and avoid duplicate renders
 */

import { useState, useRef, useEffect, useMemo, memo } from 'react'
import {
  Lightbulb,
  Braces,
  CheckCircle2,
  MessageSquare,
  Info,
  XCircle,
  Check,
  Zap,
  ChevronDown,
  Loader2,
} from 'lucide-react'
import { getToolIcon } from '../icons/ToolIcons'
import { TodoCard, parseTodoInput } from '../tool/TodoCard'
import type { Thought } from '../../types'
import { useTranslation } from '../../i18n'

interface ThoughtProcessProps {
  thoughts: Thought[]
  isThinking: boolean
}

// Get icon component for thought type
function getThoughtIcon(type: Thought['type'], toolName?: string) {
  switch (type) {
    case 'thinking':
      return Lightbulb
    case 'tool_use':
      return toolName ? getToolIcon(toolName) : Braces
    case 'tool_result':
      return CheckCircle2
    case 'text':
      return MessageSquare
    case 'system':
      return Info
    case 'error':
      return XCircle
    case 'result':
      return Check
    default:
      return Zap
  }
}

// Get color class for thought type
function getThoughtColor(type: Thought['type'], isError?: boolean): string {
  if (isError) return 'text-destructive'

  switch (type) {
    case 'thinking':
      return 'text-blue-400'
    case 'tool_use':
      return 'text-amber-400'
    case 'tool_result':
      return 'text-green-400'
    case 'text':
      return 'text-foreground'
    case 'system':
      return 'text-muted-foreground'
    case 'error':
      return 'text-destructive'
    case 'result':
      return 'text-primary'
    default:
      return 'text-muted-foreground'
  }
}

// Get label for thought type - returns translation key
function getThoughtLabelKey(type: Thought['type']): string {
  switch (type) {
    case 'thinking':
      return 'Thinking'
    case 'tool_use':
      return 'Tool call'
    case 'tool_result':
      return 'Tool result'
    case 'text':
      return 'AI'
    case 'system':
      return 'System'
    case 'error':
      return 'Error'
    case 'result':
      return 'Complete'
    default:
      return 'AI'
  }
}

// Get human-friendly action summary for collapsed header (isThinking=true only)
// Shows what the agent is currently doing with key details (filename, command, etc.)
// Returns { key: translationKey, params: interpolation params }
function getActionSummaryData(thoughts: Thought[]): { key: string; params?: Record<string, unknown> } {
  // Search from end to find the most recent action
  for (let i = thoughts.length - 1; i >= 0; i--) {
    const t = thoughts[i]
    if (t.type === 'tool_use' && t.toolName) {
      const input = t.toolInput
      switch (t.toolName) {
        case 'Read': return { key: 'Reading {{file}}...', params: { file: extractFileName(input?.file_path) } }
        case 'Write': return { key: 'Writing {{file}}...', params: { file: extractFileName(input?.file_path) } }
        case 'Edit': return { key: 'Editing {{file}}...', params: { file: extractFileName(input?.file_path) } }
        case 'Grep': return { key: 'Searching {{pattern}}...', params: { pattern: extractSearchTerm(input?.pattern) } }
        case 'Glob': return { key: 'Matching {{pattern}}...', params: { pattern: extractSearchTerm(input?.pattern) } }
        case 'Bash': return { key: 'Executing {{command}}...', params: { command: extractCommand(input?.command) } }
        case 'WebFetch': return { key: 'Fetching {{url}}...', params: { url: extractUrl(input?.url) } }
        case 'WebSearch': return { key: 'Searching {{query}}...', params: { query: extractSearchTerm(input?.query) } }
        case 'TodoWrite': return { key: 'Updating tasks...' }
        case 'Task': return { key: 'Executing {{task}}...', params: { task: extractSearchTerm(input?.description) } }
        case 'NotebookEdit': return { key: 'Editing {{file}}...', params: { file: extractFileName(input?.notebook_path) } }
        case 'AskUserQuestion': return { key: 'Waiting for user response...' }
        default: return { key: 'Processing...' }
      }
    }
    // If most recent is thinking, show thinking status
    if (t.type === 'thinking') {
      return { key: 'Thinking...' }
    }
  }
  return { key: 'Thinking...' }
}

// Extract filename from path (e.g., "/foo/bar/config.json" -> "config.json")
function extractFileName(path: unknown): string {
  if (typeof path !== 'string' || !path) return 'file'
  const name = path.split('/').pop() || path.split('\\').pop() || path
  return truncateText(name, 20)
}

// Extract command summary (e.g., "npm install lodash --save" -> "npm install...")
function extractCommand(cmd: unknown): string {
  if (typeof cmd !== 'string' || !cmd) return 'command'
  // Get first part of command (before first space or first 20 chars)
  const firstPart = cmd.split(' ').slice(0, 2).join(' ')
  return truncateText(firstPart, 20)
}

// Extract search term or pattern
function extractSearchTerm(term: unknown): string {
  if (typeof term !== 'string' || !term) return '...'
  return truncateText(term, 15)
}

// Extract domain from URL
function extractUrl(url: unknown): string {
  if (typeof url !== 'string' || !url) return 'page'
  try {
    const domain = new URL(url).hostname.replace('www.', '')
    return truncateText(domain, 20)
  } catch {
    return truncateText(url, 20)
  }
}

// Truncate text with ellipsis if too long
function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return text.substring(0, maxLength - 1) + '…'
}

// Timer display component to isolate re-renders
function TimerDisplay({ startTime, isThinking }: { startTime: number | null; isThinking: boolean }) {
  const [elapsedTime, setElapsedTime] = useState(0)
  const requestRef = useRef<number>()

  useEffect(() => {
    if (!startTime) return

    const animate = () => {
      setElapsedTime((Date.now() - startTime) / 1000)
      
      if (isThinking) {
        requestRef.current = requestAnimationFrame(animate)
      }
    }

    if (isThinking) {
      requestRef.current = requestAnimationFrame(animate)
    } else {
      // If not thinking, just update once to show ©∫final time
      setElapsedTime((Date.now() - startTime) / 1000)
    }

    return () => {
      if (requestRef.current) {
        cancelAnimationFrame(requestRef.current)
      }
    }
  }, [isThinking, startTime])

  return <span>{elapsedTime.toFixed(1)}s</span>
}

// Individual thought item (for non-special tools)
const ThoughtItem = memo(function ThoughtItem({ thought, isLast }: { thought: Thought; isLast: boolean }) {
  const [isExpanded, setIsExpanded] = useState(false)
  const { t } = useTranslation()
  const color = getThoughtColor(thought.type, thought.isError)
  const Icon = getThoughtIcon(thought.type, thought.toolName)

  // Truncate content for display
  const maxPreviewLength = 150
  const content = thought.type === 'tool_use'
    ? `${thought.toolName}: ${JSON.stringify(thought.toolInput || {}).substring(0, 100)}`
    : thought.type === 'tool_result'
      ? (thought.toolOutput || '').substring(0, 200)
      : thought.content

  const needsTruncate = content.length > maxPreviewLength
  const displayContent = isExpanded ? content : content.substring(0, maxPreviewLength)

  return (
    <div className="flex gap-3 group animate-fade-in">
      {/* Timeline line */}
      <div className="flex flex-col items-center">
        <div className={`w-7 h-7 rounded-full flex items-center justify-center ${
          thought.isError ? 'bg-destructive/20' : 'bg-primary/10'
        } ${color}`}>
          <Icon size={14} />
        </div>
        {!isLast && (
          <div className="w-0.5 flex-1 bg-border/30 mt-1" />
        )}
      </div>

      {/* Content */}
      <div className="flex-1 pb-4 min-w-0">
        {/* Header */}
        <div className="flex items-center gap-2 mb-1">
          <span className={`text-xs font-medium ${color}`}>
            {t(getThoughtLabelKey(thought.type))}
            {thought.toolName && ` - ${thought.toolName}`}
          </span>
          <span className="text-xs text-muted-foreground/50">
            {new Date(thought.timestamp).toLocaleTimeString('zh-CN', {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit'
            })}
          </span>
          {thought.duration && (
            <span className="text-xs text-muted-foreground/40">
              ({(thought.duration / 1000).toFixed(1)}s)
            </span>
          )}
        </div>

        {/* Content */}
        {content && (
          <div
            className={`text-sm ${
              thought.type === 'thinking' ? 'text-muted-foreground/70 italic' : 'text-foreground/80'
            } whitespace-pre-wrap break-words`}
          >
            {displayContent}
            {needsTruncate && !isExpanded && '...'}
          </div>
        )}

        {/* Expand button */}
        {needsTruncate && (
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="text-xs text-primary/60 hover:text-primary mt-1 transition-colors"
          >
            {isExpanded ? t('Collapse') : t('Expand')}
          </button>
        )}

        {/* Tool input details (expandable) */}
        {thought.type === 'tool_use' && thought.toolInput && isExpanded && (
          <pre className="mt-2 p-2 rounded bg-muted/30 text-xs text-muted-foreground overflow-x-auto">
            {JSON.stringify(thought.toolInput, null, 2)}
          </pre>
        )}
      </div>
    </div>
  )
})

export function ThoughtProcess({ thoughts, isThinking }: ThoughtProcessProps) {
  // Default collapsed - like ChatGPT, less intrusive
  const [isExpanded, setIsExpanded] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const { t } = useTranslation()

  // Calculate elapsed time from first thought's timestamp
  // This is more reliable than tracking component mount time
  const startTime = useMemo(() => {
    if (thoughts.length > 0) {
      return new Date(thoughts[0].timestamp).getTime()
    }
    return null
  }, [thoughts.length > 0 ? thoughts[0]?.timestamp : null])

  // Get latest todo data (only render one TodoCard at bottom)
  const latestTodos = useMemo(() => {
    // Find all TodoWrite tool calls and get the latest one
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
      // Exclude TodoWrite tool_use and tool_result (shown separately at bottom)
      if (t.toolName === 'TodoWrite') return false
      return true
    })
  }, [thoughts])

  // Auto-scroll to bottom when new thoughts arrive
  useEffect(() => {
    if (isExpanded && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight
    }
  }, [thoughts, isExpanded])

  // Don't render if no thoughts and not thinking
  if (thoughts.length === 0 && !isThinking) {
    return null
  }

  // Only count system-level errors (type: 'error'), not tool execution failures (tool_result with isError)
  // Tool failures are normal during agent investigation and should not affect overall status
  const errorCount = thoughts.filter(t => t.type === 'error').length

  // Check if there's content to show in the scrollable area
  const hasDisplayContent = displayThoughts.length > 0

  return (
    <div className="animate-fade-in mb-4">
      <div
        className={`
          relative rounded-xl border overflow-hidden transition-all duration-300
          ${isThinking
            ? 'border-primary/40 bg-primary/5'
            : errorCount > 0
              ? 'border-destructive/30 bg-destructive/5'
              : 'border-border/50 bg-card/30'
          }
        `}
      >
        {/* Header */}
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white/5 transition-colors"
        >
          {/* Status indicator */}
          {isThinking ? (
            <Loader2 size={16} className="text-primary animate-spin" />
          ) : (
            <CheckCircle2
              size={16}
              className={errorCount > 0 ? 'text-destructive' : 'text-primary'}
            />
          )}

          {/* Title: action summary when thinking, "Thought process" when done */}
          <span className={`text-sm font-medium ${isThinking ? 'text-primary' : 'text-foreground'}`}>
            {isThinking ? (() => {
              const data = getActionSummaryData(thoughts)
              return t(data.key, data.params)
            })() : t('Thought process')}
          </span>

          {/* Stats: only show elapsed time when thinking is complete */}
          {!isThinking && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground/60">
              <TimerDisplay startTime={startTime} isThinking={isThinking} />
            </div>
          )}

          {/* Spacer */}
          <div className="flex-1" />

          {/* Expand icon */}
          <ChevronDown
            size={16}
            className={`text-muted-foreground transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
          />
        </button>

        {/* Content */}
        {isExpanded && (
          <div className="border-t border-border/30">
            {/* Scrollable thought items */}
            {hasDisplayContent && (
              <div
                ref={contentRef}
                className="px-4 pt-3 max-h-[300px] overflow-y-auto"
              >
                {displayThoughts.map((thought, index) => (
                  <ThoughtItem
                    key={thought.id}
                    thought={thought}
                    isLast={index === displayThoughts.length - 1 && !latestTodos && !isThinking}
                  />
                ))}
              </div>
            )}

            {/* TodoCard - fixed at bottom, only one instance */}
            {latestTodos && latestTodos.length > 0 && (
              <div className={`px-4 ${hasDisplayContent ? 'pt-2' : 'pt-3'} pb-3`}>
                <TodoCard todos={latestTodos} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
