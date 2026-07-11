/**
 * Identity → office member mapping (read-side authority keystone).
 *
 * An office-member credential proves a portable `identity` (Identity.id), never
 * an appId. The read-side scope gate (filterBoard/canContact/canBeAssigned)
 * decides on a member's appId. This module is the single server-side bridge
 * between the two: it resolves which member appIds an authenticated office
 * identity owns within a given office, so a request authenticated by a
 * credential can be projected down to exactly the member(s) it speaks for.
 *
 * Fail-closed: an unknown identity, a missing store, or an office with no
 * matching member resolves to an EMPTY set — a credential that maps to no
 * member is granted no member-scoped read, never a default-open fallback.
 */

import { getTeamStore } from '../../apps/team'

/**
 * The member appIds an authenticated `identity` owns within `officeId`.
 *
 * A member is owned by the identity when its portable `memberIdentity` matches.
 * Currently an office maps 1:1 to a team (officeId === teamId), so the lookup is
 * a single team's member list filtered by identity. Returns [] when the store is
 * unavailable, the identity is empty, or no member matches.
 */
export function resolveOfficeMemberAppIds(officeId: string, identity: string): string[] {
  if (!officeId || !identity) return []
  const store = getTeamStore()
  if (!store) return []
  return store
    .listMembersByTeam(officeId)
    .filter((m) => m.memberIdentity === identity)
    .map((m) => m.appId)
}
