/**
 * useWsRecovery
 *
 * Triggers a recovery callback when the WebSocket connection transitions
 * from disconnected/connecting → connected (i.e., a reconnect just succeeded).
 *
 * Purpose: Remote/Capacitor clients may lose WebSocket events during brief
 * disconnections. Components that display real-time data (the chat page,
 * ImChatView) use this hook to reload their messages after a reconnect,
 * ensuring no events are silently lost.
 *
 * In Electron mode this is a no-op (events reach the renderer via IPC).
 */

import { useEffect, useRef } from 'react'
import { api } from '../api'
import { isElectron } from '../api/transport'
import type { WsConnectionState } from '../api/transport'

/**
 * Calls `onReconnect` whenever the WebSocket transitions to 'connected'
 * from a non-connected state (skips the initial connection on mount).
 */
export function useWsRecovery(onReconnect: () => void): void {
  // Track the previous WS state to detect transitions
  const prevStateRef = useRef<WsConnectionState | null>(null)
  // Skip the very first 'connected' event (initial connection, not a reconnect)
  const hasConnectedOnceRef = useRef(false)
  // Stable ref to avoid re-subscribing when the callback identity changes
  const callbackRef = useRef(onReconnect)
  callbackRef.current = onReconnect

  useEffect(() => {
    if (isElectron()) return

    const unsub = api.onWsStateChange((state: WsConnectionState) => {
      const prev = prevStateRef.current
      prevStateRef.current = state

      if (state === 'connected') {
        if (!hasConnectedOnceRef.current) {
          // First connection — not a reconnect, just record it
          hasConnectedOnceRef.current = true
          return
        }

        // Genuine reconnect: previous state was disconnected or connecting
        if (prev === 'disconnected' || prev === 'connecting') {
          console.log('[useWsRecovery] WebSocket reconnected — triggering recovery')
          callbackRef.current()
        }
      }
    })

    return unsub
  }, [])
}
