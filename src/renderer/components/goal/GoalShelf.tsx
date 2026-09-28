/**
 * GoalShelf — the conversation's goal, attached to the top edge of the
 * composer card.
 *
 * Absent until the conversation has a goal. One row: what state the goal is in,
 * what it is, and the actions on it. The goal itself is read and edited in its
 * canvas tab, so the shelf keeps no second copy of it. Live changes from Halo
 * animate and are announced; a goal already there when the conversation opens
 * simply appears, so switching conversations never plays an entrance.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Pencil, Plus, Trash2, X } from 'lucide-react'
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
const DESTRUCTIVE_ICON_BUTTON =
  'shrink-0 inline-flex items-center justify-center h-8 w-8 sm:h-7 sm:w-7 rounded-md text-muted-foreground ' +
  'hover:text-destructive hover:bg-destructive/10 transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/40'

function sameRevision(a: Goal | null, b: Goal | null): boolean {
  if (!a || !b) return a === b
  return a.objective === b.objective &&
    a.status === b.status &&
    a.updatedAt === b.updatedAt &&
    a.doneWhen.length === b.doneWhen.length &&
    a.doneWhen.every((c, i) => c === b.doneWhen[i])
}

export function GoalShelf({ spaceId, conversationId, running, onNewGoal }: GoalShelfProps) {
  const { t } = useTranslation()
  const goal = useConversationGoal(conversationId)
  const unseen = useGoalUnseenByModel(conversationId)
  const undo = useGoalUiStore((s) => s.undo.get(conversationId))
  const { requestClear, confirmDialog } = useClearGoal(spaceId, conversationId, running)

  const sectionRef = useRef<HTMLElement>(null)
  // Undo that held focus hands it to the restored shelf.
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
    }
  }, [goal, conversationId, t])

  const timeAgo = useTimeAgo(goal?.updatedAt)

  useLayoutEffect(() => {
    if (!goal || !undoFocusedRef.current) return
    undoFocusedRef.current = false
    sectionRef.current?.focus()
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

  const actions = finished ? (
    <>
      {/* Finished goals still need a way back into the tab: once it is closed
          the shelf is the only entry, and done-when/note live in the editor. */}
      <button type="button" onClick={openEditor} aria-label={t('Edit goal')} title={t('Edit goal')} className={ICON_BUTTON}>
        <Pencil size={13} />
      </button>
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
      <button
        type="button"
        onClick={() => requestClear(goal)}
        aria-label={t('Dismiss')}
        title={t('Dismiss')}
        className={ICON_BUTTON}
      >
        <X size={14} />
      </button>
    </>
  ) : (
    <>
      <button type="button" onClick={openEditor} aria-label={t('Edit goal')} title={t('Edit goal')} className={ICON_BUTTON}>
        <Pencil size={13} />
      </button>
      <button
        type="button"
        onClick={() => requestClear(goal)}
        aria-label={t('Clear goal')}
        title={t('Clear goal')}
        className={DESTRUCTIVE_ICON_BUTTON}
      >
        <Trash2 size={14} />
      </button>
    </>
  )

  return shell(
    <div
      className={entering ? 'animate-slide-down' : ''}
      onAnimationEnd={(e) => { if (e.target === e.currentTarget) setEntering(false) }}
    >
      <section
        ref={sectionRef}
        role="region"
        aria-label={t('Goal')}
        tabIndex={-1}
        className={`relative overflow-hidden rounded-t-xl border border-b-0 border-border/70 text-xs
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50
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
          <span className="shrink-0 text-muted-foreground" aria-hidden>·</span>
          <span
            title={goal.objective}
            className={`flex-1 min-w-0 truncate ${goal.status === 'abandoned' ? 'line-through text-muted-foreground' : 'text-foreground/80'}`}
          >
            {goal.objective}
          </span>
          <span className="hidden sm:flex items-center gap-1.5 shrink-0 pl-1 text-[11px] text-muted-foreground">
            {pendingHint && <span className="text-primary/90">{pendingHint}</span>}
            {pendingHint && criteriaCount > 0 && <span aria-hidden>·</span>}
            {criteriaCount > 0 && <span>{criteriaLabel}</span>}
          </span>
          {actions}
        </div>
      </section>
    </div>
  )
}
