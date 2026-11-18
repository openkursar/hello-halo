import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { ArrowUpRight } from 'lucide-react'
import type { RosterMember, TeamConversation, TeamDetail } from '../../../../shared/apps/team-types'
import { useTranslation } from '../../../i18n'
import { useTeamView } from '../../../stores/team.store'
import type { TaskActivityKind } from '../workbench/model'
import type { TaskProgress } from '../workbench/progress'
import { memberProgressText } from '../workbench/progress-labels'
import { TaskCollaborationHistory, TaskMemberExecution } from '../workbench/TaskActivitySections'
import { KindFilter } from '../workbench/TaskActivityTimeline'
import { TaskRoom } from '../workbench/TaskRoom'
import type { TaskActivityData } from '../workbench/useTaskActivity'
import type { TaskBoardState } from '../workbench/useTaskBoard'
import { memberOwner } from './member-ui'
import { PanelBar } from './PanelBar'
import { taskTitle } from './task-ui'

const NO_TASKS: TeamConversation[] = []

/**
 * The members' conversations in a task, laid out as the homepage conversation with its
 * composer locked: everyone's exchanges on one timeline, or one member's part.
 */
export function MemberWork({ detail, task, member, progress, boardState, data, focus, kind, onKindChange, owned, docked, lockedReason, onContinue, onAll, onByMember, onDrill, onBack, onClose, onActivity, onOpenTask }: {
  detail: TeamDetail
  task: TeamConversation
  /** Absent: everyone's exchanges. */
  member?: RosterMember
  progress: TaskProgress
  boardState: TaskBoardState
  data: TaskActivityData
  focus: { seq: number; activityId: string } | null
  kind: TaskActivityKind | null
  onKindChange: (kind: TaskActivityKind | null) => void
  owned: boolean
  docked: boolean
  /** Why nothing is sent here, when it is not the homepage's to continue. */
  lockedReason?: string
  onContinue?: () => void
  onAll: () => void
  /** Opens the member "By member" starts at; absent while nobody can be shown. */
  onByMember?: () => void
  onDrill: (appId: string) => void
  onBack: () => void
  onClose: () => void
  onActivity: (activityId?: string) => void
  onOpenTask?: (epochId: string) => void
}) {
  const { t } = useTranslation()
  const conversations = useTeamView(view => view.conversations) ?? NO_TASKS
  const [execution, setExecution] = useState<string | null>(null)
  const executing = execution ? detail.roster.find(item => item.appId === execution) : undefined
  const title = taskTitle(detail, task, t)

  if (executing && member) return <div className="flex h-full min-h-0 flex-col">
    <PanelBar docked={docked} backTo={member.memberName} onBack={() => setExecution(null)} onClose={onClose} />
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 pb-10 pt-1 sm:px-6">
      <TaskMemberExecution detail={detail} task={task} member={executing} homepageConversation />
    </div>
  </div>

  const action = onContinue && <button type="button" onClick={onContinue} className="inline-flex min-h-8 items-center gap-1 rounded-md px-1.5 text-xs text-primary hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
    {t('Continue on the homepage')}<ArrowUpRight size={13} aria-hidden="true" />
  </button>
  // Outside either view's scroll, so it stays put while reading and switching; the reserved gutter keeps it on the record's column.
  const bar = (byMember: boolean, filter?: ReactNode) => <>
    <PanelBar docked={docked} backTo={title} onBack={onBack} onClose={onClose} />
    <div className="shrink-0 overflow-hidden [scrollbar-gutter:stable]">
      <div className="mx-auto max-w-[calc(var(--chat-reading-width)+3rem)] px-6">
        <div className="flex items-center border-b border-border">
          <ViewSwitch byMember={byMember} onAll={onAll} onByMember={onByMember} />
          {filter && <div className="-mr-1.5 ml-auto">{filter}</div>}
        </div>
      </div>
    </div>
  </>

  if (!member) return <div className="flex h-full min-h-0 flex-col">
    {bar(false, (data.activities.length > 0 || data.reports.reports.length > 0) && <KindFilter bare value={kind} onChange={onKindChange} />)}
    <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"><div className="mx-auto max-w-[calc(var(--chat-reading-width)+3rem)] px-6 py-5">
      <TaskCollaborationHistory key={focus?.seq} data={data} detail={detail} task={task} focusActivityId={focus?.activityId} homepageConversation onOpenMember={onDrill} kind={kind} onKindChange={onKindChange} />
    </div></div>
  </div>

  const row = progress.members.find(item => item.appId === member.appId)
  const whose = [owned ? t('My digital human') : memberOwner(member, t), member.isLead ? t('Lead') : ''].filter(Boolean).join(' · ')
  const state = (row?.state === 'idle' && row.taskTitle ? t('Owns “{{task}}”', { task: row.taskTitle }) : row ? memberProgressText(row, detail.roster, t) : '')
    || member.duty?.trim() || member.role || ''
  const stateTone = row?.state === 'waiting' ? 'text-halo-warning' : row?.state === 'failed' ? 'text-destructive' : 'text-subtle-foreground'
  const line = [whose, state].filter(Boolean).join(' · ')
  const header = line && <p title={line} className="mb-5 truncate px-1 text-[12.5px] text-faint-foreground">{whose}{whose && state && ' · '}{state && <span className={stateTone}>{state}</span>}</p>

  return <div className="flex h-full min-h-0 flex-col">
    {bar(true)}
    <div className="min-h-0 flex-1">
      <TaskRoom homepageConversation viewOnly={{ header, reason: lockedReason, action }} detail={detail} task={task} selectedAppId={member.appId} boardState={boardState} tasks={conversations}
        onSelectMember={item => onDrill(item.appId)} onCreated={() => {}} onActivity={onActivity} onTask={id => onOpenTask?.(id)} onExecution={setExecution} />
    </div>
  </div>
}

function ViewSwitch({ byMember, onAll, onByMember }: { byMember: boolean; onAll: () => void; onByMember?: () => void }) {
  const { t } = useTranslation()
  const views = [
    { key: 'all', label: t('All exchanges'), selected: !byMember, open: onAll },
    { key: 'member', label: t('By member'), selected: byMember, open: onByMember },
  ]
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const list = event.currentTarget
    const next = views.find(view => !view.selected)
    if (!next?.open) return
    next.open()
    requestAnimationFrame(() => list.querySelector<HTMLElement>(`[data-view="${next.key}"]`)?.focus())
  }
  return <div role="tablist" aria-label={t('Member conversations')} onKeyDown={onKeyDown} className="flex shrink-0 gap-5">
    {views.map(view => <button key={view.key} type="button" role="tab" data-view={view.key} aria-selected={view.selected} tabIndex={view.selected ? 0 : -1}
      disabled={!view.selected && !view.open} onClick={() => { if (!view.selected) view.open?.() }}
      className={`relative inline-flex h-10 items-center whitespace-nowrap text-[13px] transition-colors after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary disabled:opacity-50 ${view.selected ? 'font-medium text-foreground after:bg-primary' : 'text-subtle-foreground hover:text-foreground'}`}>
      {view.label}
    </button>)}
  </div>
}
