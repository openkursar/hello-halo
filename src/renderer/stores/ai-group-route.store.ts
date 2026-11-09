/**
 * The latest router report per conversation about which model of a group serves
 * it. Nothing is read or listened to until a conversation on a group is on screen.
 */

import { create } from 'zustand'
import { api } from '../api'
import { isElectron, type WsConnectionState } from '../api/transport'
import { mergeGroupRoutes } from '../utils/group-routes'
import type { GroupRouteInfo } from '../../shared/types/ai-groups-runtime'

interface GroupRouteState {
  /** Latest report per conversation, keyed as its engine names the conversation. */
  routes: Readonly<Record<string, GroupRouteInfo>>
  ingest: (reports: readonly GroupRouteInfo[]) => void
}

export const useGroupRouteStore = create<GroupRouteState>(set => ({
  routes: {},
  ingest: reports => set(state => {
    const routes = mergeGroupRoutes(state.routes, reports)
    return routes === state.routes ? state : { routes }
  }),
}))

const watchers = new Set<readonly string[]>()
let stopListening: (() => void) | null = null
let stopRecovery: (() => void) | null = null
/** The visible conversation's latest read; replaced on navigation and released on settlement. */
let loading: { key: string; request: Promise<void> } | null = null

/**
 * Starts receiving the router's reports until the returned function is called;
 * the listener is shared by everyone watching and removed with the last of them.
 */
export function watchGroupRoutes(sessionKeys: readonly string[]): () => void {
  const keys = [...sessionKeys]
  watchers.add(keys)
  if (watchers.size === 1) {
    stopListening = api.onAIGroupRoute(report => useGroupRouteStore.getState().ingest([report]))
    if (!isElectron()) {
      let previous: WsConnectionState | null = null
      stopRecovery = api.onWsStateChange(state => {
        if (state === 'connected' && previous !== 'connected') {
          const observed = [...new Set([...watchers].flat())]
          void loadGroupRoutes(observed, true)
        }
        previous = state
      })
    }
  }
  let released = false
  return () => {
    if (released) return
    released = true
    watchers.delete(keys)
    if (watchers.size === 0) {
      stopListening?.()
      stopListening = null
      stopRecovery?.()
      stopRecovery = null
    }
  }
}

/** Asks what the router already knows about these conversations, for a view opened after the reports were sent. */
export async function loadGroupRoutes(sessionKeys: readonly string[], afterReconnect = false): Promise<void> {
  const keys = [...new Set(sessionKeys)].sort()
  if (keys.length === 0) return
  const key = JSON.stringify(keys)
  if (loading?.key === key && !afterReconnect) return loading.request
  const request = Promise.resolve().then(async () => {
    try {
      const response = await api.aiGroupsRoutes(keys)
      if (response.success && response.data) useGroupRouteStore.getState().ingest(response.data)
      else console.warn('[ai-group-route] Current route lookup refused:', response.error ?? 'No routing data returned')
    } catch (error) {
      console.warn('[ai-group-route] Could not read the current routes:', error instanceof Error ? error.message : error)
    }
  }).finally(() => {
    if (loading?.request === request) loading = null
  })
  loading = { key, request }
  return request
}
