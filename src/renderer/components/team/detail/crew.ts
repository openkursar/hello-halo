import type { RosterMember, TeamActivity, TeamConversation, TeamDetail } from '../../../../shared/apps/team-types'
import { taskTime } from '../workbench/time'
import { taskDecisions } from './status'

/**
 * How a member on a task stands: at work, waiting on its owner, stopped by a failure,
 * on an offline computer, having done its part, or between turns on unfinished work.
 */
export type CrewState = 'working' | 'waiting' | 'failed' | 'offline' | 'done' | 'idle'

export interface CrewEntry {
  appId: string
  state: CrewState
}

/** Two members who wrote to each other lately in one task. */
export interface CrewLink {
  a: string
  b: string
  at: number
}

/** Members count as talking while their latest message to each other is this recent. */
export const TALK_WINDOW = 2 * 60_000

const FAILURES = new Set(['error', 'timeout', 'undelivered'])

/** Who is on a listed task right now, read from what the list already holds; finished work has no one on it. */
export function taskCrew(detail: TeamDetail, task: TeamConversation): CrewEntry[] {
  if (task.completed || task.finishedAt !== undefined) return []
  const waiting = new Set([...(task.waitingMemberAppIds ?? []), ...taskDecisions(detail, task.epochId).map(item => item.appId)])
  const failedAppId = task.failure?.appId
  const crew: CrewEntry[] = []
  for (const member of detail.roster) {
    const busy = !!member.busy?.some(row => row.epochId === task.epochId)
    const failed = busy ? member.status === 'error' : member.appId === failedAppId
    if (!busy && !failed && !waiting.has(member.appId)) continue
    crew.push({ appId: member.appId, state: crewState(member, waiting.has(member.appId), failed) })
  }
  return crew
}

/** The teammate a conversation was opened with directly instead of through the lead; null otherwise. */
export function addressedMember(detail: TeamDetail, task: TeamConversation): string | null {
  if (task.kind === 'run' || task.kind === 'im' || !task.memberAppId || task.memberAppId === detail.team.leadAppId) return null
  return task.memberAppId
}

/** Members who took part in a listed task but are not on it now, in roster order. */
export function pastCrew(detail: TeamDetail, task: TeamConversation, crew: readonly CrewEntry[]): string[] {
  const on = new Set(crew.map(entry => entry.appId))
  const roster = new Set(detail.roster.map(member => member.appId))
  return (task.participantAppIds ?? []).filter(appId => roster.has(appId) && !on.has(appId))
}

export function crewState(member: RosterMember | undefined, waiting: boolean, failed: boolean): CrewState {
  if (member?.presence === 'offline') return 'offline'
  if (waiting) return 'waiting'
  if (failed) return 'failed'
  return 'working'
}

/** A message or reply from one party to another. */
export function isExchange(activity: TeamActivity): boolean {
  return (activity.kind === 'message' || activity.kind === 'reply') && !!activity.targetAppId && activity.targetAppId !== activity.actorAppId
}

/** Delivered messages and replies between two parties within the talk window. */
export function recentTalk(activities: readonly TeamActivity[], now: number): TeamActivity[] {
  return activities.filter(activity => {
    if (!isExchange(activity)) return false
    if (FAILURES.has(activity.status ?? '')) return false
    const at = taskTime(activity.createdAt)
    return at !== null && now - at <= TALK_WINDOW
  })
}

/** When the oldest of these exchanges leaves the talk window, so the view can let go of it. */
export function talkExpiry(recent: readonly TeamActivity[]): number | null {
  let oldest: number | null = null
  for (const activity of recent) {
    const at = taskTime(activity.createdAt)
    if (at !== null && (oldest === null || at < oldest)) oldest = at
  }
  return oldest === null ? null : oldest + TALK_WINDOW
}

/** Pairs in one task who wrote to each other lately while both are still on it, newest first. */
export function talkLinks(recent: readonly TeamActivity[], epochId: string, on: ReadonlySet<string>): CrewLink[] {
  const links = new Map<string, CrewLink>()
  for (const activity of recent) {
    const a = activity.actorAppId
    const b = activity.targetAppId!
    if (activity.epochId !== epochId || !on.has(a) || !on.has(b)) continue
    const at = taskTime(activity.createdAt)!
    const key = a < b ? `${a}\n${b}` : `${b}\n${a}`
    const current = links.get(key)
    if (!current || current.at < at) links.set(key, { a, b, at })
  }
  return [...links.values()].sort((left, right) => right.at - left.at)
}

