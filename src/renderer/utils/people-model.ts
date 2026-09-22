import type { ActivityEntry, InstalledApp } from '../../shared/apps/app-types'
import type { TeamListItem } from '../../shared/apps/team-types'

/**
 * Apps hidden from person-facing surfaces: dedicated coordinators (an internal
 * role) and every member of an ephemeral space collaboration (they exist for
 * one piece of work, not as standalone digital humans).
 */
export function hiddenTeamMemberIds(teams: TeamListItem[]): Set<string> {
  return new Set(
    teams.flatMap(team =>
      team.localMembers
        .filter(member => member.isSystemCoordinator || team.ephemeral)
        .map(member => member.appId)
    )
  )
}

export function visibleDigitalHumans(apps: InstalledApp[], teams: TeamListItem[]): InstalledApp[] {
  const hidden = hiddenTeamMemberIds(teams)
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
