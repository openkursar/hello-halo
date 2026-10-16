/**
 * Cross-Conversation Interop — start-up and turn-end wiring.
 *
 * Starts the module: registers the space's own conversation source and listens
 * to every registered source's turn-end signal, including sources registered
 * after start (see `source.ts`).
 *
 * Two independent things release on a turn's end, in the order team's
 * `completeTurn` (message-bus.ts) uses — release the turn-gate slot first (a
 * sealed/ended turn must not leave the session fake-busy forever), then this
 * module's own bookkeeping, then drain whatever queued behind it:
 *
 * 1. `releaseConversationTurn`/`drainConversationTurn` (delivery.ts) — the
 *    turn-gate slot this conversation held while its turn ran. Without this,
 *    delivery to the same recipient succeeds at most once ever: the slot
 *    never frees, every later delivery buffers forever.
 * 2. `noteTurnEnded` (pending-wait.ts) — the `waitForReply` no_reply path.
 *    The signal carries no message content, so this can only ever produce
 *    `no_reply` — never fill a wait from it.
 */

import { DisposableStore, toDisposable, type IDisposable } from '../../platform/event'
import { circuitBreaker } from './circuit-breaker'
import { noteTurnEnded } from './pending-wait'
import { releaseConversationTurn, drainConversationTurn, notifyConversationTurnReady, holdConversationAfterStop } from './delivery'
import { onUserStop, onUserStopSettled } from '../agent'
import { createChatConversationSource } from './chat-source'
import { getConversationSources, onDidChangeConversationSources, registerConversationSource, sourceOfConversation } from './source'
import type { ConversationSource } from './source'

let running: DisposableStore | null = null
const finishing = new Set<string>()

async function handleTurnEnded(conversationId: string): Promise<void> {
  if (finishing.has(conversationId)) return
  finishing.add(conversationId)
  try {
    await releaseConversationTurn(conversationId)
    noteTurnEnded(conversationId)
    circuitBreaker.clearInboundForwardDepth(conversationId)
  } finally {
    // Release before draining: the next dispatch may fail synchronously and report its own ending.
    finishing.delete(conversationId)
  }
  drainConversationTurn(conversationId)
}

/** Idempotent — a second call is a no-op until `disposeConversationInterop` runs. */
export function initConversationInterop(): void {
  if (running) return
  const store = new DisposableStore()
  running = store

  const watching = new Map<ConversationSource, IDisposable>()
  const watch = (source: ConversationSource): void => {
    if (watching.has(source)) return
    const subscriptions = new DisposableStore()
    subscriptions.add(source.onTurnEnd((conversationId) => {
      handleTurnEnded(conversationId).catch((err) => {
        console.error(`[ConversationInterop] turn-end handling failed for ${conversationId}:`, err)
      })
    }))
    if (source.onTurnReady) subscriptions.add(source.onTurnReady(notifyConversationTurnReady))
    watching.set(source, subscriptions)
  }
  const unwatch = (source: ConversationSource): void => {
    watching.get(source)?.dispose()
    watching.delete(source)
  }

  store.add(
    toDisposable(() => {
      for (const subscription of watching.values()) subscription.dispose()
      watching.clear()
    })
  )
  store.add(
    onDidChangeConversationSources(({ type, source }) => (type === 'registered' ? watch(source) : unwatch(source)))
  )
  getConversationSources().forEach(watch)
  store.add(registerConversationSource(createChatConversationSource()))
  store.add(onUserStop(holdConversationAfterStop))
  // A stop that withdrew a continuation nothing had started leaves no turn end
  // behind; a turn still running reports its own end.
  store.add(onUserStopSettled((conversationId) => {
    if (sourceOfConversation(conversationId)?.isBusy(conversationId) !== false) return
    handleTurnEnded(conversationId).catch((err) => {
      console.error(`[ConversationInterop] turn-end handling after a stop failed for ${conversationId}:`, err)
    })
  }))
}

export function disposeConversationInterop(): void {
  running?.dispose()
  running = null
}
