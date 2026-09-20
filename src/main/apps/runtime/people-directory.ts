import type { AppManagerService } from '../manager'
import type { ActivityStore } from './store'
import type { AppRuntimeService } from './types'
import type { DirectoryMembership, PeopleDirectoryPage, PeopleDirectoryQuery } from '../../../shared/apps/people-directory'

export function buildPeopleDirectory(
  manager: AppManagerService,
  store: ActivityStore,
  runtime: AppRuntimeService,
  memberships: DirectoryMembership[],
  query: PeopleDirectoryQuery,
): PeopleDirectoryPage {
  const excluded = new Set(memberships.filter(member => member.isSystemCoordinator).map(member => member.appId))
  const counts = store.getDirectoryDecisionCounts()
  let includeIds: string[] | undefined
  if (query.teamId) includeIds = memberships.filter(member => member.teamId === query.teamId).map(member => member.appId)
  if (query.attention) {
    const pending = Object.keys(counts).filter(id => counts[id].pending > 0)
    includeIds = includeIds ? includeIds.filter(id => pending.includes(id)) : pending
  }
  const search = query.q?.trim().toLocaleLowerCase()
  const page = manager.listPeopleDirectory({ ...query, includeIds, excludeIds: [...excluded],
    searchTeamMemberIds: search ? memberships.filter(member => member.teamName.toLocaleLowerCase().includes(search)).map(member => member.appId) : [],
  })
  const removedTotal = manager.listPeopleDirectory({ removed: true, excludeIds: [...excluded], limit: 1 }).total
  const live = runtime.getDirectoryRuntimeSnapshot()
  const recent = store.getDirectoryRecentRuns(page.items.map(person => person.id))
  const teamsByPerson = new Map<string, Array<{ id: string; name: string }>>()
  for (const membership of memberships) {
    const teams = teamsByPerson.get(membership.appId) ?? []
    teams.push({ id: membership.teamId, name: membership.teamName })
    teamsByPerson.set(membership.appId, teams)
  }
  return {
    ...page, removedTotal,
    pendingTotal: Object.entries(counts).reduce((sum, [id, count]) => sum + (excluded.has(id) ? 0 : count.pending), 0),
    items: page.items.map(person => {
      const count = counts[person.id] ?? { pending: 0, solo: 0, continuations: 0 }
      const current = live[person.id]
      const automaticEnabled = person.status === 'active' || person.status === 'waiting_user'
      const runs = recent.filter(run => run.appId === person.id)
      const latest = runs[0]
      let consecutiveErrors = 0
      for (const run of runs) { if (run.status !== 'error' || run.stopped || run.closed) break; consecutiveErrors++ }
      return { ...person, teams: teamsByPerson.get(person.id) ?? [], state: {
        status: current?.runningCount ? 'running' : current?.queued || count.continuations ? 'queued'
          : count.pending ? 'waiting_user' : automaticEnabled ? 'idle' : person.status === 'paused' ? 'paused' : 'error',
        automaticEnabled, runningCount: current?.runningCount ?? 0,
        pendingDecisionCount: count.pending, pendingSoloDecisionCount: count.solo, continuationCount: count.continuations,
        nextRunAtMs: current?.nextRunAtMs, consecutiveErrors,
        lastRunAtMs: latest?.startedAt, lastDurationMs: latest?.durationMs ?? undefined,
        lastStatus: latest && ['ok', 'error', 'skipped'].includes(latest.status) ? latest.status as 'ok' | 'error' | 'skipped' : undefined,
        ...(latest?.status === 'running' ? { runningAtMs: latest.startedAt, runningRunId: latest.runId, runningSessionKey: latest.sessionKey } : {}),
      } }
    }),
  }
}
