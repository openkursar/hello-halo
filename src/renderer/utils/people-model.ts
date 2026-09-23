import type { ActivityEntry, InstalledApp } from '../../shared/apps/app-types'
import type { TeamListItem } from '../../shared/apps/team-types'

/**
 * Members of an ephemeral space collaboration. They exist for one piece of work
 * and are gone with it, so no person-facing surface lists them.
 */
export function ephemeralMemberIds(teams: TeamListItem[]): Set<string> {
  return new Set(
    teams.filter(team => team.ephemeral).flatMap(team => team.localMembers.map(member => member.appId))
  )
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

export function visibleDigitalHumans(apps: InstalledApp[], teams: TeamListItem[]): InstalledApp[] {
  const hidden = ephemeralMemberIds(teams)
  return apps.filter(app => app.spec.type === 'automation' && !hidden.has(app.id))
}

export function activitySourceKind(entry: ActivityEntry): 'team' | 'automation' | 'chat' | 'unknown' {
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
