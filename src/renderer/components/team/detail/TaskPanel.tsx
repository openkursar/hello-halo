import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, RefreshCw } from 'lucide-react'
import type { TeamConversation, TeamDetail } from '../../../../shared/apps/team-types'
import type { TeamTaskViewMemory } from '../../../services/canvas-lifecycle'
import { useTranslation } from '../../../i18n'
import { useAppsStore } from '../../../stores/apps.store'
import { openTeamConversation } from '../../../utils/team-conversation-navigation'
import { KeepTeam } from '../TeamTaskOverview'
import { orderTaskMembers } from '../workbench/member-rail'
import { detailForTask, ownedTaskMembers } from '../workbench/members'
import type { TaskActivityKind } from '../workbench/model'
import { useTaskActivity } from '../workbench/useTaskActivity'
import { useTaskBoard } from '../workbench/useTaskBoard'
import { useHeldDecisions } from './DecisionCard'
import { MemberWork } from './MemberWork'
import { PanelBar, PanelClose } from './PanelBar'
import { imChannelName, PANEL_ACTION, taskTitle } from './task-ui'
import { TaskBody, useTaskOverview } from './TaskBody'

export interface TaskPanelReveal {
  seq: number
  activityId?: string
  memberAppId?: string
  decisionId?: string
}

