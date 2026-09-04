/**
 * Cross-Conversation Interop — turn-end signal.
 *
 * `services/agent` has no dedicated hook for this, but it already broadcasts
 * `agent:complete`/`agent:error` on the public `onAgentEvent` subscription
 * (session-consumer.ts) for every turn ending — success, error, and the
 * safety-net fallback all reach it. This subscribes from outside
 * `services/agent`, the same way `ipc/agent.ts` already does for IPC/WebSocket
 * forwarding, rather than adding a new sink hook to it.
 *
 * Two independent things release on this same signal, in the order team's
 * `completeTurn` (message-bus.ts) uses — release the turn-gate slot first (a
 * sealed/ended turn must not leave the session fake-busy forever), then this
 * module's own bookkeeping, then drain whatever queued behind it:
 *
 * 1. `releaseConversationTurn`/`drainConversationTurn` (delivery.ts) — the
 *    turn-gate slot this conversation held while its turn ran. Without this,
 *    delivery to the same recipient succeeds at most once ever: the slot
 *    never frees, every later delivery buffers forever.
 * 2. `noteTurnEnded` (pending-wait.ts) — the `waitForReply` no_reply path.
 *    The event carries no message content (`{duration, tokenUsage}` /
 *    `{error}`), so this can only ever produce `no_reply` — never fill a
 *    wait from it.
 */

import { onAgentEvent } from '../agent/events'
import type { IDisposable } from '../../platform/event'
import { noteTurnEnded } from './pending-wait'
import { releaseConversationTurn, drainConversationTurn } from './delivery'

let subscription: IDisposable | null = null

async function handleTurnEnded(conversationId: string): Promise<void> {
  await releaseConversationTurn(conversationId)
  noteTurnEnded(conversationId)
  drainConversationTurn(conversationId)
}

/** Idempotent — a second call is a no-op until `disposeConversationInterop` runs. */
export function initConversationInterop(): void {
  if (subscription) return
  subscription = onAgentEvent((event) => {
    if (event.channel === 'agent:complete' || event.channel === 'agent:error') {
      void handleTurnEnded(event.conversationId)
    }
  })
}

export function disposeConversationInterop(): void {
  subscription?.dispose()
  subscription = null
}
