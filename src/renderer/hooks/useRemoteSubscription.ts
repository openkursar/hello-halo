/**
 * useRemoteSubscription
 *
 * Manages WebSocket conversation subscription lifecycle for remote/Capacitor
 * clients. In Electron mode this is a no-op (events reach the renderer via IPC
 * without subscription).
 *
 * Subscribes on mount, unsubscribes on unmount, and re-subscribes when the
 * conversationId changes. Safe to call multiple times with the same id
 * (subscribeToConversation is idempotent).
 */

import { useEffect } from 'react'
import {
  isElectron,
  subscribeToConversation,
  unsubscribeFromConversation,
} from '../api/transport'

const observers = new Map<string, number>()

export function useRemoteSubscription(conversationId: string): void {
  useEffect(() => {
    if (isElectron()) return
    const count = observers.get(conversationId) ?? 0
    observers.set(conversationId, count + 1)
    if (count === 0) subscribeToConversation(conversationId)
    return () => {
      const remaining = (observers.get(conversationId) ?? 1) - 1
      if (remaining > 0) observers.set(conversationId, remaining)
      else { observers.delete(conversationId); unsubscribeFromConversation(conversationId) }
    }
  }, [conversationId])
}
