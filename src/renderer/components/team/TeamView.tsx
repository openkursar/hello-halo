import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Info, Settings, Users, PanelLeft, UserPlus, Play, Pause, BookmarkPlus } from 'lucide-react'
import { isRemoteMember, type RosterMember, type TeamDetail } from '../../../shared/apps/team-types'
import { useTeamStore } from '../../stores/team.store'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { usePeopleViewStore } from '../../stores/people-view.store'
import { useAppsStore } from '../../stores/apps.store'
import { useDefaultChatTarget, useTeamViewPrefsStore } from '../../stores/team-view-prefs.store'
import { useTranslation } from '../../i18n'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/Popover'
import { SettingsTab } from './SettingsTab'
import { TeamInviteDialog } from './TeamInviteDialog'
import { TaskSidebar } from './workbench/TaskSidebar'
import { TaskRoom } from './workbench/TaskRoom'
import { MemberRail } from './workbench/MemberRail'
import { TeamActivityDrawer } from './workbench/TeamActivityDrawer'
import { WorkbenchDrawer } from './workbench/WorkbenchDrawer'
import { useTaskBoard } from './workbench/useTaskBoard'
import { taskGroup, visibleTasks } from './workbench/model'

export function TeamView({ detail, onBack }: { detail: TeamDetail; onBack?: () => void }) {
  const { t } = useTranslation()
  const navigationTarget = usePeopleViewStore(state => state.teamTarget)
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
  // A temporary space collaboration: coordinated from its space conversation,
  // so the persistent-team chrome (settings, invite, run/pause) stays hidden
  // and the one action offered is keeping the team.
  const isEphemeral = detail.team.ephemeral === true
  const [saving, setSaving] = useState(false)
  const saveTeam = async () => {
    if (saving) return
    setSaving(true)
    try {
      await useTeamStore.getState().saveCollab(detail.team.id)
    } finally {
      setSaving(false)
    }
  }
  const setGroup = useTeamViewPrefsStore(s => s.setTaskGroup)
  const apps = useAppsStore(state => state.apps)
  const ownedMemberIds = useMemo(() => detail.members.filter(member => !isRemoteMember(member) && apps.some(app => app.id === member.appId)).map(member => member.appId), [detail.members, apps])
  const defaultOwnedMemberId = useDefaultChatTarget(detail.team.id, ownedMemberIds)
  const rosterMemberIds = useMemo(() => detail.roster.map(member => member.appId), [detail.roster])
  const leadMemberId = detail.team.leadAppId && rosterMemberIds.includes(detail.team.leadAppId) ? detail.team.leadAppId : null
  const initialMemberId = defaultOwnedMemberId ?? leadMemberId ?? rosterMemberIds[0] ?? null
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(initialMemberId)
  const setDefaultMember = useTeamViewPrefsStore(state => state.setDefaultMember)
  useEffect(() => {
    if (selectedMemberId && rosterMemberIds.includes(selectedMemberId)) return
    setSelectedMemberId(initialMemberId)
  }, [initialMemberId, rosterMemberIds, selectedMemberId])
  const onTask = useCallback((id: string, decisionEntry = false, memberId?: string) => {
    const prefs = useTeamViewPrefsStore.getState()
    if (selectedId && selectedMemberId) prefs.rememberTaskMember(detail.team.id, selectedId, selectedMemberId)
    const item = conversations.find(c => c.epochId === id)
    let nextMember: string | null = memberId ?? prefs.memberByTask[detail.team.id]?.[id] ?? item?.memberAppId ?? defaultOwnedMemberId ?? leadMemberId
    if (item) setGroup(detail.team.id, taskGroup(item), true)
    setDecisionTarget(undefined)
    if (decisionEntry) {
      const pending = (detail.pendingEscalations ?? []).filter(entry => entry.epochId === id)
        .sort((a, b) => (a.entry?.ts ?? 0) - (b.entry?.ts ?? 0))
      const decision = pending.find(entry => entry.appId === selectedMemberId) ?? pending[0]
      if (decision) {
        nextMember = decision.appId
        setDecisionTarget(decision.entryId)
      }
    }
    if (!rosterMemberIds.includes(nextMember)) nextMember = rosterMemberIds[0] ?? null
    setSelectedMemberId(nextMember)
    if (nextMember) prefs.rememberTaskMember(detail.team.id, id, nextMember)
    if (nextMember && ownedMemberIds.includes(nextMember)) setDefaultMember(detail.team.id, nextMember)
    select(id); setRoomKey(key => key + 1); setDrawer(null)
  }, [conversations, defaultOwnedMemberId, detail, leadMemberId, select, setGroup, selectedMemberId, ownedMemberIds, rosterMemberIds, setDefaultMember, selectedId])
  useEffect(() => {
    if (!navigationTarget || navigationTarget.teamId !== detail.team.id || loadingTasks) return
    if (navigationTarget.epochId) {
      onTask(navigationTarget.epochId, false, navigationTarget.appId)
      if (navigationTarget.entryId) {
        if (navigationTarget.decision) setDecisionTarget(navigationTarget.entryId)
        else { setActivityTarget(navigationTarget.entryId); setDrawer('activity') }
      }
    } else if (navigationTarget.appId && rosterMemberIds.includes(navigationTarget.appId)) {
      setSelectedMemberId(navigationTarget.appId)
    }
    usePeopleViewStore.setState({ teamTarget: null })
  }, [navigationTarget, detail.team.id, loadingTasks, onTask, rosterMemberIds])
  const onMember = (member: RosterMember) => {
    setSelectedMemberId(member.appId)
    if (selectedId) useTeamViewPrefsStore.getState().rememberTaskMember(detail.team.id, selectedId, member.appId)
    if (ownedMemberIds.includes(member.appId)) setDefaultMember(detail.team.id, member.appId)
    setDrawer(null)
  }
  const newTask = () => { setSelectedMemberId(defaultOwnedMemberId ?? initialMemberId); setRoomKey(key => key + 1); select(null); setDrawer(null) }
  const taskSidebar = <TaskSidebar query={taskQuery} onQuery={setTaskQuery} status={taskStatus} onStatus={setTaskStatus} teamId={detail.team.id} roster={detail.roster} tasks={tasks} selectedId={selectedId} isOwner={!detail.team.hostNodeId} onSelect={id => onTask(id, conversations.some(item => item.epochId === id && item.waitingForMe))} onNew={newTask} />
  const members = <MemberRail detail={detail} selectedAppId={selectedMemberId ?? undefined} writableAppIds={ownedMemberIds} onMember={onMember} onDetails={member => { setSettingsMember(member.appId); setDrawer('settings') }} onTask={(id, memberId, decisionId) => { onTask(id, false, memberId); if (decisionId) setDecisionTarget(decisionId) }} />
  return <div className="flex h-full min-h-0 flex-col">
    <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
      <button onClick={() => onBack ? onBack() : useTeamStore.getState().selectTeam(null)} aria-label={t('Back to teams')} className="rounded-lg p-2 hover:bg-secondary"><ArrowLeft size={18} /></button>
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <h1 className="min-w-0 truncate text-sm font-medium">{detail.team.name}</h1>
        <Popover>
          <PopoverTrigger title={t('View team goal')} className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
            <Info size={14} aria-hidden="true" />
          </PopoverTrigger>
          <PopoverContent align="start" sideOffset={6} className="max-h-[calc(100vh-1rem)] w-80 max-w-[calc(100vw-1rem)] overflow-y-auto p-4">
            <h2 className="text-sm font-medium">{t('Team goal')}</h2>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-muted-foreground">{detail.team.goal.trim() || t('No team goal has been set.')}</p>
          </PopoverContent>
        </Popover>
      </div>
      {isEphemeral && <span className="hidden shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground sm:inline">{t('Temporary collaboration')}</span>}
      {isEphemeral && <button disabled={saving} onClick={() => void saveTeam()} className="flex shrink-0 items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs text-primary hover:bg-secondary disabled:opacity-50"><BookmarkPlus size={13} aria-hidden="true" />{t('Keep this team')}</button>}
      <button onClick={() => setDrawer('tasks')} aria-label={t('Tasks')} className="rounded-lg p-2 hover:bg-secondary lg:hidden"><PanelLeft size={17} /></button>
      <button onClick={() => setDrawer('members')} aria-label={t('Members')} className="rounded-lg p-2 hover:bg-secondary xl:hidden"><Users size={17} /></button>
      {!isEphemeral && <button onClick={() => { setSettingsMember(null); setDrawer('settings') }} aria-label={t('Team settings')} className="rounded-lg p-2 hover:bg-secondary"><Settings size={17} /></button>}
    </header>
    {tasksError && <div role="alert" className="px-4 py-2 text-xs text-destructive">{tasksError} <button onClick={() => void useTeamStore.getState().loadConversations(detail.team.id)} className="underline">{t('Retry')}</button></div>}
    <div className="flex min-h-0 flex-1">
      {width >= 1024 && <div className="w-64 shrink-0 border-r border-border">{taskSidebar}</div>}
      <main className="flex min-w-0 flex-1 flex-col">
        {selectedId && !task ? <p role="status" className="p-6 text-sm text-muted-foreground">{loadingTasks ? t('Loading task…') : t('This task is unavailable. Refresh the task list to try again.')}</p> : <TaskRoom key={roomKey} detail={detail} selectedAppId={selectedMemberId} onSelectMember={onMember} decisionTarget={decisionTarget}
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
    {drawer === 'settings' && <WorkbenchDrawer title={settingsMember ? t('Member details') : t('Team settings')} onClose={() => setDrawer(null)}>
      {!detail.team.hostNodeId && !isEphemeral && <div className="flex gap-2 border-b border-border p-3">
        <button onClick={() => { setDrawer(null); setInvite(true) }} className="flex items-center gap-1 rounded-lg border border-border px-3 py-2 text-xs"><UserPlus size={14} />{t('Invite')}</button>
        <button disabled={runningAction} onClick={async () => {
          setRunningAction(true)
          try { if (detail.team.currentEpochId) await useTeamStore.getState().pauseTeam(detail.team.id); else await useTeamStore.getState().runTeam(detail.team.id) }
          finally { setRunningAction(false) }
        }} className="flex items-center gap-1 rounded-lg border border-border px-3 py-2 text-xs">{detail.team.currentEpochId ? <Pause size={14} /> : <Play size={14} />}{detail.team.currentEpochId ? t('Pause') : t('Run')}</button>
      </div>}
      {settingsMember && ownedMemberIds.includes(settingsMember) && <button onClick={() => {
        usePeopleViewStore.setState({ returnTeam: { teamId: detail.team.id, epochId: selectedId ?? undefined, appId: selectedMemberId ?? undefined }, returnPerson: null })
        useAppsPageStore.getState().openActivityThread(settingsMember)
        useAppsPageStore.getState().setCurrentTab('my-digital-humans')
      }} className="m-3 min-h-10 rounded-lg border border-border px-3 text-sm text-primary">{t('Open digital human profile')}</button>}
      <SettingsTab detail={detail} openMemberId={settingsMember} onOpenMemberChange={setSettingsMember} />
    </WorkbenchDrawer>}
    {invite && <TeamInviteDialog teamId={detail.team.id} onClose={() => setInvite(false)} />}
  </div>
}
