import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Settings, Users, PanelLeft, UserPlus, Play, Pause } from 'lucide-react'
import { isRemoteMember, type RosterMember, type TeamDetail } from '../../../shared/apps/team-types'
import { useTeamStore } from '../../stores/team.store'
import { useAppsStore } from '../../stores/apps.store'
import { useDefaultChatTarget, useTeamViewPrefsStore } from '../../stores/team-view-prefs.store'
import { useTranslation } from '../../i18n'
import { SettingsTab } from './SettingsTab'
import { TeamInviteDialog } from './TeamInviteDialog'
import { TaskSidebar } from './workbench/TaskSidebar'
import { TaskRoom } from './workbench/TaskRoom'
import { MemberRail } from './workbench/MemberRail'
import { TeamActivityDrawer } from './workbench/TeamActivityDrawer'
import { WorkbenchDrawer } from './workbench/WorkbenchDrawer'
import { useTaskBoard } from './workbench/useTaskBoard'
import { taskGroup, visibleTasks } from './workbench/model'

export function TeamView({ detail }: { detail: TeamDetail }) {
  const { t } = useTranslation()
  const [width, setWidth] = useState(() => window.innerWidth)
  const [taskQuery, setTaskQuery] = useState('')
  const [taskStatus, setTaskStatus] = useState('all')
  useEffect(() => {
    const resize = () => setWidth(window.innerWidth)
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  const conversations = useTeamStore(s => s.conversations)
  const tasksError = useTeamStore(s => s.conversationsError)
  const loadingTasks = useTeamStore(s => s.isLoadingConversations)
  const selectedId = useTeamStore(s => s.selectedConversationId)
  const select = useTeamStore(s => s.selectConversation)
  const tasks = useMemo(() => visibleTasks(conversations), [conversations])
  const task = conversations.find(item => item.epochId === selectedId) ?? null
  const taskBoard = useTaskBoard(detail, task?.epochId ?? null)
  const [executionTarget, setExecutionTarget] = useState<string | undefined>()
  const [activityTarget, setActivityTarget] = useState<string | undefined>()
  const [decisionTarget, setDecisionTarget] = useState<string | undefined>()
  const [roomKey, setRoomKey] = useState(0)
  const [drawer, setDrawer] = useState<'activity' | 'members' | 'tasks' | 'settings' | null>(null)
  const [settingsMember, setSettingsMember] = useState<string | null>(null)
  const [invite, setInvite] = useState(false)
  const [runningAction, setRunningAction] = useState(false)
  const setGroup = useTeamViewPrefsStore(s => s.setTaskGroup)
  const apps = useAppsStore(state => state.apps)
  const ownedMemberIds = useMemo(() => detail.members.filter(member => !isRemoteMember(member) && apps.some(app => app.id === member.appId)).map(member => member.appId), [detail.members, apps])
  const selectedMemberId = useDefaultChatTarget(detail.team.id, ownedMemberIds)
  const setDefaultMember = useTeamViewPrefsStore(state => state.setDefaultMember)
  const onTask = useCallback((id: string, decisionEntry = false, memberId?: string) => {
    const prefs = useTeamViewPrefsStore.getState()
    if (selectedId && selectedMemberId) prefs.rememberTaskMember(detail.team.id, selectedId, selectedMemberId)
    const remembered = memberId ?? prefs.memberByTask[detail.team.id]?.[id]
    if (remembered && ownedMemberIds.includes(remembered)) setDefaultMember(detail.team.id, remembered)
    const item = conversations.find(c => c.epochId === id)
    if (item) setGroup(detail.team.id, taskGroup(item), true)
    setDecisionTarget(undefined)
    if (decisionEntry) {
      const pending = (detail.pendingEscalations ?? []).filter(entry => entry.epochId === id)
        .sort((a, b) => (a.entry?.ts ?? 0) - (b.entry?.ts ?? 0))
      const decision = pending.find(entry => entry.appId === selectedMemberId) ?? pending[0]
      if (decision) {
        if (ownedMemberIds.includes(decision.appId)) setDefaultMember(detail.team.id, decision.appId)
        setDecisionTarget(decision.entryId)
      }
    }
    select(id); setRoomKey(key => key + 1); setDrawer(null)
  }, [conversations, detail, select, setGroup, selectedMemberId, ownedMemberIds, setDefaultMember, selectedId])
  const onMember = (member: RosterMember) => {
    if (task?.readonly || !ownedMemberIds.includes(member.appId)) {
      setSettingsMember(member.appId)
      setDrawer('settings')
      return
    }
    setDefaultMember(detail.team.id, member.appId)
    setDrawer(null)
  }
  const newTask = () => { setRoomKey(key => key + 1); select(null); setDrawer(null) }
  const taskSidebar = <TaskSidebar query={taskQuery} onQuery={setTaskQuery} status={taskStatus} onStatus={setTaskStatus} teamId={detail.team.id} tasks={tasks} selectedId={selectedId} isOwner={!detail.team.hostNodeId} onSelect={id => onTask(id, conversations.some(item => item.epochId === id && item.waitingUser))} onNew={newTask} />
  const members = <MemberRail detail={detail} selectedAppId={task?.readonly ? task.memberAppId ?? detail.team.leadAppId : selectedMemberId ?? undefined} selectableAppIds={task?.readonly ? [] : ownedMemberIds} onMember={onMember} onTask={(id, memberId, decisionId) => { onTask(id, false, memberId); if (decisionId) setDecisionTarget(decisionId) }} />
  return <div className="flex h-full min-h-0 flex-col">
    <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
      <button onClick={() => useTeamStore.getState().selectTeam(null)} aria-label={t('Back to teams')} className="rounded-lg p-2 hover:bg-secondary"><ArrowLeft size={18} /></button>
      <div className="min-w-0 flex-1"><h1 className="truncate text-sm font-medium">{detail.team.name}</h1><p className="truncate text-xs text-muted-foreground">{detail.team.goal}</p></div>
      <button onClick={() => setDrawer('tasks')} aria-label={t('Tasks')} className="rounded-lg p-2 hover:bg-secondary lg:hidden"><PanelLeft size={17} /></button>
      <button onClick={() => setDrawer('members')} aria-label={t('Members')} className="rounded-lg p-2 hover:bg-secondary xl:hidden"><Users size={17} /></button>
      <button onClick={() => { setSettingsMember(null); setDrawer('settings') }} aria-label={t('Team settings')} className="rounded-lg p-2 hover:bg-secondary"><Settings size={17} /></button>
    </header>
    {tasksError && <div role="alert" className="px-4 py-2 text-xs text-destructive">{tasksError} <button onClick={() => void useTeamStore.getState().loadConversations(detail.team.id)} className="underline">{t('Retry')}</button></div>}
    <div className="flex min-h-0 flex-1">
      {width >= 1024 && <div className="w-64 shrink-0 border-r border-border">{taskSidebar}</div>}
      <main className="flex min-w-0 flex-1 flex-col">
        {selectedId && !task ? <p role="status" className="p-6 text-sm text-muted-foreground">{loadingTasks ? t('Loading task…') : t('This task is unavailable. Refresh the task list to try again.')}</p> : <TaskRoom key={roomKey} detail={detail} decisionTarget={decisionTarget}
          onExecution={appId => { setExecutionTarget(appId); setActivityTarget(undefined); setDrawer('activity') }} task={task} tasks={tasks} onTask={onTask} onCreated={select} boardState={taskBoard} onActivity={id => { setExecutionTarget(undefined); setDecisionTarget(undefined); setActivityTarget(id); setDrawer('activity') }} />}

      </main>
      {width >= 1280 && <div className="w-48 shrink-0 border-l border-border">{members}</div>}
    </div>
    {drawer === 'activity' && task && <TeamActivityDrawer key={task.epochId} detail={detail} task={task} boardState={taskBoard} executionTarget={executionTarget} activityTarget={activityTarget} onClose={() => setDrawer(null)} onDecision={id => {
      setDrawer(null)
      const decision = detail.pendingEscalations?.find(entry => entry.entryId === id)
      if (decision && ownedMemberIds.includes(decision.appId)) setDefaultMember(detail.team.id, decision.appId)
      setDecisionTarget(id)
    }} />}
    {drawer === 'tasks' && width < 1024 && <WorkbenchDrawer title={t('Tasks')} onClose={() => setDrawer(null)}>{taskSidebar}</WorkbenchDrawer>}
    {drawer === 'members' && width < 1280 && <WorkbenchDrawer title={t('Members')} onClose={() => setDrawer(null)}>{members}</WorkbenchDrawer>}
    {drawer === 'settings' && <WorkbenchDrawer title={t('Team settings')} onClose={() => setDrawer(null)}>
      {!detail.team.hostNodeId && <div className="flex gap-2 border-b border-border p-3">
        <button onClick={() => { setDrawer(null); setInvite(true) }} className="flex items-center gap-1 rounded-lg border border-border px-3 py-2 text-xs"><UserPlus size={14} />{t('Invite')}</button>
        <button disabled={runningAction} onClick={async () => {
          setRunningAction(true)
          try { if (detail.team.currentEpochId) await useTeamStore.getState().pauseTeam(detail.team.id); else await useTeamStore.getState().runTeam(detail.team.id) }
          finally { setRunningAction(false) }
        }} className="flex items-center gap-1 rounded-lg border border-border px-3 py-2 text-xs">{detail.team.currentEpochId ? <Pause size={14} /> : <Play size={14} />}{detail.team.currentEpochId ? t('Pause') : t('Run')}</button>
      </div>}
      <SettingsTab detail={detail} openMemberId={settingsMember} onOpenMemberChange={setSettingsMember} />
    </WorkbenchDrawer>}
    {invite && <TeamInviteDialog teamId={detail.team.id} onClose={() => setInvite(false)} />}
  </div>
}
