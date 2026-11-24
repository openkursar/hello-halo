import { isRemoteMember, memberDisplayName, parseSpaceCoordinatorAppId } from '../../../../shared/apps/team-types'
import type { BlackboardTask, EpochBoard, TeamActivity, TeamConversation, TeamDetail } from '../../../../shared/apps/team-types'

const named = <T extends { appId: string; memberName: string; role: string }>(member: T): T => {
  const memberName = memberDisplayName(member)
  return memberName === member.memberName ? member : { ...member, memberName }
}

/** Internal conversation addresses are provenance, never selectable people; collaborators show their given names. */
export function detailForTask(detail: TeamDetail, task: TeamConversation | null, board?: EpochBoard | null): TeamDetail {
  const scoped = task && board && board.epoch.id === task.epochId && board.epoch.teamId === detail.team.id ? board : null
  const source = detail.team.ephemeral === true || task?.kind === 'collab'
  const members = (scoped?.members ?? detail.members).filter(member =>
    !parseSpaceCoordinatorAppId(member.appId) && (!source || !member.isSystemCoordinator)).map(named)
  const ids = new Set(members.map(member => member.appId))
  return { ...detail, members, roster: (scoped?.roster ?? detail.roster).filter(member => ids.has(member.appId)).map(named) }
}

export function ownedTaskMembers(detail: TeamDetail, apps: readonly { id: string }[]) {
  const installed = new Set(apps.map(app => app.id))
  const located = new Set(detail.roster.filter(member => member.spaceId).map(member => member.appId))
  return detail.members.filter(member =>
    !parseSpaceCoordinatorAppId(member.appId) && !isRemoteMember(member) && (installed.has(member.appId) || located.has(member.appId)))
    .sort((left, right) => Number(right.isLead) - Number(left.isLead))
}

/**
 * The first of my own members that took part in a task someone else started,
 * so opening it lands on the digital human the user actually has history with
 * rather than the team lead.
 */
export function involvedOwnMember(
  own: readonly { appId: string }[],
  activities: readonly Pick<TeamActivity, 'actorAppId' | 'targetAppId'>[],
  tasks: readonly Pick<BlackboardTask, 'createdByAppId' | 'assigneeAppId'>[],
): string | undefined {
  const taken = new Set<string>()
  for (const row of activities) { taken.add(row.actorAppId); if (row.targetAppId) taken.add(row.targetAppId) }
  for (const row of tasks) { taken.add(row.createdByAppId); if (row.assigneeAppId) taken.add(row.assigneeAppId) }
  return own.find(member => taken.has(member.appId))?.appId
}
