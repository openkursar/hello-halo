import { memo, useEffect, useMemo, type ReactNode } from 'react'
import type { CollabSummary, TeamConversation, TeamDetail } from '../../../shared/apps/team-types'
import { useCollabSummary } from '../../hooks/useCollabSummary'
import { useCanvasActions } from '../../hooks/useCanvasLifecycle'
import { useTranslation } from '../../i18n'
import type { RevealTarget } from '../../services/canvas-lifecycle'
import { usePeopleViewStore } from '../../stores/people-view.store'
import { TeamViewContext, useTeamStore, useTeamView } from '../../stores/team.store'
import { detailForTask } from './workbench/members'
import { TaskMemberSelector } from './workbench/TaskMemberSelector'
import { TaskRoom } from './workbench/TaskRoom'
import { useTaskBoard } from './workbench/useTaskBoard'
import { useTaskProgress } from './workbench/useTaskProgress'

interface CollabWork { spaceId: string; collab: CollabSummary; teamDetail: TeamDetail; task: TeamConversation }

/**
 * The conversation bar of an ordinary conversation that started a temporary team.
 * The conversation itself leads the team, so the user keeps talking to it: an avatar
 * opens that member's work in place of the chat (`onOpenMember`), and questions are
 * answered in the team view. It subscribes to the collaboration itself, so a busy team
 * never re-renders the chat page.
 */
export const TeamCollabBar = memo(function TeamCollabBar({ spaceId, conversationId, onOpenMember }: { spaceId: string; conversationId?: string; onOpenMember: (appId: string) => void }) {
  const collab = useCollabSummary(conversationId)
  return <CollabScope spaceId={spaceId} collab={collab}>
    {work => <CollabMembers {...work} onOpenMember={onOpenMember} />}
  </CollabScope>
})

/**
 * One temporary member's work, shown where the conversation's chat was. It cannot be
 * messaged; `onSelect` switches member and `onReturn` goes back to the chat, which also
 * happens once the member or the team is gone.
 */
export function TeamCollabMemberView({ spaceId, conversationId, appId, onSelect, onReturn }: {
  spaceId: string; conversationId: string; appId: string; onSelect: (appId: string) => void; onReturn: () => void
}) {
  const collab = useCollabSummary(conversationId)
  useEffect(() => { if (collab === null || (collab && !collab.members.length)) onReturn() }, [collab, onReturn])
  return <div className="flex min-h-0 flex-1 flex-col">
    <CollabScope spaceId={spaceId} collab={collab}>
      {work => <CollabMemberRoom {...work} appId={appId} onSelect={onSelect} onReturn={onReturn} />}
    </CollabScope>
  </div>
}

function CollabScope({ spaceId, collab, children }: { spaceId: string; collab: CollabSummary | null | undefined; children: (work: CollabWork) => ReactNode }) {
  if (!collab || !collab.members.length) return null
  return <CollabTeam key={collab.teamId} spaceId={spaceId} collab={collab}>{children}</CollabTeam>
}

function CollabTeam({ spaceId, collab, children }: { spaceId: string; collab: CollabSummary; children: (work: CollabWork) => ReactNode }) {
  useEffect(() => useTeamStore.getState().retainTeamView(collab.teamId), [collab.teamId])
  return <TeamViewContext.Provider value={collab.teamId}>
    <CollabRoom spaceId={spaceId} collab={collab}>{children}</CollabRoom>
  </TeamViewContext.Provider>
}

function CollabRoom({ spaceId, collab, children }: { spaceId: string; collab: CollabSummary; children: (work: CollabWork) => ReactNode }) {
  const teamDetail = useTeamView(view => view.detail)
  const task = useTeamView(view => view.conversations).find(item => item.epochId === collab.epochId)
  if (!teamDetail || !task) return null
  return <>{children({ spaceId, collab, teamDetail, task })}</>
}

/** Collaborators join this one task, so only its board lists them. */
function useCollabDetail(teamDetail: TeamDetail, task: TeamConversation) {
  const baseDetail = useMemo(() => detailForTask(teamDetail, task), [teamDetail, task])
  const boardState = useTaskBoard(baseDetail, task.epochId)
  const detail = useMemo(() => detailForTask(teamDetail, task, boardState.board), [teamDetail, task, boardState.board])
  return { detail, boardState }
}

function useOpenProgress(spaceId: string, collab: CollabSummary, task: TeamConversation) {
  const { t } = useTranslation()
  const { openTeamTask } = useCanvasActions()
  return (reveal?: RevealTarget) => void openTeamTask({ spaceId, teamId: collab.teamId, epochId: task.epochId }, t('Team progress'), reveal ? { reveal } : {})
}

function CollabMembers({ spaceId, collab, teamDetail, task, onOpenMember }: CollabWork & { onOpenMember: (appId: string) => void }) {
  const { openTeam } = useCanvasActions()
  const { detail, boardState } = useCollabDetail(teamDetail, task)
  const openProgress = useOpenProgress(spaceId, collab, task)
  const pending = useMemo(() => (detail.pendingEscalations ?? []).filter(item => item.epochId === task.epochId && item.entry), [detail.pendingEscalations, task.epochId])
  const progress = useTaskProgress({ detail, task, boardState, decisions: pending.map(item => item.entry!) })
  const memberIds = useMemo(() => detail.roster.map(member => member.appId), [detail.roster])
  if (!detail.roster.length) return null

  const openRoom = (decisionId?: string) => {
    const decision = decisionId ? pending.find(item => item.entryId === decisionId) : undefined
    if (decision) usePeopleViewStore.setState({ teamTarget: { teamId: collab.teamId, epochId: task.epochId, appId: decision.appId, entryId: decision.entryId, decision: true } })
    void openTeam(collab.teamId, collab.name)
  }
  const working = new Set(detail.roster.filter(member => member.busy?.some(row => row.epochId === task.epochId)).map(member => member.appId))
  return <div className="min-w-0 pt-1">
    <TaskMemberSelector temporary roster={detail.roster} selectedAppId={null} ownedAppIds={memberIds}
      waitingAppIds={new Set(pending.map(item => item.appId))} workingAppIds={working}
      progress={progress && { progress, leadAppId: detail.team.leadAppId ?? null, outputCount: task.artifactCount ?? 0, onAnswer: openRoom }}
      onActivity={activityId => openProgress(activityId ? { activityId } : undefined)}
      onSelect={member => onOpenMember(member.appId)} />
  </div>
}

function CollabMemberRoom({ spaceId, collab, teamDetail, task, appId, onSelect, onReturn }: CollabWork & { appId: string; onSelect: (appId: string) => void; onReturn: () => void }) {
  const { detail, boardState } = useCollabDetail(teamDetail, task)
  const openProgress = useOpenProgress(spaceId, collab, task)
  const gone = !!boardState.board && !detail.roster.some(member => member.appId === appId)
  useEffect(() => { if (gone) onReturn() }, [gone, onReturn])
  if (!boardState.board && !boardState.failed) return null
  return <TaskRoom homepageConversation returnToMain={onReturn} detail={detail} task={task} selectedAppId={appId} boardState={boardState} tasks={[]}
    onSelectMember={member => onSelect(member.appId)} onCreated={() => {}} onTask={() => {}}
    onActivity={activityId => openProgress(activityId ? { activityId } : undefined)} onExecution={memberAppId => openProgress({ memberAppId })} />
}
