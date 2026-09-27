import type { PersonContextCaller, PersonContextQuery, PersonContextResult } from '../../../shared/apps/person-context'
import { getAppManager, getPersonConnectionAccess, type AppManagerService } from '../manager'
import { getTeamStore, type TeamStore } from '../team'
import { isRemoteMember } from '../../../shared/apps/team-types'
import { listAvailableSkills } from '../skill-discovery'

interface ContextDependencies {
  manager: Pick<AppManagerService, 'getApp' | 'listEffectiveMcpApps'>
  teams: Pick<TeamStore, 'listMembersByAppId' | 'getTeamById' | 'getEpochById'>
  skills: typeof listAvailableSkills
  now?: () => number
}

/** Caller authority is supplied by the entry point, never accepted from the model. */
export function queryPersonContext(
  caller: PersonContextCaller,
  query: PersonContextQuery,
  deps: ContextDependencies,
): PersonContextResult {
  if (caller.authority === 'guest') throw new Error('This caller cannot read private digital human relationships')
  const appId = caller.appId ?? query.appId
  if (!appId || (caller.appId && query.appId && query.appId !== caller.appId)) throw new Error('This query cannot address another digital human')
  const app = deps.manager.getApp(appId)
  if (!app || app.status === 'uninstalled' || app.spec.type !== 'automation') throw new Error('Digital human is unavailable')
  const memberships = deps.teams.listMembersByAppId(appId).filter(member =>
    !isRemoteMember(member) && (caller.authority === 'owner' || member.teamId === caller.teamId))
  if (caller.authority === 'team' && memberships.length === 0) throw new Error('Team membership is no longer available')
  const result: PersonContextResult = {
    identity: { appId, name: app.spec.name, description: app.spec.description },
    scope: caller.authority, retrievedAt: (deps.now ?? Date.now)(), references: [],
  }
  if (query.section === 'teams') {
    const offset = Math.max(0, Math.floor(query.offset ?? 0))
    const visible = memberships.flatMap(member => {
      const team = deps.teams.getTeamById(member.teamId)
      if (!team) return []
      return [{
        teamId: team.id, name: team.name, role: member.role, duty: member.duty ?? null,
        isLead: member.isLead, availability: team.hostNodeId ? 'last_synced' as const : 'local' as const,
        updatedAt: team.updatedAt,
        reference: { kind: 'team' as const, teamId: team.id, appId, label: team.name },
      }]
    }).sort((a, b) => a.name.localeCompare(b.name) || a.teamId.localeCompare(b.teamId))
    result.teams = visible.slice(offset, offset + 20)
    if (visible.length > offset + 20) result.nextOffset = offset + 20
    result.references = result.teams.map(team => team.reference)
  } else if (query.section === 'work') {
    const teamId = query.teamId ?? caller.teamId
    const epochId = query.epochId ?? caller.epochId
    if (!teamId || !epochId || !memberships.some(member => member.teamId === teamId)) throw new Error('Work is outside the permitted team scope')
    if (caller.authority === 'team' && epochId !== caller.epochId) throw new Error('Only the current task is available to this caller')
    const epoch = deps.teams.getEpochById(epochId)
    if (!epoch || epoch.teamId !== teamId) throw new Error('Team task is unavailable')
    result.work = { teamId, epochId, title: epoch.workItem?.title ?? epoch.title ?? null, status: epoch.workItem?.status ?? 'unknown', updatedAt: epoch.lastActivityAt ?? epoch.startedAt }
    if (epoch.summary) result.work.summary = epoch.summary.slice(0, 1600)
    result.references = [{ kind: 'team', teamId, epochId, appId, label: epoch.workItem?.title ?? 'Team task' }]
  } else {
    if (caller.authority !== 'owner') throw new Error('Only the owner can inspect capabilities outside this team turn')
    const spaceId = caller.environmentSpaceId ?? app.spaceId
    result.capabilities = {
      mode: caller.capabilityMode ?? 'overview',
      effectiveOn: 'next_turn',
      skills: spaceId ? deps.skills(spaceId).map(skill => ({ name: skill.name, scope: skill.scope })) : [],
      connections: getPersonConnectionAccess(deps.manager, app, spaceId),
    }
  }
  return result
}

export function readPersonContext(caller: PersonContextCaller, query: PersonContextQuery): PersonContextResult {
  const manager = getAppManager()
  const teams = getTeamStore()
  if (!manager || !teams) throw new Error('Digital human relationships are not ready. Try again shortly.')
  return queryPersonContext(caller, query, { manager, teams, skills: listAvailableSkills })
}
