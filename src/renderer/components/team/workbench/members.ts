import { isRemoteMember, parseSpaceCoordinatorAppId } from '../../../../shared/apps/team-types'
import type { TeamConversation, TeamDetail } from '../../../../shared/apps/team-types'

/** Internal conversation addresses are provenance, never selectable people. */
export function detailForTask(detail: TeamDetail, task: TeamConversation | null): TeamDetail {
  const source = detail.team.ephemeral === true || task?.kind === 'collab'
  const members = detail.members.filter(member =>
    !parseSpaceCoordinatorAppId(member.appId) && (!source || !member.isSystemCoordinator))
  const ids = new Set(members.map(member => member.appId))
  return { ...detail, members, roster: detail.roster.filter(member => ids.has(member.appId)) }
}

export function ownedTaskMembers(detail: TeamDetail, apps: readonly { id: string }[]) {
  const installed = new Set(apps.map(app => app.id))
  const located = new Set(detail.roster.filter(member => member.spaceId).map(member => member.appId))
  return detail.members.filter(member =>
    !parseSpaceCoordinatorAppId(member.appId) && !isRemoteMember(member) && (installed.has(member.appId) || located.has(member.appId)))
    .sort((left, right) => Number(right.isLead) - Number(left.isLead))
}
