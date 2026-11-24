/**
 * CollapsedThoughtProcess - the saved work above a finished reply. Folded by
 * default to one line; opened, it reads as the live work looked while the
 * reply ran. Drawn by WorkHistory. What the person opened is remembered by the
 * transcript, so the work stays as they left it when the running reply turns
 * into this one, or its row scrolls away and back.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { parseTodoInput } from '../../utils/thought-activity'
import { TrailingArrivals } from './ArrivalCard'
import { mergeArrivalThoughts, toArrivalThought } from './transcript'
import { WorkHistory, WorkHistoryHeader, formatWorkDuration, useWorkOpen, useWorkViewMemory } from './work-history'
import { SkillNotice } from './SkillNotice'
import { nextThoughtPanelModel } from './thought-utils'
import type { Message, Thought, ThoughtsSummary } from '../../types'
import { useTranslation } from '../../i18n'
import { holdOpenThoughts } from '../../stores/chat.store'

interface CollapsedThoughtProcessProps {
  thoughts: Thought[]
  /** The reply's own text, shown below; the steps that wrote it are not repeated in the work. */
  answer?: string
  defaultExpanded?: boolean
  /** Show every operation from the start, as trace views want it. */
  showOperations?: boolean
  /** The message these thoughts belong to; while expanded, its loaded thoughts are kept. */
  messageId?: string
}

export function CollapsedThoughtProcess({ thoughts, answer, defaultExpanded = false, showOperations = false, messageId }: CollapsedThoughtProcessProps) {
  const memory = useWorkViewMemory()
  const view = memory && messageId ? memory.view(messageId) : null
  const [isExpanded, setIsExpanded] = useWorkOpen(view, defaultExpanded)
  useEffect(() => (messageId && isExpanded ? holdOpenThoughts(messageId) : undefined), [messageId, isExpanded])

  const model = useMemo(() => nextThoughtPanelModel(null, thoughts), [thoughts])
  const latestTodoInput = model.latestTodo?.toolInput
  const todos = useMemo(() => (latestTodoInput ? parseTodoInput(latestTodoInput) : null), [latestTodoInput])

  return (
    <WorkHistory
      className="mb-2"
      model={model}
      todos={todos}
      live={false}
      answer={answer}
      open={isExpanded}
      onToggle={() => setIsExpanded(!isExpanded)}
      showOperations={showOperations}
      view={view}
    />
  )
}

/** Step kinds that are work worth opening on their own; a reply's text may be only its answer. */
const WORK_STEP_TYPES = ['thinking', 'tool_use', 'tool_result', 'error'] as const

/** Whether separated thoughts hold more than the reply's answer, judged from their digest. */
function summaryHasWork(summary: ThoughtsSummary, answer: string | undefined): boolean {
  if (WORK_STEP_TYPES.some(type => (summary.types[type] ?? 0) > 0) || (summary.compactions ?? 0) > 0) return true
  return (summary.types.text ?? 0) > (answer?.trim() ? 1 : 0)
}

/**
 * LazyCollapsedThoughtProcess - For separated thoughts (v2 format).
 * Shows the folded line initially, loads the thoughts on first open, then
 * renders the full CollapsedThoughtProcess. Work the person left open (while
 * the reply ran, or before its thoughts were dropped from memory) is loaded
 * again as soon as it is drawn; the click and that reopening share one read.
 */
interface LazyCollapsedThoughtProcessProps {
  thoughtsSummary: ThoughtsSummary
  onLoadThoughts: () => Promise<Thought[]>
  answer?: string
  showOperations?: boolean
  /** Records received while the reply was written; joined to its thoughts once they load. */
  arrivals?: Message[]
  /** The reply, by which the transcript remembers whether its work was left open. */
  messageId?: string
  /**
   * The steps this window streamed for the reply, for the one that just
   * finished with its work open: shown while its saved steps are read, so the
   * work does not fold in between. The saved steps replace them once read.
   */
  streamedThoughts?: Thought[]
}

export function LazyCollapsedThoughtProcess({ thoughtsSummary, onLoadThoughts, answer, showOperations = false, arrivals, messageId, streamedThoughts }: LazyCollapsedThoughtProcessProps) {
  const { t } = useTranslation()
  const memory = useWorkViewMemory()
  const [loadedThoughts, setLoadedThoughts] = useState<Thought[] | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const onLoadRef = useRef(onLoadThoughts)
  onLoadRef.current = onLoadThoughts
  const reading = useRef<Promise<void> | null>(null)
  const reopenOnMount = useRef(!!memory && !!messageId && memory.isOpen(messageId))
  const [mayStandIn] = useState(() => !!memory && !!messageId && memory.carriedOpen(messageId))
  const standIn = !loadedThoughts && mayStandIn && streamedThoughts?.length ? streamedThoughts : null
  const shownThoughts = loadedThoughts ?? standIn
  const mergedThoughts = useMemo(() => shownThoughts?.length && arrivals?.length
    ? mergeArrivalThoughts(shownThoughts, arrivals.map(toArrivalThought))
    : shownThoughts, [shownThoughts, arrivals])

  const load = useCallback(() => {
    if (memory && messageId) memory.view(messageId).open = true
    reading.current ??= (async () => {
      setIsLoading(true)
      try {
        setLoadedThoughts(await onLoadRef.current())
      } catch (err) {
        console.error('[LazyCollapsedThoughtProcess] Failed to load thoughts:', err)
      } finally {
        setIsLoading(false)
        reading.current = null
      }
    })()
    return reading.current
  }, [memory, messageId])

  useEffect(() => {
    if (!reopenOnMount.current) return
    reopenOnMount.current = false
    void load()
  }, [load])

  // Loaded, or standing in while that read runs: render expanded — the person asked for it
  if (mergedThoughts && mergedThoughts.length > 0) {
    return <CollapsedThoughtProcess thoughts={mergedThoughts} answer={answer} showOperations={showOperations} messageId={messageId} defaultExpanded />
  }

  // Empty array is truthy: without the length check above, a message with
  // saved-but-empty thoughts renders null and silently disappears instead of
  // showing the unavailable state.
  const unavailable = loadedThoughts !== null
  const notices = thoughtsSummary.skillNotices?.map((code, index) => <SkillNotice key={`${index}:${code}`} code={code} />)
  if (!unavailable && !arrivals?.length && !summaryHasWork(thoughtsSummary, answer)) return <>{notices}</>

  return (
    <div className="mb-2">
      {notices}
      <WorkHistoryHeader
        label={unavailable ? t('The work process of this reply was not saved') : t('Work process')}
        duration={unavailable ? undefined : formatWorkDuration(thoughtsSummary.duration, t)}
        onToggle={unavailable ? undefined : () => void load()}
        loading={isLoading}
        unavailable={unavailable}
      />
      {unavailable && arrivals?.length ? <TrailingArrivals arrivals={arrivals} lineGapClassName="mt-2" /> : null}
    </div>
  )
}
