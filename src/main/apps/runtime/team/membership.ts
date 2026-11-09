import type { MessageBusStore } from '@hello-halo/agent-sdk/collaboration'
import { isRemoteMember } from '../../../../shared/apps/team-types'
import { findWorkMember, getWorkMember, isWorkEdgeAllowed, listWorkMembers, type TeamStore } from '../../team'

export function createWorkReachability(store: TeamStore, standing?: (appId: string, teamId: string) => boolean) {
  return (appId: string, teamId: string): boolean => {
    const participant = store.participants.getById(appId)
    if (participant) return participant.teamId === teamId && !isRemoteMember(participant)
      && !!store.participants.getExecution(teamId, participant.epochId, appId)
    return standing?.(appId, teamId) ?? !!store.getMember(teamId, appId)
  }
}

/** The bus always supplies its work scope; unscoped reads see only standing members. */
export function createWorkMembership(store: TeamStore): MessageBusStore {
  return {
    getMember: (teamId, appId, epochId) => epochId ? getWorkMember(store, teamId, epochId, appId) : store.getMember(teamId, appId),
    getMemberByName: (teamId, name, epochId) => epochId ? findWorkMember(store, teamId, epochId, name) : store.getMemberByName(teamId, name),
    listMembersByTeam: (teamId, epochId) => epochId ? listWorkMembers(store, teamId, epochId) : store.listMembersByTeam(teamId),
    isEdgeAllowed: (teamId, from, to, epochId) => epochId ? isWorkEdgeAllowed(store, teamId, epochId, from, to) : store.isEdgeAllowed(teamId, from, to),
    getTeamById: teamId => store.getTeamById(teamId),
    getEpochById: epochId => store.getEpochById(epochId),
  }
}
