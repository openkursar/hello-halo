/**
 * Making a stop reach the engine an execution reads.
 *
 * Aborting only tells the stream loop, which looks at the abort when the
 * engine's next message arrives. An engine that has gone silent — a hung tool,
 * MCP server or model request — would never notice. So the engine is stopped the
 * way a chat's Stop stops it: its turn is interrupted, and the session is closed
 * if the turn has not ended a few seconds later, which ends the stream with it.
 */

import type { ExecutionEngineControl } from './types'

/**
 * How long an interrupted engine gets to end its turn before it is closed.
 * Closing itself takes a few more seconds to end the process (the default
 * engine waits 5 s before killing it), so a silent execution still ends within ~10 s.
 */
export const ENGINE_STOP_GRACE_MS = 3_000

export interface EngineStop {
  /** Interrupt the turn, or close the session at once when it cannot be interrupted. Once. */
  stop(): void
  /** The read has ended: no stop is pending after this, and a later `stop` does nothing. */
  release(): void
}

export function createEngineStop(
  engine: ExecutionEngineControl,
  options: { label: string; graceMs?: number },
): EngineStop {
  const { label, graceMs = ENGINE_STOP_GRACE_MS } = options
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  let released = false
  let stopped = false

  const close = (reason: string): void => {
    if (released) return
    console.warn(`[AgentExecution] Closing the engine: execution=${label} ${reason}`)
    try {
      engine.close()
    } catch (err) {
      console.error(`[AgentExecution] Closing the engine failed: execution=${label}`, err)
    }
  }

  return {
    stop(): void {
      if (stopped || released) return
      stopped = true
      if (!engine.canInterrupt || typeof engine.interrupt !== 'function') {
        close('stop requested and the engine cannot interrupt a turn')
        return
      }
      console.log(`[AgentExecution] Stop requested — interrupting the engine: execution=${label}`)
      closeTimer = setTimeout(() => close(`still going ${graceMs}ms after the interrupt`), graceMs)
      Promise.resolve()
        .then(() => engine.interrupt!())
        .catch(err => {
          if (closeTimer) clearTimeout(closeTimer)
          close(`interrupt failed (${err instanceof Error ? err.message : String(err)})`)
        })
    },
    release(): void {
      released = true
      if (closeTimer) clearTimeout(closeTimer)
    },
  }
}
