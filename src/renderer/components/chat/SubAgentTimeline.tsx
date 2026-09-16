/**
 * SubAgentTimeline - Compact nested timeline for sub-agent tool calls.
 *
 * Rendered inside a Task tool_use ThoughtItem to show what the sub-agent
 * is doing in real-time. Each row shows: status dot, tool name, friendly
 * summary, and merged tool result (collapsed by default).
 *
 * Design: lightweight and purpose-built for nesting. Does NOT reuse
 * ThoughtProcess (which has auto-scroll, lazy loading, expand/collapse
 * header logic that would be inappropriate in a nested context).
 */

import { useState, useMemo, memo } from 'react'
import {
  CheckCircle2,
  AlertTriangle,
  Circle,
  ChevronDown,
  ChevronUp,
} from 'lucide-react'
import { getToolIcon } from '../icons/ToolIcons'
import { getToolFriendlyFormat, truncateText } from './thought-utils'
import { ToolResultViewer } from './tool-result'
import type { Thought, TaskProgress } from '../../types'
import { useTranslation } from '../../i18n'

// i18n static keys for extraction (DO NOT REMOVE)
// prettier-ignore
void function _i18nSubAgentKeys(t: (k: string) => string) {
  t('Running'); t('Running...'); t('tools used');
}

// ============================================
// SubAgentToolRow - Single tool call in the timeline
// ============================================

const SubAgentToolRow = memo(function SubAgentToolRow({ thought }: { thought: Thought }) {
  const [showResult, setShowResult] = useState(false)
  const hasResult = !!thought.toolResult
  const isError = thought.toolResult?.isError

  const fullContent = useMemo(
    () => getToolFriendlyFormat(thought.toolName || '', thought.toolInput),
    [thought.toolName, thought.toolInput]
  )
  const friendlyContent = useMemo(
    () => truncateText(fullContent, 60),
    [fullContent]
  )

  const ToolIcon = getToolIcon(thought.toolName || '')

  return (
    <div className="py-1 first:pt-0 last:pb-0">
      <div className="flex items-center gap-1.5 min-w-0">
        {/* Status dot */}
        {hasResult ? (
          isError
            ? <AlertTriangle size={11} className="text-amber-500 shrink-0" />
            : <CheckCircle2 size={11} className="text-green-500 shrink-0" />
        ) : (
          <Circle size={11} className="text-blue-400 shrink-0" />
        )}

        {/* Tool icon + name */}
        <ToolIcon size={11} className="text-muted-foreground/70 shrink-0" />
        <span className="text-xs font-medium text-foreground/80 shrink-0">
          {thought.toolName}
        </span>

        {/* Friendly summary */}
        <span className="text-xs text-muted-foreground/60 truncate min-w-0 flex-1" title={fullContent || undefined}>
          {friendlyContent}
        </span>

        {/* Toggle result button */}
        {hasResult && thought.toolResult!.output && (
          <button
            onClick={() => setShowResult(!showResult)}
            className="text-muted-foreground/40 hover:text-muted-foreground shrink-0 p-0.5"
          >
            {showResult ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
          </button>
        )}
      </div>

      {/* Tool result (collapsed by default) */}
      {showResult && hasResult && thought.toolResult!.output && (
        <div className="mt-1 ml-5">
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
})

// ============================================
// SubAgentTimeline - Container
// ============================================

interface SubAgentTimelineProps {
  /** All thoughts in the session (flat array) */
  thoughts: Thought[]
  /** The parent Task thought's ID (used as tool_use_id in SDK) */
  parentToolUseId: string
  /** Task progress metadata from lifecycle events */
  taskProgress?: TaskProgress
  /** Whether the parent agent is still thinking */
  isThinking: boolean
}

export function SubAgentTimeline({ thoughts, parentToolUseId, taskProgress, isThinking }: SubAgentTimelineProps) {
  const { t } = useTranslation()
  const [isExpanded, setIsExpanded] = useState(false)

  // Filter sub-agent thoughts belonging to this parent
  const childThoughts = useMemo(() => {
    return thoughts.filter(
      th => th.parentToolUseId === parentToolUseId
        && th.type === 'tool_use'  // Only show tool_use (tool_result merged into tool_use)
    )
  }, [thoughts, parentToolUseId])

  // Nothing to show yet
  if (childThoughts.length === 0 && !taskProgress) return null

  const isRunning = taskProgress?.status === 'running'
  const toolCount = taskProgress?.toolCount ?? childThoughts.length
  const durationSec = taskProgress?.durationMs ? (taskProgress.durationMs / 1000).toFixed(1) : null

  return (
    <div className="mt-2 rounded-lg border border-border/30 bg-muted/20 overflow-hidden">
      {/* Header bar */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-muted/30 transition-colors"
      >
        {isRunning && isThinking ? (
          <Circle size={11} className="text-blue-400 shrink-0" />
        ) : (
          <CheckCircle2 size={11} className="text-green-500 shrink-0" />
        )}

        {/* Status summary */}
        <span
          className="flex-1 text-left truncate"
          title={
            isRunning && isThinking
              ? taskProgress?.lastToolName
                ? `${t('Running')} ${taskProgress.lastToolName}...`
                : t('Running...')
              : `${toolCount} ${t('tools used')}`
          }
        >
          {isRunning && isThinking ? (
            taskProgress?.lastToolName
              ? `${t('Running')} ${taskProgress.lastToolName}...`
              : t('Running...')
          ) : (
            `${toolCount} ${t('tools used')}`
          )}
        </span>

        {/* Duration */}
        {durationSec && (
          <span className="text-muted-foreground/50 shrink-0">{durationSec}s</span>
        )}

        {/* Expand/collapse chevron */}
        <ChevronDown
          size={12}
          className={`text-muted-foreground/50 transition-transform duration-150 ${isExpanded ? 'rotate-180' : ''}`}
        />
      </button>

      {/* Tool call list */}
      {isExpanded && childThoughts.length > 0 && (
        <div className="px-2.5 py-1.5 border-t border-border/20 space-y-0">
          {childThoughts.map(thought => (
            <SubAgentToolRow key={thought.id} thought={thought} />
          ))}
        </div>
      )}
    </div>
  )
}
