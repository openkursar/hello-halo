import { useMemo } from 'react'
import type { TeamConversation, TeamDetail } from '../../../../shared/apps/team-types'
import { getEscalationQuestions, type ActivityEntry } from '../../../../shared/apps/app-types'
import { conversationSubtasks } from './delegations'
import { taskParticipants } from './model'
import { taskProgress, type TaskProgress } from './progress'
import type { TaskBoardState } from './useTaskBoard'

/**
 * The conversation's progress, or null while there is nothing to tell: no task yet,
 * or only the lead involved with an empty board.
 * `decisions` are the unanswered ones this user can answer.
 */
export function useTaskProgress({ detail, task, boardState, decisions }: {
  detail: TeamDetail; task: TeamConversation | null; boardState: TaskBoardState; decisions: readonly ActivityEntry[]
}): TaskProgress | null {
  const leadAppId = detail.team.leadAppId ?? null
  const epochId = task?.epochId ?? null
  const tasks = useMemo(() => conversationSubtasks(detail, epochId, boardState.board?.tasks, boardState.activities), [boardState.board?.tasks, boardState.activities, detail, epochId])
  const findings = useMemo(() => boardState.board?.findings ?? detail.findings.filter(row => row.epochId === epochId), [boardState.board?.findings, detail.findings, epochId])
  const decisionKey = decisions.map(entry => entry.id).join(',')
  return useMemo(() => {
    if (!task) return null
    const waitingAppIds = task.waitingMemberAppIds ?? []
    const answerable = decisions.map(entry => ({ id: entry.id, appId: entry.appId, question: (getEscalationQuestions(entry.content)[0]?.question ?? '').replace(/\s+/g, ' ').trim() }))
    const participants = taskParticipants({
      epochId: task.epochId, activities: boardState.activities, tasks, findings, roster: detail.roster, reports: [],
      memberAppIds: [...answerable.map(row => row.appId), ...waitingAppIds],
    })
    const progress = taskProgress({ epochId: task.epochId, roster: detail.roster, leadAppId, activities: boardState.activities, tasks, decisions: answerable, waitingAppIds, participants, completed: !!task.completed || task.finishedAt !== undefined })
    return progress.members.some(row => row.appId !== leadAppId) || progress.total ? progress : null
    // eslint-disable-next-line react-hooks/exhaustive-deps -- decisions is rebuilt each render; its ids carry the change
  }, [task?.epochId, task?.waitingMemberAppIds, task?.completed, task?.finishedAt, decisionKey, boardState.activities, tasks, findings, detail.roster, leadAppId])
}
