import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertCircle, Loader2, RefreshCw } from 'lucide-react'
import type { BlackboardTask, TeamActivity, TeamConversation, TeamDetail } from '../../../shared/apps/team-types'
import type { TeamTaskViewMemory } from '../../services/canvas-lifecycle'
import { useTeamStore, useTeamView } from '../../stores/team.store'
import { useTeamViewPrefsStore } from '../../stores/team-view-prefs.store'
import { useCollabMemberViewStore } from '../../stores/collab-member-view.store'
import { navigateToConversation } from '../../utils/conversation-navigation'
import { useTranslation } from '../../i18n'
import { formatTimeAgo } from '../../utils/format-time'
import { openTeamConversation } from '../../utils/team-conversation-navigation'
import { AutomationAvatar } from '../apps/AutomationAvatar'
import type { OpenOutput } from './TeamArtifacts'
import { useHeldDecisions } from './detail/DecisionCard'
import { useTaskOverview } from './detail/TaskBody'
import { TeamTaskOverview } from './TeamTaskOverview'
import { detailForTask } from './workbench/members'
import type { MemberProgress, TaskProgress as Progress } from './workbench/progress'
import { memberProgressText, progressMemberName } from './workbench/progress-labels'
import { taskTime } from './workbench/time'
import { useTaskBoard } from './workbench/useTaskBoard'
import { useTaskActivity } from './workbench/useTaskActivity'
import { TaskCollaborationHistory, TaskMemberExecution } from './workbench/TaskActivitySections'

type Section = NonNullable<TeamTaskViewMemory['section']>
const SECTIONS: readonly Section[] = ['overview', 'history', 'members']

export interface TeamTaskReveal {
  seq: number
  activityId?: string
  memberAppId?: string
}

/** One team conversation's progress for the right canvas: an overview, with its outputs, collaboration record and members a step away. */
export function TeamTaskProgress({ spaceId, epochId, teamDetail, memory, reveal, onRevealHandled, onLeave, openFile }: {
  spaceId: string; epochId: string; teamDetail: TeamDetail
  /** Where the user was, so returning to the tab lands there again. */
  memory: TeamTaskViewMemory
  reveal?: TeamTaskReveal
  onRevealHandled: (seq: number) => void
  /** Called after navigating to the conversation, so a full-screen canvas can step aside. */
  onLeave?: () => void
  openFile?: OpenOutput
}) {
  const { t } = useTranslation()
  const conversations = useTeamView(view => view.conversations)
  const loading = useTeamView(view => view.isLoadingConversations)
  const task = conversations.find(item => item.epochId === epochId) ?? null
  if (!task) return <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
    {loading ? <Loader2 className="animate-spin text-muted-foreground" aria-label={t('Loading conversation…')} /> : <>
      <p role="alert" className="text-sm text-muted-foreground">{t('This conversation is unavailable. Refresh the conversation list to try again.')}</p>
      <button onClick={() => void useTeamStore.getState().loadConversations(teamDetail.team.id)} className="rounded px-3 py-2 text-sm text-primary">{t('Retry')}</button>
    </>}
  </div>
  return <TaskProgress spaceId={spaceId} task={task} teamDetail={teamDetail} memory={memory} reveal={reveal} onRevealHandled={onRevealHandled} onLeave={onLeave} openFile={openFile} />
}