export function partnersOf(appId: string, links: readonly CrewLink[]): string[] {
  return links.flatMap(link => link.a === appId ? [link.b] : link.b === appId ? [link.a] : [])
}

export function needsAttention(state: CrewState): boolean {
  return state === 'waiting' || state === 'failed'
}

/** Members needing the user and whoever they talk to first, then talking pairs, then everyone else on it; a cap never hides attention. */
export function orderCrew(crew: readonly CrewEntry[], links: readonly CrewLink[]): CrewEntry[] {
  const byId = new Map(crew.map(entry => [entry.appId, entry]))
  const out: CrewEntry[] = []
  const add = (appId: string) => {
    const entry = byId.get(appId)
    if (entry && !out.includes(entry)) out.push(entry)
  }
  for (const entry of crew) {
    if (!needsAttention(entry.state)) continue
    add(entry.appId)
    partnersOf(entry.appId, links).forEach(add)
  }
  for (const link of links) {
    add(link.a)
    add(link.b)
  }
  crew.forEach(entry => add(entry.appId))
  return out
}

export function linked(links: readonly CrewLink[], a: string, b: string): boolean {
  return links.some(link => (link.a === a && link.b === b) || (link.a === b && link.b === a))
}

/** Neighbours in a row who talk to each other share a group, so a chain like A–Lead–B stays together. */
export function rowGroups(shown: readonly CrewEntry[], links: readonly CrewLink[]): CrewEntry[][] {
  const groups: CrewEntry[][] = []
  shown.forEach((entry, index) => {
    if (index && linked(links, shown[index - 1].appId, entry.appId)) groups[groups.length - 1].push(entry)
    else groups.push([entry])
  })
  return groups
}

/** Members who talk form one cluster, walked as a chain so each sits beside someone it talked to. */
export function talkClusters(appIds: readonly string[], links: readonly CrewLink[]): string[][] {
  const adjacent = new Map(appIds.map(appId => [appId, [] as string[]]))
  for (const { a, b } of links) {
    if (!adjacent.has(a) || !adjacent.has(b)) continue
    adjacent.get(a)!.push(b)
    adjacent.get(b)!.push(a)
  }
  const seen = new Set<string>()
  const clusters: string[][] = []
  for (const appId of appIds) {
    if (seen.has(appId)) continue
    const component = new Set<string>()
    const todo = [appId]
    while (todo.length) {
      const current = todo.pop()!
      if (component.has(current)) continue
      component.add(current)
      todo.push(...adjacent.get(current)!)
    }
    const start = appIds.find(id => component.has(id) && adjacent.get(id)!.length <= 1) ?? appId
    const chain = [start]
    seen.add(start)
    for (let current = start; ;) {
      const next = adjacent.get(current)!.find(id => !seen.has(id))
      if (!next) break
      chain.push(next)
      seen.add(next)
      current = next
    }
    for (const id of appIds) if (component.has(id) && !seen.has(id)) { chain.push(id); seen.add(id) }
    clusters.push(chain)
  }
  return clusters
}

/**
 * At most the lead and `cap` others; the rest fold into a count. Someone whose
 * only partners are folded folds too, so a talking pair is never shown in half.
 */
export function capStage(ordered: readonly CrewEntry[], links: readonly CrewLink[], leadAppId: string | null, cap: number): { shown: CrewEntry[]; hidden: number } {
  const others = ordered.filter(entry => entry.appId !== leadAppId)
  if (others.length <= cap + 1) return { shown: [...ordered], hidden: 0 }
  const kept = new Set([...ordered.filter(entry => entry.appId === leadAppId), ...others.slice(0, cap)].map(entry => entry.appId))
  const shown = ordered.filter(entry => {
    if (!kept.has(entry.appId)) return false
    const partners = partnersOf(entry.appId, links)
    return !partners.length || partners.some(id => kept.has(id))
  })
  return { shown, hidden: ordered.length - shown.length }
}

/** Each member blinks on its own beat, keyed by member so a group forming never resets it. */
export function blinkDelay(appId: string): string {
  let hash = 7
  for (const char of appId) hash = (hash * 31 + char.codePointAt(0)!) >>> 0
  return `-${(hash % 28) / 10}s`
}
