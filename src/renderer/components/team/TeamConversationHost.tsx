import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { RosterMember, TeamDetail } from '../../../shared/apps/team-types'
import { TeamViewContext, useTeamStore, useTeamView } from '../../stores/team.store'
import { useChatStore, type TeamChatTarget } from '../../stores/chat.store'
import { useTeamViewPrefsStore } from '../../stores/team-view-prefs.store'
import { useTranslation } from '../../i18n'
import { useCanvasActions } from '../../hooks/useCanvasLifecycle'
import type { RevealTarget } from '../../services/canvas-lifecycle'
import { TaskRoom } from './workbench/TaskRoom'
import { useTaskBoard } from './workbench/useTaskBoard'
import { useAppsStore } from '../../stores/apps.store'
import { detailForTask, involvedOwnMember, ownedTaskMembers } from './workbench/members'

/** Homepage host; team records and execution remain owned by the team module. */
export function TeamConversationHost({ spaceId, target }: { spaceId: string; target: TeamChatTarget }) {
  useEffect(() => useTeamStore.getState().retainTeamView(target.teamId), [target.teamId])
  return <TeamViewContext.Provider value={target.teamId}>
    <TeamConversationView key={target.teamId} spaceId={spaceId} target={target} />
  </TeamViewContext.Provider>
}

function TeamConversationView({ spaceId, target }: { spaceId: string; target: TeamChatTarget }) {
  const { t } = useTranslation()
  const detail = useTeamView(view => view.detail)
  const loading = useTeamView(view => view.isLoadingDetail)
  if (!detail) return <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4">
    {loading ? <Loader2 className="animate-spin text-muted-foreground" aria-label={t('Loading team…')} /> : <>
      <p role="alert" className="text-sm text-muted-foreground">{t('Could not open this team.')}</p>
      <button onClick={() => void useTeamStore.getState().loadDetail(target.teamId)} className="rounded px-3 py-2 text-sm text-primary">{t('Retry')}</button>
    </>}
  </div>
  return <TeamConversationRoom spaceId={spaceId} target={target} teamDetail={detail} />
}

