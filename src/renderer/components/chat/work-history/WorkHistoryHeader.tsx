/**
 * The one line above a reply that names its work: what it is doing while it
 * runs, "Work process · 12 min" once done. Opening it is the only action; the
 * disclosure cue shows on hover or keyboard focus, and always on touch. While
 * the reply runs this is the one place in its work that spins.
 */

import { ChevronRight, History, ListTodo, Loader2, XCircle } from 'lucide-react'
import { useTranslation } from '../../../i18n'

interface WorkHistoryHeaderProps {
  label: string
  live?: boolean
  hasError?: boolean
  /** How long the reply worked, shown once it is done. */
  duration?: string
  /** Task plan progress, kept in view while the work is folded. */
  tasks?: { done: number; total: number }
  open?: boolean
  /** Absent while there is nothing to open. */
  onToggle?: () => void
  /** The element the header opens. */
  controls?: string
  loading?: boolean
  /** The steps were not saved; the row reads as inert. */
  unavailable?: boolean
}

export function WorkHistoryHeader({
  label,
  live = false,
  hasError = false,
  duration,
  tasks,
  open = false,
  onToggle,
  controls,
  loading = false,
  unavailable = false,
}: WorkHistoryHeaderProps) {
  const { t } = useTranslation()
  const tasksDone = !!tasks && tasks.done === tasks.total

  const content = <>
    {live ? (
      <Loader2 size={14} className="shrink-0 animate-spin text-primary" />
    ) : hasError ? (
      <XCircle size={14} className="shrink-0 text-destructive" />
    ) : (
      // A record of what was done, not the reasoning step's lightbulb inside it.
      <History size={14} className={`shrink-0 ${unavailable ? 'text-faint-foreground' : 'text-primary'}`} />
    )}
    <span className="min-w-0 truncate">{label}</span>
    {duration && <span className="shrink-0 text-xs tabular-nums text-faint-foreground">· {duration}</span>}
    {tasks && tasks.total > 0 && (
      <span className={`inline-flex shrink-0 items-center gap-1 text-xs tabular-nums ${tasksDone ? 'text-halo-success' : ''}`}>
        <ListTodo size={12} />
        {t('Tasks {{done}}/{{total}}', { done: tasks.done, total: tasks.total })}
      </span>
    )}
    {loading ? (
      <Loader2 size={12} className="shrink-0 animate-spin" />
    ) : onToggle && (
      <ChevronRight
        size={12}
        aria-hidden="true"
        className={`shrink-0 transition-[transform,opacity] duration-200 ${open ? 'rotate-90' : ''} opacity-0 group-hover/work:opacity-100 group-focus-visible/work:opacity-100 [@media(hover:none)]:opacity-100`}
      />
    )}
  </>

  // The fill hugs the line and bleeds into the gutter, so the icon keeps the reply's left edge.
  const row = 'group/work -mx-1.5 flex w-fit max-w-[calc(100%+0.75rem)] min-h-8 items-center gap-[7px] rounded-[5px] px-1.5 py-1 text-left text-[13px] text-muted-foreground [@media(pointer:coarse)]:min-h-11'
  if (!onToggle && !loading) return <div className={row}>{content}</div>
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={loading || unavailable}
      aria-expanded={onToggle ? open : undefined}
      aria-controls={open ? controls : undefined}
      className={`${row} transition-colors duration-200 hover:bg-secondary/60 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary`}
    >
      {content}
    </button>
  )
}