function TaskProgress({ spaceId, task, teamDetail, memory, reveal, onRevealHandled, onLeave, openFile }: {
  spaceId: string; task: TeamConversation; teamDetail: TeamDetail; memory: TeamTaskViewMemory; reveal?: TeamTaskReveal; onRevealHandled: (seq: number) => void; onLeave?: () => void; openFile?: OpenOutput
}) {
  const { t } = useTranslation()
  const baseDetail = useMemo(() => detailForTask(teamDetail, task), [teamDetail, task])
  const boardState = useTaskBoard(baseDetail, task.epochId)
  // A temporary team's members join this one task, so only its board lists them.
  const detail = useMemo(() => detailForTask(teamDetail, task, boardState.board), [teamDetail, task, boardState.board])
  const [section, setSection] = useState<Section>(SECTIONS.includes(memory.section as Section) ? memory.section! : 'overview')
  const [open, setOpen] = useState<Record<string, boolean>>(memory.open ?? {})
  const [executionMember, setExecutionMember] = useState<string | null>(memory.memberAppId ?? null)
  useEffect(() => {
    memory.section = section
    memory.open = open
    memory.memberAppId = executionMember ?? undefined
  }, [memory, section, open, executionMember])
  const [focus, setFocus] = useState<{ seq: number; activityId: string } | null>(null)
  const data = useTaskActivity(detail, task, boardState, !executionMember, openFile)
  const handled = useRef(onRevealHandled)
  handled.current = onRevealHandled
  const showActivity = useRef((activityId: string, seq: number) => {
    setExecutionMember(null)
    setSection('history')
    setFocus({ seq, activityId })
  }).current
  useEffect(() => {
    if (!reveal) return
    if (reveal.memberAppId) setExecutionMember(reveal.memberAppId)
    else if (reveal.activityId) showActivity(reveal.activityId, reveal.seq)
    handled.current(reveal.seq)
  }, [reveal, showActivity])

  const overview = useTaskOverview(detail, task, data)
  const held = useHeldDecisions(data.pending)

  // A temporary team's members show in the conversation that leads it, which only its own machine has.
  const onTalkTo = (appId: string) => {
    if (task.kind === 'collab') {
      const source = task.sourceConversation
      if (!source) return setExecutionMember(appId)
      useCollabMemberViewStore.getState().open(source.conversationId, appId)
      navigateToConversation(source.spaceId, source.conversationId)
      return onLeave?.()
    }
    useTeamViewPrefsStore.getState().rememberTaskMember(detail.team.id, task.epochId, appId)
    if (openTeamConversation(spaceId, { teamId: detail.team.id, epochId: task.epochId, teamName: detail.team.name, label: task.label, appId })) onLeave?.()
  }

  const back = (onClick: () => void) => <div className="sticky top-0 z-20 -mx-4 -mt-[18px] flex h-11 items-center bg-background px-4 sm:-mx-6 sm:-mt-[22px] sm:px-6">
    <button onClick={onClick} className="text-[12.5px] text-subtle-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">← {t('Team progress')}</button>
  </div>
  const inspected = detail.roster.find(member => member.appId === executionMember)
  return <div key={inspected ? `member:${inspected.appId}` : section} className="h-full overflow-y-auto">
    {/* Members are single-line lists that use extra width; the rest keep a reading width.
        The sticky back bar's height, so sticky content below it stops underneath instead of behind it. */}
    <div className={`mx-auto ${!inspected && section === 'members' ? 'max-w-5xl' : 'max-w-3xl'} px-4 pb-8 pt-[18px] [--page-sticky-top:2.75rem] sm:px-6 sm:pb-10 sm:pt-[22px]`}>
      {data.failed && <div role="alert" className="mb-3 flex items-start gap-2 rounded-xl bg-destructive/5 p-3 text-xs text-destructive"><AlertCircle size={15} className="shrink-0" /><span className="flex-1">{t('Could not load conversation history.')}</span><button onClick={data.retry} className="inline-flex shrink-0 items-center gap-1 rounded hover:underline"><RefreshCw size={12} />{t('Retry')}</button></div>}
      {inspected ? <>
        {back(() => setExecutionMember(null))}
        <div className="space-y-4"><TaskMemberExecution detail={detail} task={task} member={inspected} homepageConversation /></div>
      </> : section === 'overview' ? <TeamTaskOverview detail={detail} task={task} taskSpaceId={spaceId} data={data} overview={overview} held={held} open={open} setOpen={setOpen}
        onOpenWork={setExecutionMember} onTalkTo={onTalkTo} onOpenExchange={id => showActivity(id, Date.now())} onGo={setSection} />
        : <>
          {back(() => setSection('overview'))}
          {section === 'history' && <Page title={t('Collaboration record')} subtitle={t('How the lead split the work and what members handed over')}>
            <TaskCollaborationHistory key={focus?.seq} data={data} detail={detail} task={task} focusActivityId={focus?.activityId} homepageConversation onOpenMember={onTalkTo} />
          </Page>}
          {section === 'members' && <Page title={t('Members')} subtitle={t('{{count}} members', { count: detail.roster.length })}>
            <MembersPage detail={detail} progress={overview.progress} tasks={data.tasks} lastActs={overview.lastActs} onOpen={onTalkTo} />
          </Page>}
        </>}
    </div>
  </div>
}

