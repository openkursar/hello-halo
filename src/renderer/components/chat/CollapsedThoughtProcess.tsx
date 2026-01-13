/**
 * CollapsedThoughtProcess - Displays saved thought history above completed messages
 * Collapsed by default, expandable to show full details
 *
 * TodoWrite is rendered separately at the bottom (only one instance)
 */

import { useState, useMemo } from 'react'
import {
  Lightbulb,
  Wrench,
  CheckCircle2,
  XCircle,
  Info,
  Sparkles,
  FileText,
  ChevronRight,
} from 'lucide-react'
import { getToolIcon } from '../icons/ToolIcons'
import { TodoCard, parseTodoInput } from '../tool/TodoCard'
import type { Thought } from '../../types'
import { getCurrentLanguage, useTranslation } from '../../i18n'

interface CollapsedThoughtProcessProps {
  thoughts: Thought[]
}

// Get icon for thought type
function getThoughtIcon(type: Thought['type'], toolName?: string) {
  switch (type) {
    case 'thinking':
      return Lightbulb
    case 'tool_use':
      return toolName ? getToolIcon(toolName) : Wrench
    case 'tool_result':
      return CheckCircle2
    case 'system':
      return Info
    case 'error':
      return XCircle
    case 'result':
      return Sparkles
    default:
      return FileText
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
    case 'error':
      return 'text-destructive'
    default:
      return 'text-muted-foreground'
  }
}

// Get label for thought type
function getThoughtLabel(type: Thought['type'], t: (key: string) => string): string {
  switch (type) {
    case 'thinking':
      return t('Thinking')
    case 'tool_use':
      return t('Tool call')
    case 'tool_result':
      return t('Tool result')
    case 'system':
      return t('System')
    case 'error':
      return t('Error')
    case 'result':
      return t('Completed')
    default:
      return t('Event')
  }
}

// Single thought item in expanded view
function ThoughtItem({ thought }: { thought: Thought }) {
  const { t } = useTranslation()
  const [isExpanded, setIsExpanded] = useState(false)
  const color = getThoughtColor(thought.type, thought.isError)
  const Icon = getThoughtIcon(thought.type, thought.toolName)

  const content = thought.type === 'tool_use'
    ? `${thought.toolName}: ${JSON.stringify(thought.toolInput || {}).substring(0, 100)}`
    : thought.type === 'tool_result'
      ? (thought.toolOutput || '').substring(0, 200)
      : thought.content

  const maxLen = 120
  const needsTruncate = content.length > maxLen

  return (
    <div className="flex gap-2 py-1.5 text-xs border-b border-border/20 last:border-b-0">
      <Icon size={14} className={color} />
      <div className="flex-1 min-w-0">
        <span className={`font-medium ${color}`}>
          {getThoughtLabel(thought.type, t)}
          {thought.toolName && ` - ${thought.toolName}`}
        </span>
        {content && (
          <div className="mt-0.5 text-muted-foreground/70 whitespace-pre-wrap break-words">
            {isExpanded || !needsTruncate ? content : content.substring(0, maxLen) + '...'}
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
      </div>
      <span className="text-muted-foreground/40 text-[10px] shrink-0">
        {new Intl.DateTimeFormat(getCurrentLanguage(), {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        }).format(new Date(thought.timestamp))}
      </span>
    </div>
  )
}

export function CollapsedThoughtProcess({ thoughts }: CollapsedThoughtProcessProps) {
  const { t } = useTranslation()
  const [isExpanded, setIsExpanded] = useState(false)

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
        <div className="mt-1 px-3 py-2 bg-muted/20 rounded-lg border border-border/30 animate-slide-down">
          {/* Thought items */}
          {displayThoughts.length > 0 && (
            <div className="max-h-[300px] overflow-y-auto">
              {displayThoughts.map((thought) => (
                <ThoughtItem key={thought.id} thought={thought} />
              ))}
            </div>
          )}

          {/* TodoCard at bottom - only one instance */}
          {latestTodos && latestTodos.length > 0 && (
            <div className={displayThoughts.length > 0 ? 'mt-2 pt-2 border-t border-border/20' : ''}>
              <TodoCard todos={latestTodos} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
