/**
 * Conversations some local viewer renders in streaming detail.
 *
 * Each viewer — the desktop window (per webContents) and each remote-control
 * WebSocket client — declares its set under its own source key; the transports
 * record it here as they apply the delivery rule (shared/agent-event-visibility).
 * Consumers that must know what is being watched (e.g. which remote streams to
 * pull in) read the union and follow its changes, without importing transport.
 */

const bySource = new Map<string, ReadonlySet<string>>()
const listeners = new Set<(conversations: ReadonlySet<string>) => void>()
let union: ReadonlySet<string> = new Set()
let notifyQueued = false

function recompute(): void {
  const next = new Set<string>()
  for (const set of bySource.values()) for (const id of set) next.add(id)
  const changed = next.size !== union.size || [...next].some((id) => !union.has(id))
  union = next
  if (!changed || notifyQueued) return
  notifyQueued = true
  queueMicrotask(() => {
    notifyQueued = false
    for (const listener of listeners) {
      try {
        listener(union)
      } catch (error) {
        console.error('[ConversationDetail] Listener failed:', error)
      }
    }
  })
}

/** Replace what `source` renders in detail (an empty set clears it). */
export function setDetailConversations(source: string, conversations: Iterable<string>): void {
  const set = new Set(conversations)
  if (set.size === 0) bySource.delete(source)
  else bySource.set(source, set)
  recompute()
}

export function clearDetailConversations(source: string): void {
  if (bySource.delete(source)) recompute()
}

/** Union across every viewer. */
export function getDetailConversations(): ReadonlySet<string> {
  return union
}

/** Called (coalesced per tick) with the new union whenever it changes. */
export function onDetailConversationsChanged(listener: (conversations: ReadonlySet<string>) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
