/**
 * ThoughtProcess - the thought process of a reply while it runs: opens itself
 * when the work starts, follows the newest step, and names what the agent is
 * doing. Drawn by ThoughtPanel, the same as the saved process after the turn.
 */

import { useState, useRef, useEffect, useMemo, memo } from 'react'
import { TodoCard } from '../tool/TodoCard'
import { describeThoughtActivity, parseTodoInput } from '../../utils/thought-activity'
import { ThoughtPanel, ThoughtSteps } from './ThoughtPanel'
import { nextThoughtPanelModel, type ThoughtPanelModel } from './thought-utils'
import { useSmartScroll } from '../../hooks/useSmartScroll'
import type { Thought } from '../../types'
import { useTranslation } from '../../i18n'

interface ThoughtProcessProps {
  thoughts: Thought[]
  isThinking: boolean
  /**
   * Inside a host that already frames and titles the turn: the steps render
   * inline, always open, at full height, scrolled by the host.
   */
  embedded?: boolean
}

// Memoized: a text delta changes neither prop, and this panel can hold hundreds of steps.
export const ThoughtProcess = memo(function ThoughtProcess({ thoughts, isThinking, embedded = false }: ThoughtProcessProps) {
  // Start collapsed, but auto-expand when streaming starts
  const [isExpanded, setIsExpanded] = useState(false)
  const [hasAutoExpanded, setHasAutoExpanded] = useState(false)
  const [isMaximized, setIsMaximized] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const { t } = useTranslation()

  // Auto-expand when isThinking becomes true (streaming started)
  // Only do this once per session to avoid annoying user who manually collapsed
  useEffect(() => {
    if (isThinking && !hasAutoExpanded && thoughts.length > 0) {
      setIsExpanded(true)
      setHasAutoExpanded(true)
    }
  }, [isThinking, hasAutoExpanded, thoughts.length])

  // Reset auto-expand flag when thoughts are cleared (new session)
  useEffect(() => {
    if (thoughts.length === 0) {
      setHasAutoExpanded(false)
    }
  }, [thoughts.length])

  // Header summary of what the agent is doing right now. Recomputed per render
  // without this memo — a backwards scan of the whole step list, on the hottest
  // render path in the app.
  const actionSummary = useMemo(
    () => (isThinking ? describeThoughtActivity(thoughts) : null),
    [isThinking, thoughts]
  )

  // Timeline steps, sub-agent groups, the latest todo list and the error count,
  // re-derived only for the steps that changed since the previous render.
  const modelRef = useRef<ThoughtPanelModel | null>(null)
  const model = useMemo(() => {
    const next = nextThoughtPanelModel(modelRef.current, thoughts)
    modelRef.current = next
    return next
  }, [thoughts])

  // Only one TodoCard, at the bottom, for the latest TodoWrite call.
  const latestTodoInput = model.latestTodo?.toolInput
  const todos = useMemo(() => (latestTodoInput ? parseTodoInput(latestTodoInput) : null), [latestTodoInput])

  // Smart auto-scroll: only scrolls when user is at bottom
  // Stops auto-scroll when user scrolls up to read history.
  // `behavior: 'auto'` is not a preference — steps arrive faster than a smooth
  // scroll can finish, so an animated scroll was being retargeted mid-flight on
  // every step and the panel never came to rest. Instant follow matches the
  // team session view, which tails the same kind of stream.
  const { handleScroll } = useSmartScroll({
    containerRef: contentRef,
    threshold: 50,
    deps: [thoughts, isExpanded],
    behavior: 'auto',
  })

  if (thoughts.length === 0 && !isThinking) {
    return null
  }

  if (embedded) {
    const hasSteps = model.display.length > 0
    const hasTodos = (todos?.length ?? 0) > 0
    if (!hasSteps && !hasTodos) return null
    // The host scrolls, so lazy steps observe the viewport.
    return (
      <div className="animate-fade-in thought-content">
        <ThoughtSteps steps={model.display} childGroups={model.childGroups} live={isThinking} hasTodos={hasTodos} />
        {hasTodos && <div className={hasSteps ? 'pt-2' : ''}><TodoCard todos={todos!} isAgentActive={isThinking} /></div>}
      </div>
    )
  }

  return (
    <ThoughtPanel
      className="animate-fade-in mb-2"
      model={model}
      todos={todos}
      isThinking={isThinking}
      activity={actionSummary ? t(actionSummary.key, actionSummary.params) : undefined}
      isExpanded={isExpanded}
      onToggleExpanded={() => setIsExpanded(!isExpanded)}
      isMaximized={isMaximized}
      onToggleMaximized={() => setIsMaximized(!isMaximized)}
      scrollRef={contentRef}
      onScroll={handleScroll}
    />
  )
})
