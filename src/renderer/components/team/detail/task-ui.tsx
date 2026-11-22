import { Fragment, type ReactNode } from 'react'
import { CheckCircle2, ChevronDown, ChevronRight, MinusCircle } from 'lucide-react'
import type { TFunction } from 'i18next'
import type { RosterMember, TeamActivity, TeamConversation, TeamDetail } from '../../../../shared/apps/team-types'
import { useTranslation } from '../../../i18n'
import { formatRunStart, formatTimeAgo } from '../../../utils/format-time'
import { getImChannelDisplay } from '../../apps/im-channel-labels'
import { failureCause } from '../workbench/progress'
import { failureCauseText, progressMemberName } from '../workbench/progress-labels'
import { addressedMember } from './crew'
import { RowCrew } from './crew-ui'
import { taskState, type TaskFact, type TaskStateKey } from './status'

const STATE_DOT: Partial<Record<TaskStateKey, string>> = {
  waiting_user: 'bg-halo-warning',
  waiting_member: 'bg-halo-warning',
  error: 'bg-halo-error',
  idle: 'bg-border',
}

const STATE_TONE: Partial<Record<TaskStateKey, string>> = {
  waiting_user: 'text-halo-warning',
  error: 'text-destructive',
}

export function stateLabel(key: TaskStateKey, t: TFunction): string {
  if (key === 'waiting_user') return t('Waiting for you')
  if (key === 'waiting_member') return t('Waiting for someone')
  if (key === 'error') return t('Errored')
  if (key === 'done') return t('Completed')
  if (key === 'idle') return t('Idle')
  return t('In progress')
}

export function factText(key: TaskStateKey, fact: TaskFact, roster: readonly RosterMember[], t: TFunction): string {
  if (fact.kind === 'decision') {
    if (fact.memberName && fact.question) return t('{{member}} asks: {{question}}', { member: fact.memberName, question: fact.question })
    return t('A decision is waiting for you')
  }
  if (fact.kind === 'error') {
    // Said as the task panel says it; an unrecognised engine error is quoted as it came.
    const failure = fact.failure
    const cause = failure ? failureCause(failure) : null
    const subject = !failure ? undefined
      : failure.senderAppId !== undefined ? t('Didn’t receive {{sender}}’s message', { sender: progressMemberName(roster, failure.senderAppId, t) })
        : cause ? failureCauseText(cause, t) : failure.reason
    if (subject) return fact.memberName ? t('{{member}} ran into a problem: {{subject}}', { member: fact.memberName, subject }) : subject
    return fact.memberName ? t('{{member}} ran into a problem', { member: fact.memberName }) : t('Errored')
  }
  if (fact.kind === 'waiting') {
    if (fact.owner) return t('Waiting for {{owner}} to confirm', { owner: fact.owner })
    return fact.memberName ? t('{{member}} is waiting for a confirmation', { member: fact.memberName }) : t('Waiting for someone')
  }
  if (fact.kind === 'working') return fact.label ? t('{{member}} is working on {{task}}', { member: fact.memberName, task: fact.label }) : t('{{member}} is working', { member: fact.memberName })
  if (fact.kind === 'summary') return fact.text
  if (fact.kind === 'ended') return endedText(fact.by, fact.byMe, t)
  if (fact.kind === 'stalled') return t('No one is carrying it on')
  return stateLabel(key, t)
}

export function endedText(by: string | undefined, byMe: boolean | undefined, t: TFunction): string {
  if (byMe) return t('Ended by me')
  return by ? t('Ended by {{name}}', { name: by }) : t('Ended manually')
}

export type TaskSource = 'mine' | 'involved' | 'scheduled' | 'im' | 'others'

export function taskSource(task: TeamConversation): TaskSource {
  if (task.kind === 'im') return 'im'
  if (task.kind === 'run') return 'scheduled'
  if (task.createdByMe) return 'mine'
  if (task.involvedMe) return 'involved'
  return 'others'
}

