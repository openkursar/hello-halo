/**
 * GoalShelf — the conversation's goal, attached to the top edge of the
 * composer card.
 *
 * Absent until the conversation has a goal. One line by default; expands to
 * the full objective and its done-when criteria. Live changes from Halo animate
 * and are announced; a goal already there when the conversation opens simply
 * appears, so switching conversations never plays an entrance.
 */

import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { ChevronDown, Pencil, Plus, X } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { canvasLifecycle } from '../../services/canvas-lifecycle'
import { useConversationGoal, useGoalUnseenByModel, type Goal } from '../../stores/goal.store'
import { useGoalUiStore } from '../../stores/goal-ui.store'
import { GoalStatusIcon, goalStatusLabel } from './GoalStatus'
import { undoClearGoal } from './goal-actions'
import { useClearGoal } from './useClearGoal'
import { useTimeAgo } from './hooks'

interface GoalShelfProps {
  spaceId: string
  conversationId: string
  running: boolean
  /** Put the composer into goal mode. */
  onNewGoal: () => void
}

const ICON_BUTTON =
  'shrink-0 inline-flex items-center justify-center h-8 w-8 sm:h-7 sm:w-7 rounded-md text-muted-foreground ' +
  'hover:text-foreground hover:bg-background/70 transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50'

function sameRevision(a: Goal | null, b: Goal | null): boolean {
  if (!a || !b) return a === b
  return a.objective === b.objective &&
    a.status === b.status &&
    a.updatedAt === b.updatedAt &&
    a.doneWhen.length === b.doneWhen.length &&
    a.doneWhen.every((c, i) => c === b.doneWhen[i])
}

function sameCriteria(a: Goal, b: Goal): boolean {
  return a.doneWhen.length === b.doneWhen.length && a.doneWhen.every((c, i) => c === b.doneWhen[i])
}

