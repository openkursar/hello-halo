/**
 * Declares which conversations this client renders streaming detail for.
 *
 * Main forwards every agent event for a declared conversation and only status
 * events (turn start, complete, error, question, goal) for the rest — the same
 * rule for the desktop window and remote clients (shared/agent-event-visibility).
 * Views that render a conversation's live detail retain it while mounted;
 * retains are reference-counted, so several views can show one conversation.
 *
 * Desktop: the full set is re-sent (coalesced per tick) whenever it changes; a
 * reloaded window starts empty and its views declare again on mount.
 * Remote: the first retain subscribes the WebSocket, the last release unsubscribes.
 */

import { isElectron, subscribeToConversation, unsubscribeFromConversation } from './transport'

const holders = new Map<string, number>()
let flushQueued = false

function flush(): void {
  flushQueued = false
  window.halo.setVisibleConversations(Array.from(holders.keys()))
}

function changed(conversationId: string, retained: boolean): void {
  if (isElectron()) {
    if (!flushQueued) {
      flushQueued = true
      queueMicrotask(flush)
    }
    return
  }
  if (retained) subscribeToConversation(conversationId)
  else unsubscribeFromConversation(conversationId)
}

/** Receive full streaming detail for `conversationId` until the returned release is called. */
export function retainConversationDetail(conversationId: string): () => void {
  const count = holders.get(conversationId) ?? 0
  holders.set(conversationId, count + 1)
  if (count === 0) changed(conversationId, true)
  let released = false
  return () => {
    if (released) return
    released = true
    const remaining = (holders.get(conversationId) ?? 1) - 1
    if (remaining > 0) {
      holders.set(conversationId, remaining)
      return
    }
    holders.delete(conversationId)
    changed(conversationId, false)
  }
}

/** Whether some view currently renders this conversation's streaming detail. */
export function isConversationDetailRetained(conversationId: string): boolean {
  return holders.has(conversationId)
}
