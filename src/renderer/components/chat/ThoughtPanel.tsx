/**
 * ThoughtPanel - how a reply's thought process looks, drawn the same while the
 * reply runs (ThoughtProcess) and after it ends (CollapsedThoughtProcess).
 * Those owners keep the state — expansion, following the newest step, loading;
 * every visual detail lives here, so the two cannot drift apart.
 */

import { useState, useMemo, memo, type RefObject } from 'react'
import {
  AlertTriangle,
  Braces,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Lightbulb,
  ListTodo,
  Loader2,
  XCircle,
} from 'lucide-react'
import { TodoCard } from '../tool/TodoCard'
import type { TodoItem } from '../../utils/thought-activity'
import { ToolResultViewer } from './tool-result'
import { SubAgentTimeline } from './SubAgentTimeline'
import { ArrivalCard, arrivalIcon } from './ArrivalCard'
import { isArrivalThought, workSeconds } from './transcript'
import { ErrorContent } from './ErrorContent'
import {
  getThoughtIcon,
  getThoughtLabelKey,
  getToolFriendlyFormat,
  NO_CHILD_THOUGHTS,
  type ThoughtPanelModel,
} from './thought-utils'
import { useLazyVisible } from '../../hooks/useLazyVisible'
import type { Thought } from '../../types'
import { getCurrentLanguage, useTranslation } from '../../i18n'

interface ThoughtStepProps {
  thought: Thought
  isLast: boolean
  /**
   * The reply is still running. Saved steps can keep stale streaming flags or
   * miss a result (a stopped turn), so in-progress states show only while live.
   */
  live: boolean
  allThoughts?: Thought[]
}

