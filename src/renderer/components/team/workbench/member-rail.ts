import type { RosterMember } from '../../../../shared/apps/team-types'

const ITEM = 36
const SELECTED = 180
const CHROME = 72
const MIN = 1
const MAX = 8
const RECENT = 6
const BAR = 52

/** How many avatars fit beside the expanded selected member and the members toggle. */
export function railCapacity(width: number) {
  return Math.max(MIN, Math.min(MAX, Math.floor((width - SELECTED - CHROME) / ITEM) + 1))
}

/**
 * The rail's share of a row it splits with the status, which always reads in full:
 * the progress bar gives way first, then avatars fold into the members toggle.
 */
export function railFit(width: number, statusWidth: number, members: number) {
  const shown = (capacity: number) => members <= capacity + 1 ? members : capacity
  const withBar = railCapacity(width - statusWidth - BAR)
  const without = railCapacity(width - statusWidth)
  const fits = width - statusWidth - BAR >= SELECTED + CHROME && shown(withBar) === shown(without)
  return fits ? { capacity: withBar, bar: true } : { capacity: without, bar: false }
}

export function orderTaskMembers(roster: readonly RosterMember[], ownedAppIds: readonly string[]) {
  const owned = new Set(ownedAppIds)
  const rank = (member: RosterMember) => member.isLead ? 0 : owned.has(member.appId) ? 1 : 2
  return [...roster].sort((left, right) => rank(left) - rank(right))
}

/**
 * Which members the rail shows. The current member and the ones that need the user
 * are always visible; the shown set keeps team order so avatars never trade places.
 */
export function railMembers(ordered: readonly RosterMember[], { selectedAppId, ownedAppIds, waiting, working, recent, capacity }: {
  selectedAppId: string | null
  ownedAppIds: readonly string[]
  waiting: ReadonlySet<string>
  working: ReadonlySet<string>
  recent: readonly string[]
  capacity: number
}) {
  if (ordered.length <= capacity + 1) return { shown: [...ordered], hidden: [] as RosterMember[] }
  const owned = new Set(ownedAppIds)
  const ids = ordered.map(member => member.appId)
  const priority = [
    ...(selectedAppId ? [selectedAppId] : []),
    ...ids.filter(id => owned.has(id) && waiting.has(id)),
    ...recent.slice(0, RECENT),
    ...ids.filter(id => owned.has(id) && working.has(id)),
    ...ids.filter(id => owned.has(id)),
    ...ids,
  ]
  const picked = new Set<string>()
  for (const id of priority) {
    if (picked.size >= capacity) break
    if (ids.includes(id)) picked.add(id)
  }
  return {
    shown: ordered.filter(member => picked.has(member.appId)),
    hidden: ordered.filter(member => !picked.has(member.appId)),
  }
}

export function rememberRecent(recent: readonly string[], appId: string) {
  return [appId, ...recent.filter(id => id !== appId)].slice(0, RECENT)
}
