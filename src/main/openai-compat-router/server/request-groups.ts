/**
 * How the router learns what a load-balancing group is. A session's backend
 * config names a group by id only; the AI source layer, which this module cannot
 * import, registers a resolver. It is asked once per request, so an edited group
 * or a rotated key applies without rebuilding any session.
 */

import type { AIGroupStrategy } from '../../../shared/types/ai-sources'
import type { MemberRef } from '../balancing'
import type { BackendConfig } from '../types'

export interface GroupMemberPlan {
  member: MemberRef
  /** What a person recognizes the member by. */
  label: { account: string; model: string }
}

export interface GroupPlan {
  id: string
  name: string
  strategy: AIGroupStrategy
  /** In priority order. */
  members: GroupMemberPlan[]
  /**
   * The member's complete backend config with its account's current
   * credential. Rejects when the account cannot serve a request (removed,
   * signed out, token unusable); the message is shown to the user.
   */
  materialize(member: MemberRef): Promise<BackendConfig>
}

/** The group the id names, or null when there is none. Must answer from memory. */
export type GroupPlanResolver = (groupId: string) => GroupPlan | null

let resolver: GroupPlanResolver | null = null

/** Registered once at startup by the AI source layer. */
export function setGroupPlanResolver(next: GroupPlanResolver | null): void {
  resolver = next
}

export function resolveGroupPlan(groupId: string): GroupPlan | null {
  return resolver ? resolver(groupId) : null
}