const ThoughtStep = memo(function ThoughtStep({ thought, isLast, live, allThoughts }: ThoughtStepProps) {
  const [showRawJson, setShowRawJson] = useState(false)
  const [showResult, setShowResult] = useState(true)
  const [isContentExpanded, setIsContentExpanded] = useState(false)
  const { t } = useTranslation()
  const Icon = getThoughtIcon(thought.type, thought.toolName)

  if (isArrivalThought(thought)) {
    const ArrivalIcon = arrivalIcon(thought.arrival)
    return (
      <div className="flex gap-2.5 group animate-fade-in">
        <div className="flex flex-col items-center">
          <ArrivalIcon size={14} className="mt-[3px] shrink-0 text-primary" />
          {!isLast && <div className={STEP_RAIL} />}
        </div>
        <div className="flex-1 pb-3 min-w-0">
          <div className="rounded-lg border border-border-soft bg-muted/15 overflow-hidden">
            <ArrivalCard message={thought.arrival} inProcess />
          </div>
        </div>
      </div>
    )
  }

  const isStreaming = live && (thought.isStreaming ?? false)
  const isToolReady = !live || (thought.isReady ?? true)
  const hasToolResult = thought.type === 'tool_use' && thought.toolResult

  let displayContent = ''
  const maxPreviewLength = 150

  if (thought.type === 'tool_use') {
    displayContent = isToolReady ? getToolFriendlyFormat(thought.toolName || '', thought.toolInput) : '...'
  } else if (thought.type === 'thinking') {
    displayContent = thought.content || (isStreaming ? '...' : '')
  } else if (thought.type === 'tool_result') {
    displayContent = (thought.toolOutput || '').substring(0, 200)
  } else {
    displayContent = thought.content || ''
  }
  const needsTruncate = displayContent.length > maxPreviewLength

  // Tool errors use the warning style, not red: they are the AI's own feedback
  // (e.g. "read file first") that it recovers from, not errors for the user.
  // A finished step says nothing: only what is still pending or went wrong is called out.
  const getToolStatus = () => {
    if (thought.type !== 'tool_use') return null
    // Tokens by default; `theme-dark:` sets the dark hues.
    if (!isToolReady) return { label: t('Generating'), color: 'text-halo-warning theme-dark:text-amber-400' }
    if (hasToolResult) return thought.toolResult!.isError ? { label: t('Hint'), color: 'text-halo-warning' } : null
    return live ? { label: t('Running'), color: 'text-primary theme-dark:text-blue-400' } : null
  }
  const toolStatus = getToolStatus()
  const warned = thought.isError || thought.toolResult?.isError

  return (
    <div className="flex gap-2.5 group animate-fade-in">
      {/* Gray glyphs and labels: color is kept for what is running or went wrong. */}
      <div className="flex flex-col items-center">
        {thought.toolResult?.isError
          ? <AlertTriangle size={14} className="mt-[3px] shrink-0 text-amber-500" />
          : <Icon size={14} className={`mt-[3px] shrink-0 ${warned ? 'text-amber-500' : isStreaming ? 'text-primary' : 'text-faint-foreground'}`} />}
        {!isLast && <div className={STEP_RAIL} />}
      </div>

      <div className="flex-1 pb-3 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className={`min-w-0 truncate text-xs font-medium ${warned ? 'text-amber-500' : 'text-muted-foreground'}`}>
            {thought.type === 'tool_use' && thought.toolName
              ? thought.toolName
              : (() => {
                  const label = getThoughtLabelKey(thought.type)
                  return label === 'AI' ? label : t(label)
                })()}
          </span>
          {toolStatus && (
            <span className={`shrink-0 text-xs ${toolStatus.color}`}>
              {toolStatus.label}
            </span>
          )}
          <span className="hidden sm:inline shrink-0 text-xs text-faint-foreground/80">
            {new Date(thought.timestamp).toLocaleTimeString(getCurrentLanguage(), {
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit'
            })}
          </span>
          {thought.duration && (
            <span className="hidden sm:inline shrink-0 text-xs text-faint-foreground/70">
              ({(thought.duration / 1000).toFixed(1)}s)
            </span>
          )}
        </div>

        <div className="flex items-end gap-3">
          <div className="flex-1 min-w-0">
            {thought.type === 'error' ? (
              thought.content && <ErrorContent content={thought.content} />
            ) : (
              displayContent && (
                <div
                  className={`${
                    thought.type === 'thinking'
                      ? 'text-[13px] text-muted-foreground italic'
                      : thought.type === 'tool_use'
                        // A tool's input is detail under its name, a step smaller than the reply's prose.
                        ? `text-[13px] text-foreground/75 ${thought.toolName === 'Bash' ? 'font-mono text-xs leading-relaxed' : ''}`
                        : thought.type === 'system'
                          // Session housekeeping (connected, model): the least worth reading.
                          ? 'text-xs text-faint-foreground'
                          : 'text-sm text-foreground/80'
                  } whitespace-pre-wrap break-words`}
                >
                  {isContentExpanded || !needsTruncate ? displayContent : displayContent.substring(0, maxPreviewLength) + '...'}
                  {(thought.type === 'thinking' || thought.type === 'text') && needsTruncate && (
                    <button
                      onClick={() => setIsContentExpanded(!isContentExpanded)}
                      className="ml-1 text-primary hover:underline not-italic"
                    >
                      {isContentExpanded ? t('Collapse') : t('Expand')}
                    </button>
                  )}
                </div>
              )
            )}
          </div>

          {((thought.type === 'tool_use' && isToolReady && thought.toolInput && Object.keys(thought.toolInput).length > 0) || hasToolResult) && (
            <div className="flex items-center gap-0.5 shrink-0 text-[9px]">
              {thought.type === 'tool_use' && isToolReady && thought.toolInput && Object.keys(thought.toolInput).length > 0 && (
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
                </button>
              )}

              {hasToolResult && thought.toolResult!.output && (
                <button
                  onClick={() => setShowResult(!showResult)}
                  className="flex items-center gap-0.5 px-1 py-px rounded text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/50 transition-colors"
                  title={showResult ? t('Hide tool result') : t('Show tool result')}
                >
                  {showResult ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                  {showResult ? t('Collapse') : t('Result')}
                </button>
              )}
            </div>
          )}
        </div>

        {thought.type === 'tool_use' && showRawJson && thought.toolInput && (
          <pre className="mt-2 p-2 rounded bg-muted/30 text-xs text-muted-foreground overflow-x-auto">
            {JSON.stringify(thought.toolInput, null, 2)}
          </pre>
        )}

        {hasToolResult && showResult && thought.toolResult!.output && (
          <ToolResultViewer
            toolName={thought.toolName || ''}
            toolInput={thought.toolInput}
            output={thought.toolResult!.output}
            isError={thought.toolResult!.isError}
          />
        )}

        {thought.type === 'tool_use' && (thought.toolName === 'Task' || thought.toolName === 'Agent') && allThoughts && (
          <SubAgentTimeline
            thoughts={allThoughts}
            parentToolUseId={thought.id}
            taskProgress={thought.taskProgress}
            isThinking={live}
          />
        )}
      </div>
    </div>
  )
})

/** The thin line joining a step's glyph to the next step. */
const STEP_RAIL = 'w-px flex-1 bg-border mt-1.5'

// Placeholder height until a step scrolls near view, so the list does not jump.
const THOUGHT_STEP_ESTIMATED_HEIGHT = 60

const LazyThoughtStep = memo(function LazyThoughtStep({ scrollRef, eager, ...step }: ThoughtStepProps & {
  scrollRef?: RefObject<HTMLDivElement>
  eager: boolean
}) {
  const [ref, isVisible] = useLazyVisible('200px', scrollRef, eager)
  if (isVisible) return <ThoughtStep {...step} />
  return <div ref={ref} style={{ minHeight: THOUGHT_STEP_ESTIMATED_HEIGHT }} />
})

interface ThoughtStepsProps {
  steps: readonly Thought[]
  childGroups: ReadonlyMap<string, Thought[]>
  live: boolean
  /** A task list follows the steps, so the last one keeps its connector. */
  hasTodos: boolean
  /** The scroller the steps sit in; absent when the page itself scrolls them. */
  scrollRef?: RefObject<HTMLDivElement>
}

/** The timeline rows. Memoized: a panel can hold hundreds of steps. */
export const ThoughtSteps = memo(function ThoughtSteps({ steps, childGroups, live, hasTodos, scrollRef }: ThoughtStepsProps) {
  return <>
    {steps.map((thought, index) => {
      const isTaskThought = thought.type === 'tool_use' && (thought.toolName === 'Task' || thought.toolName === 'Agent')
      // The newest three render at once, where a running reply is watched; the
      // rest when scrolled near. One component type for both, so a step that
      // stops being newest is not remounted (that flickered).
      return (
        <LazyThoughtStep
          key={thought.id}
          thought={thought}
          isLast={index === steps.length - 1 && !hasTodos && !live}
          live={live}
          scrollRef={scrollRef}
          eager={index >= steps.length - 3}
          allThoughts={isTaskThought ? childGroups.get(thought.id) ?? NO_CHILD_THOUGHTS : undefined}
        />
      )
    })}
  </>
})

interface ThoughtPanelHeaderProps {
  label: string
  isThinking?: boolean
  hasError?: boolean
  /** How long the reply worked, shown once it is done. */
  seconds?: string
  isExpanded?: boolean
  /** Absent while there is nothing to open: the row stays, without a chevron. */
  onToggle?: () => void
  disabled?: boolean
  isLoading?: boolean
  /** The steps were not saved; the row reads as inert. */
  unavailable?: boolean
  /** The reply's task list progress, kept in view even while the panel is closed. */
  tasks?: { done: number; total: number }
}

export function ThoughtPanelHeader({
  label,
  isThinking = false,
  hasError = false,
  seconds,
  isExpanded = false,
  onToggle,
  disabled = false,
  isLoading = false,
  unavailable = false,
  tasks,
}: ThoughtPanelHeaderProps) {
  const { t } = useTranslation()
  const tasksDone = !!tasks && tasks.done === tasks.total
  // The status icon leads, on the same left edge as the sender label and the reply;
  // the disclosure chevron trails the title.
  const content = <>
    {isThinking ? (
      <Loader2 size={14} className="shrink-0 text-primary animate-spin" />
    ) : hasError ? (
      <XCircle size={14} className="shrink-0 text-destructive" />
    ) : (
      <Lightbulb size={14} className={`shrink-0 ${unavailable ? 'text-muted-foreground/40' : 'text-primary'}`} />
    )}
    <span className={`min-w-0 truncate ${isThinking ? 'text-primary' : 'text-muted-foreground'}`}>{label}</span>
    {seconds !== undefined && <span className="shrink-0 text-muted-foreground/60">{seconds}s</span>}
    {tasks && tasks.total > 0 && (
      <span className={`shrink-0 inline-flex items-center gap-1 ${tasksDone ? 'text-halo-success' : 'text-muted-foreground'}`}>
        <ListTodo size={12} />
        {t('Tasks {{done}}/{{total}}', { done: tasks.done, total: tasks.total })}
      </span>
    )}
    {isLoading ? (
      <Loader2 size={12} className="shrink-0 text-muted-foreground animate-spin" />
    ) : (
      // Kept, though hidden, while there is nothing to open, so the row does not shift when there is.
      <ChevronRight
        size={12}
        className={`shrink-0 -ml-0.5 transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''} ${
          unavailable ? 'text-muted-foreground/40' : 'text-muted-foreground'
        } ${onToggle ? '' : 'invisible'}`}
      />
    )}
  </>

  // Content on the column's left edge; the hover fill bleeds into the gutter
  // on both sides, the same bleed as the filled body below.
  const row = '-mx-3 flex w-[calc(100%+1.5rem)] items-center gap-2 rounded-lg px-3 py-1.5 text-left text-xs'
  if (!onToggle) return <div className={row}>{content}</div>
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      aria-expanded={isExpanded}
      className={`${row} transition-colors duration-200 hover:bg-secondary/60 disabled:hover:bg-transparent`}
    >
      {content}
    </button>
  )
}