/** "Involves me" also takes in the work I started; every other source matches its own tasks only. */
export function matchesSource(task: TeamConversation, source: TaskSource | 'all'): boolean {
  if (source === 'all') return true
  const own = taskSource(task)
  return own === source || (source === 'involved' && own === 'mine')
}

export function sourceLabel(source: TaskSource | 'all', t: TFunction): string {
  if (source === 'mine') return t('Started by me')
  if (source === 'involved') return t('Involves me')
  if (source === 'scheduled') return t('Automatic runs')
  if (source === 'im') return t('IM')
  if (source === 'others') return t('Other people')
  return t('All sources')
}

/** Where work nobody here started came from, or which member a direct question went to; null for conversations with the lead. */
export function taskOrigin(detail: TeamDetail, task: TeamConversation, t: TFunction): string | null {
  if (task.kind === 'im') return t('From {{channel}}', { channel: imChannelName(task, t) })
  const addressed = addressedMember(detail, task)
  if (addressed) {
    const member = progressMemberName(detail.roster, addressed, t)
    if (task.createdByMe) return t('I asked {{member}}', { member })
    if (task.startedBy) return t('{{name}} asked {{member}}', { name: task.startedBy, member })
    return t('Asked {{member}}', { member })
  }
  if (task.kind !== 'run') return null
  if (task.triggerType === 'schedule') return t('Run on schedule')
  if (task.triggerType === 'http') return t('Run by webhook')
  if (task.triggerType === 'event') return t('Run by event')
  return t('Run manually')
}

export function imChannelName(task: TeamConversation, t: TFunction): string {
  return task.channel ? t(getImChannelDisplay(task.channel).label) : t('IM')
}

export const PANEL_ACTION = 'inline-flex h-8 shrink-0 items-center gap-1 rounded-full bg-secondary px-3.5 text-[13px] text-foreground transition-colors hover:bg-surface-hover disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
export const PILL_PRIMARY = 'inline-flex h-8 items-center gap-1 rounded-full bg-foreground px-3.5 text-[13px] font-medium text-background transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
export const PILL_SECONDARY = 'inline-flex h-8 items-center rounded-full bg-secondary px-3.5 text-[13px] text-foreground transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
/** A secondary action on a tinted "needs you" card. */
export const PILL_ON_TINT = 'inline-flex h-8 items-center rounded-full bg-background px-3.5 text-[13px] text-foreground transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'

/** A task's state at a glance: a spinner while it runs, a check once done (a dash when a person ended it unfinished), else a dot. */
export function StateIcon({ state, ended = false, className = '' }: { state: TaskStateKey; ended?: boolean; className?: string }) {
  return <span aria-hidden="true" className={`grid size-[18px] shrink-0 place-items-center ${className}`}>
    {state === 'running' ? <i className="size-[13px] animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
      : state === 'done' && ended ? <MinusCircle size={16} data-done="" className="text-faint-foreground" />
      : state === 'done' ? <CheckCircle2 size={16} data-done="" className="text-halo-success" />
        : <i className={`size-2 rounded-full ${STATE_DOT[state]}`} />}
  </span>
}

/** A run carries the team's name as its label; it is named by what it settled on, else by the goal and its start, which tells such runs apart. */
export function taskTitle(detail: TeamDetail, task: TeamConversation, t: TFunction): string {
  if (task.kind === 'run' && task.label === detail.team.name) return task.summary || `${t('Work toward the team goal')} · ${formatRunStart(task.startedAt)}`
  return task.label || t('New task')
}

