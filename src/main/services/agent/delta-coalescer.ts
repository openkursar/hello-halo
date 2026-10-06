/**
 * Streamed deltas of one turn — reply text and thinking — merged and published
 * at most once per interval instead of once per model token.
 *
 * A provider can stream a couple of hundred small deltas a second; each one
 * published on its own is an IPC message, a WebSocket frame per remote client
 * and a store update in every client. Ordering is the caller's contract:
 * anything else the turn publishes goes after `flush()`, so no event overtakes
 * a delta produced before it.
 */

import { emitAgentEvent } from './events'

/** About 33 updates a second: a smooth stream, independent of the token rate. */
export const DELTA_INTERVAL_MS = 30

export interface DeltaCoalescer {
  text(delta: string): void
  /** Thinking text of one thought. */
  thought(thoughtId: string, delta: string): void
  /** Publishes what is pending now, in arrival order. */
  flush(): void
  /** Drops what is pending without publishing it. */
  discard(): void
}

interface Pending {
  /** Null for reply text. */
  thoughtId: string | null
  delta: string
}

export function createDeltaCoalescer(
  spaceId: string,
  conversationId: string,
  intervalMs: number = DELTA_INTERVAL_MS,
): DeltaCoalescer {
  let pending: Pending[] = []
  let timer: ReturnType<typeof setTimeout> | null = null

  const cancelTimer = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  const flush = () => {
    cancelTimer()
    if (pending.length === 0) return
    const batch = pending
    pending = []
    for (const { thoughtId, delta } of batch) {
      if (thoughtId === null) {
        emitAgentEvent('agent:message', spaceId, conversationId, {
          type: 'message',
          delta,
          isComplete: false,
          isStreaming: true
        })
      } else {
        emitAgentEvent('agent:thought-delta', spaceId, conversationId, { thoughtId, delta })
      }
    }
  }

  const add = (thoughtId: string | null, delta: string) => {
    if (!delta) return
    const last = pending[pending.length - 1]
    if (last && last.thoughtId === thoughtId) last.delta += delta
    else pending.push({ thoughtId, delta })
    if (!timer) timer = setTimeout(flush, intervalMs)
  }

  return {
    text: delta => add(null, delta),
    thought: (thoughtId, delta) => add(thoughtId, delta),
    flush,
    discard: () => {
      cancelTimer()
      pending = []
    },
  }
}
