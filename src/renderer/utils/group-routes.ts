/** Pure bookkeeping over the router's reports about which model of a group serves a conversation. */

import type { GroupRouteInfo } from '../../shared/types/ai-groups-runtime'

/** Reports kept at once; the oldest go first. */
export const MAX_GROUP_ROUTES = 256

type Routes = Readonly<Record<string, GroupRouteInfo>>

function sameReport(a: GroupRouteInfo, b: GroupRouteInfo): boolean {
  return a.at === b.at && a.state === b.state && a.groupId === b.groupId && a.member?.key === b.member?.key
}

/**
 * `current` with `incoming` folded in: for each conversation the newer report
 * stands, and a report already held changes nothing. Returns `current` itself
 * when nothing changed, so a store can tell without comparing.
 */
export function mergeGroupRoutes(current: Routes, incoming: readonly GroupRouteInfo[]): Routes {
  let next: Record<string, GroupRouteInfo> | null = null
  for (const report of incoming) {
    const held = (next ?? current)[report.sessionKey]
    if (held && (held.at > report.at || sameReport(held, report))) continue
    next ??= { ...current }
    next[report.sessionKey] = report
  }
  if (!next) return current

  const keys = Object.keys(next)
  if (keys.length > MAX_GROUP_ROUTES) {
    keys
      .sort((a, b) => next![a].at - next![b].at)
      .slice(0, keys.length - MAX_GROUP_ROUTES)
      .forEach(key => { delete next![key] })
  }
  return next
}

/**
 * The latest report about a conversation that runs on `groupId`. A conversation
 * is known to its engine under its own id or the engine's session id, so both
 * are looked up; a report from a group the conversation has since left is
 * ignored.
 */
export function pickGroupRoute(
  routes: Routes,
  groupId: string,
  sessionKeys: ReadonlyArray<string | undefined>
): GroupRouteInfo | null {
  let latest: GroupRouteInfo | null = null
  for (const key of sessionKeys) {
    if (!key) continue
    const report = routes[key]
    if (report && report.groupId === groupId && (!latest || report.at > latest.at)) latest = report
  }
  return latest
}
