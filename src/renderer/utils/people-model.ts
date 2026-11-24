import type { ActivityEntry, AppStatus, InstalledApp } from '../../shared/apps/app-types'
import { leadAppIdSet, type TeamListItem } from '../../shared/apps/team-types'

type TeamMembership = Pick<TeamListItem, 'ephemeral' | 'localMembers'>
type ListedApp = Pick<InstalledApp, 'id'> & { spec: { type: string } }

/**
 * Members that exist only for an ephemeral space collaboration. They are built
 * for one piece of work, so no person-facing surface lists them. A member kept
 * by saving the collaboration as a team belongs to that team too and stays
 * listed, as in the people directory.
 */
export function ephemeralMemberIds(teams: readonly TeamMembership[]): Set<string> {
  const memberIds = (ephemeral: boolean) =>
    teams.filter(team => (team.ephemeral === true) === ephemeral).flatMap(team => team.localMembers.map(member => member.appId))
  const kept = new Set(memberIds(false))
  return new Set(memberIds(true).filter(id => !kept.has(id)))
}

/**
 * Dedicated team coordinators. They are the person's own digital humans and the
 * only place their model and capabilities can be set, so the directory lists
 * them; but their work arrives through the team, so they are not offered as a
 * direct recipient alongside the digital humans a person addresses themselves.
 */
export function coordinatorIds(teams: TeamListItem[]): Set<string> {
  return new Set(
    teams.flatMap(team => team.localMembers.filter(member => member.isSystemCoordinator).map(member => member.appId))
  )
}

export function visibleDigitalHumans<T extends ListedApp>(apps: readonly T[], teams: readonly TeamMembership[]): T[] {
  const hidden = ephemeralMemberIds(teams)
  return apps.filter(app => app.spec.type === 'automation' && !hidden.has(app.id))
}

/** Digital humans a person can choose for new work: listed and not uninstalled. */
export function pickableDigitalHumans<T extends ListedApp & { status: AppStatus }>(
  apps: readonly T[],
  teams: readonly TeamMembership[],
): T[] {
  return visibleDigitalHumans(apps, teams).filter(app => app.status !== 'uninstalled')
}

/** Leads coordinate their own team, so they never join another as a member. */
export function teamMemberCandidates(apps: readonly InstalledApp[], teams: readonly TeamListItem[]): InstalledApp[] {
  const leads = leadAppIdSet(teams)
  return pickableDigitalHumans(apps, teams).filter(app => !leads.has(app.id))
}

export function activitySourceKind(entry: ActivityEntry): 'team' | 'automation' | 'chat' | 'upgrade' | 'unknown' {
  return entry.content.teamContext ? 'team' : entry.content.source?.kind ?? 'unknown'
}

export function isPendingDecision(entry: ActivityEntry): boolean {
  return entry.type === 'escalation' && !entry.userResponse && !entry.content.resolution
}

export function mergeActivityEntries(current: ActivityEntry[], incoming: ActivityEntry[]): ActivityEntry[] {
  const entries = new Map(current.map(entry => [entry.id, entry]))
  for (const entry of incoming) entries.set(entry.id, entry)
  return [...entries.values()].sort((left, right) => right.ts - left.ts || (left.id < right.id ? 1 : left.id > right.id ? -1 : 0))
}