function TeamConversationRoom({ spaceId, target, teamDetail }: { spaceId: string; target: TeamChatTarget; teamDetail: TeamDetail }) {
  const { t } = useTranslation()
  const conversations = useTeamView(view => view.conversations)
  const loading = useTeamView(view => view.isLoadingConversations)
  const error = useTeamView(view => view.conversationsError)
  const task = conversations.find(item => item.epochId === target.epochId) ?? null
  const baseDetail = useMemo(() => detailForTask(teamDetail, task), [teamDetail, task])
  const board = useTaskBoard(baseDetail, task?.epochId ?? null)
  // Who is working comes from this task's roster, which the board re-reads on every work pulse;
  // the team's own detail is not read again for it.
  const detail = useMemo(() => detailForTask(teamDetail, task, board.board), [teamDetail, task, board.board])
  const { openTeamTask } = useCanvasActions()
  const [room, setRoom] = useState({ epochId: target.epochId, key: 0 })
  const promoting = useRef<string | null>(null)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const selection = useRef({ epochId: target.epochId, appId: target.appId })
  if (selection.current.epochId !== target.epochId || selection.current.appId !== target.appId) {
    selection.current = { epochId: target.epochId, appId: target.appId }
  }
  const origin = selection.current
  if (room.epochId !== target.epochId) {
    const promotion = room.epochId === null && promoting.current === target.epochId
    setRoom({ epochId: target.epochId, key: promotion ? room.key : room.key + 1 })
  }
  const remembered = useTeamViewPrefsStore(state => target.epochId ? state.memberByTask[target.teamId]?.[target.epochId] : undefined)
  const apps = useAppsStore(state => state.apps)
  // Someone else's task opens on the digital human of mine that took part; the board tells which.
  const seeksParticipant = !!task && !target.appId && !remembered && task.createdByMe === false && task.involvedMe === true
  const participant = seeksParticipant ? involvedOwnMember(ownedTaskMembers(detail, apps), board.activities, board.board?.tasks ?? []) : undefined
  const resolvingParticipant = seeksParticipant && !board.board && !board.failed
  const chosen = target.appId ?? remembered ?? participant ?? task?.memberAppId ?? detail.team.leadAppId ?? null
  const member = detail.roster.find(item => item.appId === chosen)
  const selectedAppId = member?.appId ?? null
  const select = useCallback((next: TeamChatTarget) => useChatStore.getState().selectTeamConversation(spaceId, next), [spaceId])

  useEffect(() => {
    if (useChatStore.getState().spaceStates.get(spaceId)?.selectedTeamChat !== target) return
    // Until the task loads, the fallback member is only a guess; pinning it would outrank the task's own member.
    if (target.epochId && !task) return
    if ((selectedAppId && !target.appId) || (task && task.label !== target.label) || detail.team.name !== target.teamName) {
      select({ ...target, appId: target.appId ?? selectedAppId ?? undefined, label: task?.label ?? target.label, teamName: detail.team.name })
    }
  }, [selectedAppId, task, detail.team.name, target, select, spaceId])
  const taskEpochId = task?.epochId
  const openProgress = useCallback((reveal?: RevealTarget) => {
    if (taskEpochId) void openTeamTask({ spaceId, teamId: target.teamId, epochId: taskEpochId }, t('Team progress'), reveal ? { reveal } : {})
  }, [openTeamTask, spaceId, target.teamId, taskEpochId, t])
  const revealed = useRef<string | null>(null)
  useEffect(() => {
    const key = target.entryId && !target.decision && taskEpochId ? `${taskEpochId}:${target.entryId}` : null
    if (!key || revealed.current === key) return
    revealed.current = key
    openProgress({ activityId: target.entryId })
  }, [target.entryId, target.decision, taskEpochId, openProgress])

  const onMember = (next: RosterMember) => {
    if (target.epochId) useTeamViewPrefsStore.getState().rememberTaskMember(target.teamId, target.epochId, next.appId)
    select({ ...target, appId: next.appId, entryId: undefined, decision: undefined })
  }
  const onCreated = (epochId: string) => {
    const current = useChatStore.getState().spaceStates.get(spaceId)?.selectedTeamChat
    if (!mounted.current || selection.current !== origin || current?.teamId !== target.teamId || current.epochId !== null || current.appId !== target.appId) return
    promoting.current = epochId
    if (selectedAppId) useTeamViewPrefsStore.getState().rememberTaskMember(target.teamId, epochId, selectedAppId)
    select({ ...current, epochId })
  }
  const onTask = (epochId: string, decisionEntry = false) => {
    const next = conversations.find(item => item.epochId === epochId)
    if (!next || (next.kind !== 'native' && next.kind !== 'run')) return
    const decision = decisionEntry ? detail.pendingEscalations?.find(item => item.epochId === epochId) : undefined
    select({ teamId: target.teamId, epochId, teamName: detail.team.name, label: next.label,
      ...(decision ? { appId: decision.appId, entryId: decision.entryId, decision: true } : {}) })
  }

  if (resolvingParticipant) return <div className="flex min-h-0 flex-1 items-center justify-center p-4"><Loader2 className="animate-spin text-muted-foreground" aria-label={t('Loading conversation…')} /></div>
  if (target.epochId && !task) return <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4">
    <p role="status" className="text-sm text-muted-foreground">{loading ? t('Loading conversation…') : error || t('This conversation is unavailable. Refresh the conversation list to try again.')}</p>
    {!loading && <button onClick={() => void useTeamStore.getState().loadConversations(target.teamId)} className="rounded px-3 py-2 text-sm text-primary">{t('Retry')}</button>}
  </div>
  return <div className="flex h-full min-h-0 flex-col">
    {chosen && !selectedAppId && <p role="status" className="px-4 py-2 text-xs text-muted-foreground">{t('This member is unavailable. Choose another member to continue.')}</p>}
    <TaskRoom key={room.key} homepageConversation detail={detail} task={task} selectedAppId={selectedAppId}
      blocked={!!detail.legacyCoordinator} boardState={board} tasks={conversations.filter(item => item.kind === 'native' || item.kind === 'run')}
      decisionTarget={target.decision ? target.entryId : undefined} onSelectMember={onMember} onCreated={onCreated}
      onTask={onTask} onActivity={activityId => openProgress(activityId ? { activityId } : undefined)} onExecution={memberAppId => openProgress({ memberAppId })} />
  </div>
}
