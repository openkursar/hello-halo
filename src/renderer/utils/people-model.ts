import type { ActivityEntry, InstalledApp } from '../../shared/apps/app-types'
import type { TeamListItem } from '../../shared/apps/team-types'

export function visibleDigitalHumans(apps: InstalledApp[], teams: TeamListItem[]): InstalledApp[] {
  const coordinators = new Set(teams.flatMap(team => team.localMembers.filter(member => member.isSystemCoordinator).map(member => member.appId)))
  return apps.filter(app => app.spec.type === 'automation' && !coordinators.has(app.id))
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
