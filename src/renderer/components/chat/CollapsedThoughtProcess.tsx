/**
 * CollapsedThoughtProcess - the saved thought process above a finished reply.
 * Collapsed by default, expandable to show full details. Drawn by
 * ThoughtPanel, exactly as the live process looked while the reply ran.
 */

import { useEffect, useState, useMemo, useRef } from 'react'
import { parseTodoInput } from '../../utils/thought-activity'
import { ArrivalCard } from './ArrivalCard'
import { mergeArrivalThoughts, toArrivalThought } from './transcript'
import { ThoughtPanel, ThoughtPanelHeader } from './ThoughtPanel'
import { nextThoughtPanelModel } from './thought-utils'
import type { Message, Thought, ThoughtsSummary } from '../../types'
import { useTranslation } from '../../i18n'
import { holdOpenThoughts } from '../../stores/chat.store'

interface CollapsedThoughtProcessProps {
  thoughts: Thought[]
  defaultExpanded?: boolean
  /** Start in full-height mode (max-h-[80vh] instead of 300px). Useful for debugging views. */
  defaultMaximized?: boolean
  /** The message these thoughts belong to; while expanded, its loaded thoughts are kept. */
  messageId?: string
}

export function CollapsedThoughtProcess({ thoughts, defaultExpanded = false, defaultMaximized = false, messageId }: CollapsedThoughtProcessProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)
  useEffect(() => (messageId && isExpanded ? holdOpenThoughts(messageId) : undefined), [messageId, isExpanded])
  const [isMaximized, setIsMaximized] = useState(defaultMaximized)
  const scrollRef = useRef<HTMLDivElement>(null)

  const model = useMemo(() => nextThoughtPanelModel(null, thoughts), [thoughts])
  const latestTodoInput = model.latestTodo?.toolInput
  const todos = useMemo(() => (latestTodoInput ? parseTodoInput(latestTodoInput) : null), [latestTodoInput])

  return (
    <ThoughtPanel
      className="mb-2"
      model={model}
      todos={todos}
      isThinking={false}
      isExpanded={isExpanded}
      onToggleExpanded={() => setIsExpanded(!isExpanded)}
      isMaximized={isMaximized}
      onToggleMaximized={() => setIsMaximized(!isMaximized)}
      scrollRef={scrollRef}
    />
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
  /** Records received while the reply was written; joined to its thoughts once they load. */
  arrivals?: Message[]
}

export function LazyCollapsedThoughtProcess({ thoughtsSummary, onLoadThoughts, arrivals }: LazyCollapsedThoughtProcessProps) {
  const { t } = useTranslation()
  const [loadedThoughts, setLoadedThoughts] = useState<Thought[] | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const mergedThoughts = useMemo(() => loadedThoughts?.length && arrivals?.length
    ? mergeArrivalThoughts(loadedThoughts, arrivals.map(toArrivalThought))
    : loadedThoughts, [loadedThoughts, arrivals])

  // Once loaded, render expanded — user explicitly clicked to load thoughts
  if (mergedThoughts && mergedThoughts.length > 0) {
    return <CollapsedThoughtProcess thoughts={mergedThoughts} defaultExpanded />
  }

  // Empty array is truthy: without the length check above, a message with
  // saved-but-empty thoughts renders null and silently disappears instead of
  // showing the unavailable state.
  const unavailable = loadedThoughts !== null
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
      <ThoughtPanelHeader
        label={unavailable ? t('Thought process was not saved for this message') : t('Already thought')}
        seconds={!unavailable && duration != null ? duration.toFixed(1) : undefined}
        onToggle={handleClick}
        disabled={isLoading || unavailable}
        isLoading={isLoading}
        unavailable={unavailable}
      />
      {unavailable && arrivals?.map(message => (
        <div key={message.clientKey ?? message.id} className="mt-2">
          <ArrivalCard message={message} />
        </div>
      ))}
    </div>
  )
}
