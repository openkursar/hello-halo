import { getTeamStore, type TeamStore } from '../team'
import { isRemoteMember } from '../../../shared/apps/team-types'
import type { StandingTeam } from './prompt/team-guidance'

/**
 * The standing teams a digital human serves from this computer, as its own
 * prompt names them. An agent team is one piece of work, not a team it belongs
 * to, and a member run by another computer is that computer's to name.
 */
export function collectStandingTeams(
  appId: string,
  teams: Pick<TeamStore, 'listMembersByAppId' | 'getTeamById'>,
): StandingTeam[] {
  return teams.listMembersByAppId(appId).flatMap(member => {
    if (isRemoteMember(member)) return []
    const team = teams.getTeamById(member.teamId)
    if (!team || team.ephemeral) return []
    return [{ teamId: team.id, name: team.name, role: member.role, isLead: member.isLead, hostedElsewhere: !!team.hostNodeId }]
  })
}

export function listStandingTeams(appId: string): StandingTeam[] {
  const teams = getTeamStore()
  return teams ? collectStandingTeams(appId, teams) : []
}
