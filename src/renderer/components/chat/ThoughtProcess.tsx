/**
 * ThoughtProcess - the work of a reply while it runs: folded to the line that
 * names what the agent is doing, opened to its timeline. Drawn by WorkHistory,
 * the same as the saved work after the turn. The reply's latest words stay
 * below it, in the reply's own bubble.
 */

import { useRef, useMemo, memo } from 'react'
import { describeThoughtActivity, parseTodoInput } from '../../utils/thought-activity'
import { WorkHistory, useWorkOpen, useWorkViewMemory } from './work-history'
import { nextThoughtPanelModel, type ThoughtPanelModel } from './thought-utils'
import type { Thought } from '../../types'
import { useTranslation } from '../../i18n'

interface ThoughtProcessProps {
  thoughts: Thought[]
  isThinking: boolean
  /**
   * Inside a host that already frames and titles the turn: the work renders
   * inline, always open, with every stretch of operations open.
   */
  embedded?: boolean
  /** Text steps the reply's bubble below already shows; kept stable while unchanged. */
  liveTextIds?: ReadonlySet<string>
  /** The reply is writing words to the person right now. */
  writing?: boolean
  /** Where the transcript remembers what was opened in this work (`LIVE_WORK` for the turn running). */
  workKey?: string
}

// Memoized: a text delta changes no prop, and the work can hold hundreds of steps.
export const ThoughtProcess = memo(function ThoughtProcess({
  thoughts,
  isThinking,
  embedded = false,
  liveTextIds,
  writing = false,
  workKey,
}: ThoughtProcessProps) {
  const { t } = useTranslation()
  const memory = useWorkViewMemory()
  const view = memory && workKey ? memory.view(workKey) : null
  const [open, setOpen] = useWorkOpen(view, false)

  // Header summary of what the agent is doing right now. Recomputed per render
  // without this memo — a backwards scan of the whole step list, on the hottest
  // render path in the app.
  const actionSummary = useMemo(
    () => (isThinking && !writing ? describeThoughtActivity(thoughts) : null),
    [isThinking, writing, thoughts]
  )

  // Timeline steps, nested tool groups, the latest todo list and the error count,
  // re-derived only for the steps that changed since the previous render.
  const modelRef = useRef<ThoughtPanelModel | null>(null)
  const model = useMemo(() => {
    const next = nextThoughtPanelModel(modelRef.current, thoughts)
    modelRef.current = next
    return next
  }, [thoughts])

  const latestTodoInput = model.latestTodo?.toolInput
  const todos = useMemo(() => (latestTodoInput ? parseTodoInput(latestTodoInput) : null), [latestTodoInput])

  if (thoughts.length === 0 && !isThinking) return null

  return (
    <WorkHistory
      className={embedded ? 'animate-fade-in' : 'animate-fade-in mb-2'}
      model={model}
      todos={todos}
      live={isThinking}
      activity={writing ? t('Replying...') : actionSummary ? t(actionSummary.key, actionSummary.params) : undefined}
      liveTextIds={liveTextIds}
      open={open}
      onToggle={() => setOpen(!open)}
      embedded={embedded}
      showOperations={embedded}
      view={view}
    />
  )
})