/** One task: name, the one fact that matters most, what it produced, when it last moved and, given `crew`, who is on it now. */
export function TaskRow({ detail, task, selected = false, crew, onOpen }: {
  detail: TeamDetail; task: TeamConversation; selected?: boolean; crew?: { recent: readonly TeamActivity[]; cap: number; size: number }; onOpen: () => void
}) {
  const { t } = useTranslation()
  const state = taskState(detail, task)
  const title = taskTitle(detail, task, t)
  // Finished or quiet work says so by its icon and group; a summary already used as the title is not repeated.
  const fact = (state.fact.kind === 'none' && (state.key === 'done' || state.key === 'idle')) || (state.fact.kind === 'summary' && state.fact.text === title)
    ? '' : factText(state.key, state.fact, detail.roster, t)
  // A run someone started by hand says nothing its row needs; finished work counts subtasks only when it left no outputs.
  const origin = task.kind === 'run' && (task.triggerType ?? 'manual') === 'manual' ? null : taskOrigin(detail, task, t)
  const subtasks = task.subtasks ? task.subtasks.done + task.subtasks.open : 0
  const time = formatTimeAgo(task.lastActivityAt, t)
  const counts = [
    task.artifactCount ? t('{{count}} outputs', { count: task.artifactCount }) : null,
    subtasks && !(state.key === 'done' && task.artifactCount) ? t('{{done}}/{{total}} subtasks', { done: task.subtasks!.done, total: subtasks }) : null,
  ].filter(Boolean).join(' · ')
  const line = [origin, fact, counts, time].filter(Boolean).join(' · ')
  const tone = state.fact.kind === 'stalled' ? 'text-muted-foreground' : STATE_TONE[state.key] ?? ''
  const parts = [origin, fact && <span className={tone}>{fact}</span>, counts].filter(Boolean)
  return <button onClick={onOpen} aria-current={selected ? 'true' : undefined} className={`task-row relative -mx-3 flex w-[calc(100%+24px)] items-center gap-3 rounded-[10px] px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${selected ? 'bg-secondary' : 'hover:bg-secondary/60'}`}>
    <StateIcon state={state.key} ended={state.fact.kind === 'ended'} />
    <span className="min-w-0 flex-1">
      <span className="block truncate text-[13.5px] font-medium text-foreground">{title}</span>
      <span title={line} className="mt-px block truncate text-xs text-subtle-foreground">
        {(!fact || state.fact.kind === 'summary') && <span className="sr-only">{stateLabel(state.key, t)} · </span>}
        {parts.map((part, index) => <Fragment key={index}>{index > 0 && ' · '}{part}</Fragment>)}
        <span className="sm:hidden">{parts.length > 0 && ' · '}{time}</span>
      </span>
    </span>
    {crew && <RowCrew detail={detail} task={task} recent={crew.recent} cap={crew.cap} size={crew.size} />}
    <span className="hidden min-w-[4.5rem] shrink-0 whitespace-nowrap text-right text-xs tabular-nums text-faint-foreground sm:block">{time}</span>
  </button>
}

/** The way into the members' conversations, counting their exchanges. */
export function MemberConversationsLink({ count, onOpen, className = '' }: { count: number; onOpen: () => void; className?: string }) {
  const { t } = useTranslation()
  return <button type="button" onClick={onOpen} className={`inline-flex min-h-8 min-w-0 items-center gap-1 rounded text-[12.5px] text-subtle-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${className}`}>
    <span className="truncate">{count ? t('Member conversations · {{count}} exchanges', { count }) : t('Member conversations')}</span>
    <ChevronRight size={13} aria-hidden="true" className="shrink-0" />
  </button>
}

export function SectionHeading({ title, count, children }: { title: string; count?: number; children?: ReactNode }) {
  return <div className="mb-1.5 ml-0.5 flex items-baseline gap-1.5">
    <h3 className="text-[13px] font-medium text-foreground/85">{title}</h3>
    {count !== undefined && <span className="text-[13px] tabular-nums text-faint-foreground">{count}</span>}
    {children && <div className="ml-auto self-center">{children}</div>}
  </div>
}

/** Expands a cut list; its label starts where the rows' titles start, past their icon column. */
export function MoreToggle({ up = false, onClick, children }: { up?: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" aria-expanded={up} onClick={onClick} className="ml-6 mt-1 inline-flex items-center gap-0.5 rounded-md px-1.5 py-1 text-[12px] text-subtle-foreground transition-colors hover:bg-secondary/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
    {children}
    <ChevronDown size={12} aria-hidden="true" className={`transition-transform ${up ? 'rotate-180' : ''}`} />
  </button>
}
