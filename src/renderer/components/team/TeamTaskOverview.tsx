import { useState, type Dispatch, type SetStateAction } from 'react'
import type { TFunction } from 'i18next'
import { BookmarkPlus, ChevronRight } from 'lucide-react'
import type { TeamConversation, TeamDetail } from '../../../shared/apps/team-types'
import { useTranslation } from '../../i18n'
import { canvasLifecycle } from '../../services/canvas-lifecycle'
import { useTeamStore } from '../../stores/team.store'
import { AutomationAvatar } from '../apps/AutomationAvatar'
import type { HeldDecisions } from './detail/DecisionCard'
import { TaskBody, type TaskOverview } from './detail/TaskBody'
import { progressMemberName } from './workbench/progress-labels'
import type { TaskActivityData } from './workbench/useTaskActivity'

/** The overview a team task opens on beside its chat: the team as context, then the task as the team page shows it. */
export function TeamTaskOverview({ detail, task, taskSpaceId, data, overview, held, open, setOpen, onOpenWork, onTalkTo, onOpenExchange, onGo }: {
  detail: TeamDetail; task: TeamConversation; taskSpaceId: string; data: TaskActivityData; overview: TaskOverview; held: HeldDecisions
  open: Readonly<Record<string, boolean>>
  setOpen: Dispatch<SetStateAction<Record<string, boolean>>>
  /** A member's work on this task, inside the team. */
  onOpenWork: (appId: string) => void
  /** Switches the chat beside to a member. */
  onTalkTo: (appId: string) => void
  onOpenExchange: (activityId: string) => void
  onGo: (page: 'history' | 'members') => void
}) {
  const { t } = useTranslation()
  const roster = detail.roster
  const stateOf = new Set(overview.progress.members.map(row => row.appId))
  const memberNames = [...overview.progress.members.map(row => row.appId), ...roster.filter(member => !stateOf.has(member.appId)).map(member => member.appId)]
    .map(appId => progressMemberName(roster, appId, t))
  const taskTitle = task.label || (detail.team.ephemeral ? t('Temporary collaboration') : t('New team conversation'))

  return <>
    <div className="flex items-center gap-3">
      <button onClick={() => onGo('members')} className="-ml-1 flex min-w-0 items-center gap-2 rounded-full py-0.5 pl-1 pr-2 text-[12.5px] text-subtle-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
        {memberNames.length > 0 && <AvatarStack names={memberNames} />}
        <span className="truncate">
          <span className="font-medium text-foreground/80">{detail.team.ephemeral ? t('Temporary team') : detail.team.name}</span>
          {memberNames.length > 0 && <> · {memberList(memberNames, t)}</>}
        </span>
      </button>
      <span className="flex-1" />
      {detail.team.ephemeral ? <KeepTeam team={detail.team} />
        : <button onClick={() => void canvasLifecycle.openTeam(detail.team.id, detail.team.name)} className="flex min-h-8 shrink-0 items-center gap-0.5 rounded-lg px-2 text-xs text-subtle-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
          {t('Team details')}<ChevronRight size={12} aria-hidden="true" />
        </button>}
    </div>

    <h2 title={taskTitle} className="mt-3 line-clamp-2 break-words text-[18px] font-semibold leading-[1.45] tracking-[-0.01em]">{taskTitle}</h2>
    <TaskBody detail={detail} task={task} taskSpaceId={taskSpaceId} data={data} overview={overview} held={held} open={open} setOpen={setOpen}
      onOpenMember={onOpenWork} onOpenStepMember={onTalkTo} onOpenAll={() => onGo('history')} onOpenExchange={onOpenExchange} />
  </>
}

/** Keeps a temporary team, or opens the team it was kept as. */
export function KeepTeam({ team }: { team: TeamDetail['team'] }) {
  const { t } = useTranslation()
  const [saving, setSaving] = useState(false)
  const keep = async () => {
    setSaving(true)
    try { await useTeamStore.getState().saveCollab(team.id) } finally { setSaving(false) }
  }
  const action = 'flex shrink-0 items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs text-primary hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50'
  return team.savedTeamId
    ? <button onClick={() => void canvasLifecycle.openTeam(team.savedTeamId!)} className={action}>{t('Open saved team')}<ChevronRight size={12} aria-hidden="true" /></button>
    : <button disabled={saving} onClick={() => void keep()} className={action}><BookmarkPlus size={13} aria-hidden="true" />{t('Keep this team')}</button>
}

const NAMES_SHOWN = 3

/** "Ann, Bo, Cy and 2 more". */
function memberList(names: readonly string[], t: TFunction): string {
  const shown = names.slice(0, NAMES_SHOWN).reduce((first, next) => t('{{first}}, {{next}}', { first, next }))
  return names.length > NAMES_SHOWN ? t('{{names}} and {{count}} more', { names: shown, count: names.length - NAMES_SHOWN }) : shown
}

function AvatarStack({ names, limit = 4 }: { names: readonly string[]; limit?: number }) {
  return <span className="flex">
    {names.slice(0, limit).map((name, index) => <span key={index} className="-ml-[7px] flex rounded-full ring-2 ring-background first:ml-0"><AutomationAvatar name={name} size={24} /></span>)}
    {names.length > limit && <span className="-ml-[7px] flex h-6 min-w-6 items-center justify-center rounded-full bg-secondary px-1 text-[10.5px] font-medium tabular-nums text-subtle-foreground ring-2 ring-background">+{names.length - limit}</span>}
  </span>
}
