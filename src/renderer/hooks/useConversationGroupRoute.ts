/**
 * The model a group currently uses for one conversation. Mount only inside
 * group-only children so other conversations retain no routing or recovery listeners.
 */

import { useEffect } from 'react'
import { loadGroupRoutes, useGroupRouteStore, watchGroupRoutes } from '../stores/ai-group-route.store'
import { pickGroupRoute } from '../utils/group-routes'
import type { GroupRouteInfo } from '../../shared/types/ai-groups-runtime'

export function useConversationGroupRoute(
  conversation: { id: string; sessionId?: string } | null | undefined,
  groupId: string
): GroupRouteInfo | null {
  const id = conversation?.id
  const sessionId = conversation?.sessionId
  const watching = Boolean(groupId && id)

  useEffect(() => {
    if (!watching || !id) return
    const keys = sessionId ? [id, sessionId] : [id]
    const release = watchGroupRoutes(keys)
    void loadGroupRoutes(keys)
    return release
  }, [watching, id, sessionId])

  // A stable object from the store, so the card re-renders only when the router reports something new.
  return useGroupRouteStore(state => (watching && groupId ? pickGroupRoute(state.routes, groupId, [id, sessionId]) : null))
}
