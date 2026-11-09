import type { TeamStore } from './types'
import type { TeamMember, TeamParticipant } from '../../../shared/apps/team-types'

export type WorkMember = TeamMember | TeamParticipant

export function getWorkMember(store: TeamStore, teamId: string, epochId: string, appId: string): WorkMember | null {
  if (store.getEpochById(epochId)?.teamId !== teamId) return null
  return store.getMember(teamId, appId) ?? store.participants?.get(teamId, epochId, appId) ?? null
}

export function findWorkMember(store: TeamStore, teamId: string, epochId: string, name: string): WorkMember | null {
  if (store.getEpochById(epochId)?.teamId !== teamId) return null
  const standing = store.getMemberByName(teamId, name)
  const temporary = store.participants?.findByName(teamId, epochId, name)
  if (standing && temporary) return null
  return standing ?? temporary ?? null
}

export function listWorkMembers(store: TeamStore, teamId: string, epochId: string): WorkMember[] {
  if (store.getEpochById(epochId)?.teamId !== teamId) return []
  return [...store.listMembersByTeam(teamId), ...(store.participants?.list(teamId, epochId) ?? [])]
}

export function workMemberPrincipalId(store: TeamStore, teamId: string, epochId: string, appId: string): string | null {
  const seen = new Set<string>()
  let member = getWorkMember(store, teamId, epochId, appId)
  while (member && 'isTemporary' in member) {
    if (seen.has(member.appId)) {
      console.warn(`[TeamParticipants] Cyclic delegation rejected: team=${teamId} epoch=${epochId} app=${appId}`)
      return null
    }
    seen.add(member.appId)
    member = getWorkMember(store, teamId, epochId, member.parentAppId)
  }
  return member?.appId ?? null
}

/** Delegation may extend a working group, never its standing contact permissions. */
export function isWorkEdgeAllowed(store: TeamStore, teamId: string, epochId: string, from: string, to: string): boolean {
  const source = workMemberPrincipalId(store, teamId, epochId, from)
  const target = workMemberPrincipalId(store, teamId, epochId, to)
  return !!source && !!target && (source === target || store.isEdgeAllowed(teamId, source, target))
}