/** One task, read like an AI client's answer: the lead's brief, the plan as steps, and what came out. */
export function TaskPanel({ detail: teamDetail, task, taskSpaceId, docked, memory, reveal, onRevealHandled, onClose, onOpenTask }: {
  detail: TeamDetail
  task: TeamConversation
  taskSpaceId: string | null
  docked: boolean
  memory: TeamTaskViewMemory
  reveal?: TaskPanelReveal
  onRevealHandled: (seq: number) => void
  onClose: () => void
  onOpenTask?: (epochId: string) => void
}) {
  const { t } = useTranslation()
  const baseDetail = useMemo(() => detailForTask(teamDetail, task), [teamDetail, task])
  const boardState = useTaskBoard(baseDetail, task.epochId)
  // A temporary team's members join this one task, so only its board lists them.
  const detail = useMemo(() => detailForTask(teamDetail, task, boardState.board), [teamDetail, task, boardState.board])
  const [drill, setDrill] = useState<string | null>(memory.memberAppId ?? null)
  const [all, setAll] = useState(!memory.memberAppId && !!memory.allMembers)
  const [open, setOpen] = useState<Record<string, boolean>>(memory.open ?? {})
  const [focus, setFocus] = useState<{ seq: number; activityId: string } | null>(null)
  const [kind, setKind] = useState<TaskActivityKind | null>(null)
  const [stuck, setStuck] = useState(false)
  const titleRowRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    memory.open = open
    memory.memberAppId = drill ?? undefined
    memory.allMembers = all || undefined
  }, [memory, open, drill, all])
  const data = useTaskActivity(detail, task, boardState, !drill)
  const held = useHeldDecisions(data.pending)
  const apps = useAppsStore(state => state.apps)
  const owned = useMemo(() => ownedTaskMembers(detail, apps).map(member => member.appId), [detail, apps])

  const lastMember = useRef(memory.memberAppId ?? null)
  const openMember = (appId: string) => {
    lastMember.current = appId
    setAll(false)
    setDrill(appId)
  }
  const byMember = (lastMember.current && detail.roster.some(member => member.appId === lastMember.current) ? lastMember.current : null)
    ?? orderTaskMembers(detail.roster, owned)[0]?.appId
  const openAll = () => {
    setDrill(null)
    setAll(true)
    setFocus(null)
  }
  const closeTalk = () => {
    setDrill(null)
    setAll(false)
  }
  const showActivity = (activityId: string, seq: number) => {
    openAll()
    setFocus({ seq, activityId })
  }
  const handled = useRef(onRevealHandled)
  handled.current = onRevealHandled
  const pendingRef = useRef(data.pending)
  pendingRef.current = data.pending
  useEffect(() => {
    if (!reveal) return
    if (reveal.memberAppId) openMember(reveal.memberAppId)
    else if (reveal.decisionId) {
      closeTalk()
      const decision = pendingRef.current.find(item => item.entryId === reveal.decisionId)
      if (decision) held.setAnswering(decision)
    } else if (reveal.activityId) showActivity(reveal.activityId, reveal.seq)
    handled.current(reveal.seq)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal])

  const overview = useTaskOverview(detail, task, data)
  const { progress } = overview

  const openConversation = () => {
    if (!taskSpaceId) return
    openTeamConversation(taskSpaceId, { teamId: detail.team.id, epochId: task.epochId, teamName: detail.team.name, label: task.label, appId: drill && owned.includes(drill) ? drill : undefined })
  }
  const action = task.kind === 'im'
    ? <p className="min-w-0 truncate text-right text-xs text-faint-foreground">{t('Reply in {{channel}}', { channel: imChannelName(task, t) })}</p>
    : <button onClick={openConversation} disabled={!taskSpaceId} className={PANEL_ACTION}>{t('Open conversation')}<span aria-hidden="true">↗</span></button>
  const title = taskTitle(detail, task, t)

  const drilled = drill ? detail.roster.find(member => member.appId === drill) : undefined
  if (drilled || all) return <MemberWork detail={detail} task={task} member={drilled} progress={progress} boardState={boardState} data={data} focus={focus} kind={kind} onKindChange={setKind}
    owned={!!drilled && owned.includes(drilled.appId)} docked={docked}
    lockedReason={task.kind === 'im' ? t('Reply in {{channel}}', { channel: imChannelName(task, t) }) : undefined} onContinue={task.kind === 'im' || !taskSpaceId ? undefined : openConversation}
    onAll={openAll} onByMember={byMember ? () => openMember(byMember) : undefined} onDrill={openMember} onBack={closeTalk} onClose={onClose} onActivity={activityId => activityId ? showActivity(activityId, Date.now()) : closeTalk()} onOpenTask={onOpenTask} />

  // Docked, the action and the way out sit beside the title; once it scrolls away a slim bar keeps them in reach.
  const onScroll = (top: number) => {
    const row = titleRowRef.current
    setStuck(!!row && top >= row.offsetTop + row.offsetHeight)
  }

  return <div className="flex h-full min-h-0 flex-col">
    {!docked && <PanelBar docked={docked} onBack={onClose} onClose={onClose}>{action}</PanelBar>}
    <div onScroll={docked ? event => onScroll(event.currentTarget.scrollTop) : undefined} className={`relative min-h-0 flex-1 overflow-y-auto ${docked && stuck ? '[--page-sticky-top:3rem]' : ''}`}>
      {docked && <div className="sticky top-0 z-10 h-0">
        <div className={`absolute inset-x-0 top-0 flex h-12 items-center gap-2 border-b border-border-soft bg-background pl-5 pr-3 transition-[opacity,visibility] duration-150 sm:pl-6 ${stuck ? 'visible opacity-100' : 'invisible opacity-0'}`}>
          <p title={title} className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{title}</p>
          {action}
          <PanelClose onClose={onClose} />
        </div>
      </div>}
      <div className={`px-5 pb-12 sm:px-6 ${docked ? 'pt-4' : 'pt-1'}`}>
        {data.failed && <div role="alert" className="mb-3 flex items-start gap-2 rounded-xl bg-destructive/5 p-3 text-xs text-destructive">
          <AlertCircle size={15} className="shrink-0" /><span className="flex-1">{t('Could not load conversation history.')}</span>
          <button onClick={data.retry} className="inline-flex shrink-0 items-center gap-1 rounded hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><RefreshCw size={12} />{t('Retry')}</button>
        </div>}

        <div ref={titleRowRef} className="flex items-start gap-3">
          <h2 title={title} className="line-clamp-2 min-w-0 flex-1 break-words py-[3px] text-[18px] font-semibold leading-[1.45] tracking-[-0.01em]">{title}</h2>
          {detail.team.ephemeral && <KeepTeam team={detail.team} />}
          {docked && <div className="-mr-2 flex shrink-0 items-center gap-1">{action}<PanelClose onClose={onClose} /></div>}
        </div>
        <TaskBody detail={detail} task={task} taskSpaceId={taskSpaceId} data={data} overview={overview} held={held} open={open} setOpen={setOpen}
          onOpenMember={openMember} onOpenAll={openAll} onOpenExchange={id => showActivity(id, Date.now())} />
      </div>
    </div>
  </div>
}