interface ThoughtPanelProps {
  model: ThoughtPanelModel
  todos: TodoItem[] | null
  isThinking: boolean
  /** What the reply is doing now, the title while it runs. */
  activity?: string
  isExpanded: boolean
  onToggleExpanded: () => void
  isMaximized: boolean
  onToggleMaximized: () => void
  scrollRef: RefObject<HTMLDivElement>
  onScroll?: () => void
  className?: string
}

export function ThoughtPanel({
  model,
  todos,
  isThinking,
  activity,
  isExpanded,
  onToggleExpanded,
  isMaximized,
  onToggleMaximized,
  scrollRef,
  onScroll,
  className = '',
}: ThoughtPanelProps) {
  const { t } = useTranslation()
  // Measured between the reply's own first and last step, never against the
  // clock: a clock-based duration keeps growing on every re-render.
  const seconds = useMemo(() => Math.max(0, workSeconds(model.thoughts)).toFixed(1), [model.thoughts])

  const steps = model.display
  const hasTodos = (todos?.length ?? 0) > 0
  const hasBody = steps.length > 0 || hasTodos
  const tasks = hasTodos ? { done: todos!.filter(item => item.status === 'completed').length, total: todos!.length } : undefined
  // While running, the task in progress names what the reply is doing better than its latest tool.
  const currentTask = isThinking ? todos?.find(item => item.status === 'in_progress') : undefined
  // A running reply shows its header before its first step; some turns never emit one.
  if (!hasBody && !isThinking) return null

  return (
    <div className={className}>
      <ThoughtPanelHeader
        label={isThinking ? (currentTask ? currentTask.activeForm || currentTask.content : activity) ?? t('Already thought') : t('Already thought')}
        isThinking={isThinking}
        hasError={model.errorCount > 0}
        seconds={isThinking ? undefined : seconds}
        isExpanded={isExpanded}
        onToggle={hasBody ? onToggleExpanded : undefined}
        // Progress stands in for the list only while the reply runs and the panel is closed:
        // open, the list below already shows it; done, the list is the summary.
        tasks={isThinking && !isExpanded ? tasks : undefined}
      />

      {isExpanded && hasBody && (
        // A faint fill groups the process as one block; the reply below sits on the bare
        // canvas, so it reads as the result. The same in both themes. It bleeds into the
        // gutter so the steps inside keep the column's left edge.
        <div className="-mx-3 mt-1 py-2 rounded-lg bg-card/50 animate-slide-down thought-content">
          {steps.length > 0 && (
            <div
              ref={scrollRef}
              onScroll={onScroll}
              className={`px-3 ${isMaximized ? 'max-h-[80vh]' : 'max-h-[300px]'} overflow-auto scrollbar-overlay transition-all duration-200`}
            >
              <ThoughtSteps steps={steps} childGroups={model.childGroups} live={isThinking} hasTodos={hasTodos} scrollRef={scrollRef} />
            </div>
          )}

          {hasTodos && (
            <div className={`px-3 ${steps.length > 0 ? 'pt-2' : ''}`}>
              <TodoCard todos={todos!} isAgentActive={isThinking} />
            </div>
          )}

          {/* Shown when the list is likely to overflow */}
          {(steps.length > 8 || isMaximized) && (
            <div className="flex justify-end px-3 mt-1">
              <button
                onClick={onToggleMaximized}
                className="flex items-center gap-0.5 px-1 py-px rounded text-xs text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted/50 transition-colors"
                title={isMaximized ? t('Compact view') : t('Full view')}
              >
                {isMaximized ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                {isMaximized ? t('Compact view') : t('Full view')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
