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
import { noteTurnEnded } from './pending-wait'
import { releaseConversationTurn, drainConversationTurn } from './delivery'
import { createChatConversationSource } from './chat-source'
import { getConversationSources, onDidChangeConversationSources, registerConversationSource } from './source'
import type { ConversationSource } from './source'

let running: DisposableStore | null = null

async function handleTurnEnded(conversationId: string): Promise<void> {
  await releaseConversationTurn(conversationId)
  noteTurnEnded(conversationId)
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
    watching.set(
      source,
      source.onTurnEnd((conversationId) => {
        handleTurnEnded(conversationId).catch((err) => {
          console.error(`[ConversationInterop] turn-end handling failed for ${conversationId}:`, err)
        })
      })
    )
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
}

export function disposeConversationInterop(): void {
  running?.dispose()
  running = null
}