function Page({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return <>
    <h2 className="mb-1 text-[17px] font-semibold">{title}</h2>
    {subtitle && <p className="mb-3.5 text-[12.5px] text-faint-foreground">{subtitle}</p>}
    {children}
  </>
}

type MemberGroup = 'waiting' | 'failed' | 'working' | 'pending' | 'done' | 'idle' | 'absent'

/** Every member of the team, with what each is doing or has done in this task. */
function MembersPage({ detail, progress, tasks, lastActs, onOpen }: {
  detail: TeamDetail; progress: Progress; tasks: readonly BlackboardTask[]; lastActs: ReadonlyMap<string, TeamActivity>; onOpen: (appId: string) => void
}) {
  const { t } = useTranslation()
  const progressOf = new Map(progress.members.map(row => [row.appId, row]))
  const groupOf = (row: MemberProgress | undefined): MemberGroup => !row ? 'absent'
    : row.state === 'waiting' ? (row.decisionId ? 'waiting' : 'working')
      : row.state === 'idle' ? (row.taskTitle ? 'pending' : 'idle') : row.state
  const record = (appId: string) => {
    const finished = tasks.filter(task => task.assigneeAppId === appId && task.status === 'done').sort((a, b) => b.updatedAt - a.updatedAt)
    if (finished.length > 1) return t('Finished “{{task}}” and {{count}} more', { task: finished[0].title, count: finished.length - 1 })
    if (finished.length) return t('Finished “{{task}}”', { task: finished[0].title })
    const split = tasks.filter(task => task.createdByAppId === appId && task.assigneeAppId !== appId).length
    if (split) return t('Split the work into {{count}} subtasks', { count: split })
    return lastActs.get(appId)?.subject ?? ''
  }
  const workOf = (row: MemberProgress | undefined, appId: string) => {
    if (!row) return detail.roster.find(member => member.appId === appId)?.duty ?? ''
    if (row.state === 'idle' && row.taskTitle) return t('Up next: “{{task}}”', { task: row.taskTitle })
    if (row.state === 'done') return record(appId) || t('Done')
    if (row.state === 'idle') return record(appId) || t('Idle')
    return memberProgressText(row, detail.roster, t)
  }
  const labels: Record<MemberGroup, string> = {
    waiting: t('Waiting on you'), failed: t('Errored'), working: t('In progress'), pending: t('Not started yet'),
    done: t('Completed'), idle: t('Idle'), absent: t('Not in this task'),
  }
  const groups = (Object.keys(labels) as MemberGroup[])
    .map(id => ({ id, members: detail.roster.filter(member => groupOf(progressOf.get(member.appId)) === id) }))
    .filter(group => group.members.length)
  const rowClass = '-mx-2.5 flex w-[calc(100%+20px)] items-center gap-3 rounded-xl px-2.5 py-[9px] text-left'
  return <>{groups.map(group => <section key={group.id}>
    <h3 className="mb-0.5 ml-0.5 mt-[18px] text-xs text-faint-foreground first:mt-0">{labels[group.id]} <span className="tabular-nums">{group.members.length}</span></h3>
    {group.members.map(member => {
      const row = progressOf.get(member.appId)
      const name = progressMemberName(detail.roster, member.appId, t)
      const text = workOf(row, member.appId)
      const at = taskTime(lastActs.get(member.appId)?.createdAt)
      const tone = group.id === 'waiting' ? 'text-halo-warning' : group.id === 'failed' ? 'text-destructive' : 'text-faint-foreground'
      const dot = row && row.state !== 'idle' ? row.state : null
      const content = <>
        <span className={`relative flex shrink-0 ${row ? '' : 'opacity-65 grayscale-[.6]'}`}>
          <AutomationAvatar name={name} size={26} />
          {dot && <i aria-hidden="true" data-tone={dot} className="avatar-status-dot" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{name}{member.role && <span className="font-normal text-faint-foreground"> · {member.role}</span>}</span>
          {text && <span title={text} className={`mt-px block truncate text-[12.5px] ${tone}`}>{text}</span>}
        </span>
        {at !== null && <span className="shrink-0 whitespace-nowrap text-xs text-faint-foreground">{formatTimeAgo(at, t)}</span>}
      </>
      return row
        ? <button key={member.appId} onClick={() => onOpen(member.appId)} className={`${rowClass} hover:bg-secondary/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary`}>{content}</button>
        : <div key={member.appId} className={rowClass}>{content}</div>
    })}
  </section>)}</>
}