export function GoalShelf({ spaceId, conversationId, running, onNewGoal }: GoalShelfProps) {
  const { t } = useTranslation()
  const goal = useConversationGoal(conversationId)
  const unseen = useGoalUnseenByModel(conversationId)
  const expanded = useGoalUiStore((s) => s.expanded.has(conversationId))
  const undo = useGoalUiStore((s) => s.undo.get(conversationId))
  const { requestClear, confirmDialog } = useClearGoal(spaceId, conversationId, running)

  const bodyId = useId()
  const chevronRef = useRef<HTMLButtonElement>(null)
  // The collapsed objective button leaves the DOM on expand, and with it the
  // keyboard focus; the chevron takes it over.
  const objectiveFocusedRef = useRef(false)
  // Likewise the undo row: Undo that held focus hands it to the restored shelf.
  const undoFocusedRef = useRef(false)
  const [entering, setEntering] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const [announcement, setAnnouncement] = useState('')

  // Goal as last rendered: what a live change is compared against.
  const previousRef = useRef(goal)
  useEffect(() => {
    const previous = previousRef.current
    previousRef.current = goal
    if (previous === undefined || goal === undefined || sameRevision(previous, goal)) return

    const ui = useGoalUiStore.getState()
    if (goal) ui.dropUndo(conversationId)

    if (!goal) {
      if (previous && previous.status !== 'active') setAnnouncement(t('Goal dismissed'))
      else if (previous && !ui.undo.has(conversationId)) setAnnouncement(t('Goal cleared'))
      return
    }
    if (goal.updatedBy !== 'agent') return

    if (!previous) {
      setEntering(true)
      setHighlight((n) => n + 1)
      setAnnouncement(t('Goal set by Halo'))
    } else if (goal.status === 'complete' && previous.status !== 'complete') {
      setAnnouncement(t('Goal achieved'))
    } else if (goal.status === 'abandoned' && previous.status !== 'abandoned') {
      setAnnouncement(t('Goal abandoned'))
    } else {
      setHighlight((n) => n + 1)
      setAnnouncement(t('Goal updated by Halo'))
      if (!sameCriteria(previous, goal)) ui.setExpanded(conversationId, true)
    }
  }, [goal, conversationId, t])

  const timeAgo = useTimeAgo(goal?.updatedAt)

  useLayoutEffect(() => {
    if (!expanded || !objectiveFocusedRef.current) return
    objectiveFocusedRef.current = false
    chevronRef.current?.focus()
  }, [expanded])

  useLayoutEffect(() => {
    if (!goal || !undoFocusedRef.current) return
    undoFocusedRef.current = false
    chevronRef.current?.focus()
  }, [goal])

  // Cleared by animationend, or by the timer where that never fires (e.g. a throttled window).
  useEffect(() => {
    if (!entering) return
    const id = setTimeout(() => setEntering(false), 250)
    return () => clearTimeout(id)
  }, [entering])

  // One live region for every branch, so an announcement made while the shelf
  // changes shape is not lost with the node that carried it.
  const shell = (content: ReactNode) => (
    <div>
      <span className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</span>
      {content}
      {confirmDialog}
    </div>
  )

  if (!goal) {
    if (!undo) return shell(null)
    return shell(
      <div className="flex items-center gap-2 h-8 px-3 rounded-t-xl border border-b-0 border-border/70 bg-secondary/40 text-xs animate-slide-down">
        <span role="status" className="flex-1 min-w-0 truncate text-muted-foreground">
          {t('Goal cleared.')}
        </span>
        <button
          type="button"
          onClick={(e) => {
            undoFocusedRef.current = document.activeElement === e.currentTarget
            void undoClearGoal(spaceId, conversationId)
          }}
          className="shrink-0 h-8 sm:h-6 px-2 rounded-md text-xs font-medium text-primary hover:bg-primary/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
        >
          {t('Undo')}
        </button>
      </div>
    )
  }

  const finished = goal.status !== 'active'
  const setExpanded = (next: boolean) => useGoalUiStore.getState().setExpanded(conversationId, next)
  const openEditor = () => void canvasLifecycle.openGoal(spaceId, conversationId)
  const label = goalStatusLabel(goal, running, t)
  const pendingHint = unseen && !finished
    ? (running ? t('Applies on next step') : t('Applies on your next message'))
    : null
  const updatedTitle = goal.updatedBy === 'agent'
    ? t('Updated by Halo {{time}}', { time: timeAgo })
    : t('Updated by you {{time}}', { time: timeAgo })
  const criteriaCount = goal.doneWhen.length
  const criteriaLabel = criteriaCount === 1 ? t('1 criterion') : t('{{count}} criteria', { count: criteriaCount })

  const handleObjectiveClick = (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey) openEditor()
    else setExpanded(!expanded)
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && expanded && e.currentTarget.contains(e.target as Node)) {
      e.stopPropagation()
      setExpanded(false)
      chevronRef.current?.focus()
    }
  }

  const primaryAction = finished ? (
    <button
      type="button"
      onClick={onNewGoal}
      title={t('New goal')}
      className="shrink-0 inline-flex items-center gap-1 h-8 sm:h-7 px-2 rounded-md text-xs font-medium text-foreground/80 hover:text-foreground hover:bg-background/70 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
    >
      <Plus size={13} aria-hidden />
      <span className="hidden sm:inline">{t('New goal')}</span>
      <span className="sr-only sm:hidden">{t('New goal')}</span>
    </button>
  ) : (
    <button type="button" onClick={openEditor} aria-label={t('Edit goal')} title={t('Edit goal')} className={ICON_BUTTON}>
      <Pencil size={13} />
    </button>
  )

  const chevron = (
    <button
      ref={chevronRef}
      type="button"
      onClick={() => setExpanded(!expanded)}
      aria-expanded={expanded}
      aria-controls={bodyId}
      aria-label={expanded ? t('Hide goal details') : t('Show goal details')}
      title={expanded ? t('Hide goal details') : t('Show goal details')}
      className={ICON_BUTTON}
    >
      <ChevronDown size={14} className={`transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`} />
    </button>
  )

  // A finished goal's footer already says who finished it and when.
  const expandedMeta = finished
    ? timeAgo
    : `${goal.updatedBy === 'agent' ? t('Set by Halo') : t('Set by you')} · ${timeAgo}`

  const footerText = goal.status === 'complete'
    ? t('Completed by Halo {{time}}.', { time: timeAgo })
    : goal.status === 'abandoned'
      ? t('Abandoned {{time}}.', { time: timeAgo })
      : t('Halo will check the result against these before finishing.')

  return shell(
    <div
      className={entering ? 'animate-slide-down' : ''}
      onAnimationEnd={(e) => { if (e.target === e.currentTarget) setEntering(false) }}
    >
      <section
        role="region"
        aria-label={t('Goal')}
        onKeyDown={handleKeyDown}
        className={`relative overflow-hidden rounded-t-xl border border-b-0 border-border/70 text-xs
          ${goal.status === 'complete' ? 'bg-halo-success/[0.06]' : 'bg-secondary/40'}`}
      >
        {/* Replays per live change without remounting the controls, so focus stays put. */}
        {highlight > 0 && (
          <span
            key={highlight}
            aria-hidden
            className="pointer-events-none absolute inset-1 rounded-lg animate-[pulse-highlight_600ms_ease-in-out_1]"
          />
        )}
        {/* Header row */}
        <div className="flex items-center gap-1.5 min-h-8 pl-3 pr-1">
          <GoalStatusIcon goal={goal} running={running} pending={!!pendingHint} />
          <span title={updatedTitle} className={`shrink-0 font-medium ${finished ? 'text-foreground/80' : 'text-foreground'}`}>{label}</span>
          {!expanded && (
            <>
              <span className="shrink-0 text-muted-foreground" aria-hidden>·</span>
              <button
                type="button"
                onClick={handleObjectiveClick}
                onFocus={() => { objectiveFocusedRef.current = true }}
                onBlur={() => { objectiveFocusedRef.current = false }}
                title={goal.objective}
                aria-expanded={false}
                aria-controls={bodyId}
                className={`flex-1 min-w-0 truncate text-left rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50
                  ${goal.status === 'abandoned' ? 'line-through text-muted-foreground' : 'text-foreground/80 hover:text-foreground'}`}
              >
                {goal.objective}
              </button>
            </>
          )}
          {expanded && <span className="flex-1" />}
          <span className="hidden sm:flex items-center gap-1.5 shrink-0 pl-1 text-[11px] text-muted-foreground">
            {pendingHint && <span className="text-primary/90">{pendingHint}</span>}
            {pendingHint && (expanded || criteriaCount > 0) && <span aria-hidden>·</span>}
            {!expanded && criteriaCount > 0 && <span>{criteriaLabel}</span>}
            {expanded && <span title={updatedTitle}>{expandedMeta}</span>}
          </span>
          {primaryAction}
          {finished && !expanded && (
            <button
              type="button"
              onClick={() => requestClear(goal)}
              aria-label={t('Dismiss')}
              title={t('Dismiss')}
              className={ICON_BUTTON}
            >
              <X size={14} />
            </button>
          )}
          {chevron}
        </div>

        {/* Details */}
        {expanded && (
          <div id={bodyId} className="px-3 pb-2.5 max-h-[min(40vh,320px)] overflow-y-auto animate-fade-in">
            {pendingHint && <p className="sm:hidden mb-1 text-[11px] text-primary/90">{pendingHint}</p>}
            <p
              onClick={(e) => { if (e.metaKey || e.ctrlKey) openEditor() }}
              className={`text-sm whitespace-pre-wrap break-words ${goal.status === 'abandoned' ? 'line-through text-muted-foreground' : 'text-foreground'}`}
            >
              {goal.objective}
            </p>
            {criteriaCount > 0 && (
              <>
                <div className="mt-2.5 mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70 select-none">
                  {t('Done when')}
                </div>
                <ul className="space-y-0.5 pl-4 list-disc marker:text-muted-foreground/60 text-foreground/90">
                  {goal.doneWhen.map((criterion, i) => (
                    <li key={i} className="break-words">{criterion}</li>
                  ))}
                </ul>
              </>
            )}
            {goal.note && (
              <p className="mt-2 italic text-muted-foreground break-words">
                {t('Note: {{note}}', { note: goal.note })}
              </p>
            )}
            <div className="mt-2.5 pt-2 border-t border-border/60 flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="flex-1 min-w-[12rem] text-[11px] text-muted-foreground">{footerText}</span>
              <button
                type="button"
                onClick={() => requestClear(goal)}
                className="shrink-0 h-8 sm:h-7 px-2.5 rounded-md text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/40"
              >
                {finished ? t('Dismiss') : t('Clear goal')}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
