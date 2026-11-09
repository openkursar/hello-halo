/**
 * Connects load-balancing groups to the router.
 *
 * The router knows only how to serve a group it is handed and how to report
 * what happened. This module is where the two meet the rest of the app: it
 * tells the router what a group is (members, names, a credential per member on
 * demand), and it turns what the router reports into the state clients show.
 */

import {
  clearGroupRest,
  getGroupHealth,
  onGroupRouteFact,
  setGroupPlanResolver,
} from '../../openai-compat-router'
import type { GroupHealth, GroupRouteInfo } from '../../../shared/types/ai-groups-runtime'
import { groupMemberKey, normalizeGroups } from '../../../shared/ai-groups'
import { getConfig, onAiSourcesConfigChange } from '../../foundation/config.service'
import type { AISourcesConfig } from '../../../shared/types/ai-sources'
import { getAISourceManager } from './manager'
import { getGroup } from './groups'
import { createGroupPlanResolver } from './group-plan'
import { GroupRouteState } from './group-route-state'

const routeState = new GroupRouteState()

export function getGroupRoutes(sessionKeys: readonly string[]): GroupRouteInfo[] {
  return routeState.get(sessionKeys)
}

/**
 * Register the group resolver with the router and start following its reports.
 * `onRoute` receives each change worth showing. Returns a function that undoes both.
 */
export function startGroupRouting(onRoute: (info: GroupRouteInfo) => void): () => void {
  const manager = getAISourceManager()
  let snapshot: AISourcesConfig | undefined = getConfig().aiSources
  let groups = normalizeGroups(snapshot?.groups)
  const resolver = createGroupPlanResolver({
    readGroup: groupId => groups.find(group => group.id === groupId) ?? null,
    readSources: () => snapshot?.sources ?? [],
    backendFor: (sourceId, modelId) => manager.resolveMemberBackend(sourceId, modelId),
  })
  const stopConfig = onAiSourcesConfigChange(next => {
    snapshot = next
    groups = normalizeGroups(next?.groups)
    resolver.invalidate()
  })
  setGroupPlanResolver(groupId => resolver.resolve(groupId))

  const subscriptions = [
    onGroupRouteFact(fact => routeState.record(fact)),
    routeState.onChange(onRoute),
  ]
  return () => {
    setGroupPlanResolver(null)
    stopConfig()
    for (const subscription of subscriptions) subscription.dispose()
  }
}

/** How the models of a group stand now; null when there is no such group. */
export function getHealthOfGroup(groupId: string): GroupHealth | null {
  const group = getGroup(groupId)
  if (!group) return null
  const shape = {
    id: group.id,
    strategy: group.strategy,
    members: group.members.map(member => ({ key: groupMemberKey(member), sourceId: member.sourceId, modelId: member.modelId })),
  }
  return {
    groupId,
    members: getGroupHealth(shape).map(({ member, state, rest }) => ({
      sourceId: member.sourceId,
      modelId: member.modelId,
      state,
      ...(rest ? { reason: rest.reason, until: rest.until } : {}),
    })),
  }
}

/** "Try again now": end the rest of one model of a group, or of every account the group uses. Returns how many were released. */
export function releaseGroupRest(groupId: string, memberKey?: string): number {
  const group = getGroup(groupId)
  if (!group) return 0
  let released = 0
  if (memberKey) {
    released = group.members.some(member => groupMemberKey(member) === memberKey) ? clearGroupRest({ memberKey }) : 0
  } else {
    for (const sourceId of new Set(group.members.map(member => member.sourceId))) released += clearGroupRest({ sourceId })
  }
  console.log(`[AIGroups] Rests released group=${groupId} scope=${memberKey ? 'model' : 'group'} released=${released}`)
  return released
}
