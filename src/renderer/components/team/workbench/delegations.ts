import type { BlackboardTask, TeamActivity, TeamDetail } from '../../../../shared/apps/team-types'
import { delegatedTasks } from '../../../../shared/apps/team-delegations'

/** A conversation's subtasks: its board's, else what its coordinators handed out by message. */
export function conversationSubtasks(detail: TeamDetail, epochId: string | null, boardTasks: BlackboardTask[] | undefined, activities: readonly TeamActivity[]): BlackboardTask[] {
  const tasks = boardTasks ?? detail.tasks.filter(row => row.epochId === epochId)
  if (tasks.length || !epochId) return tasks
  const busyAppIds = new Set(detail.roster.filter(member => member.busy?.some(item => item.epochId === epochId)).map(member => member.appId))
  return delegatedTasks({ teamId: detail.team.id, epochId, leadAppId: detail.team.leadAppId ?? null, activities, busyAppIds })
}
