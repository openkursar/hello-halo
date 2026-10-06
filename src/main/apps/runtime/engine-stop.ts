/**
 * Making a stop reach the engine of an automation run.
 *
 * Aborting a run only tells its stream loop, which looks at the abort when the
 * engine's next message arrives. A run whose engine has gone silent — a hung
 * tool, MCP server or model request — would never notice. So the engine is
 * stopped the way a chat's Stop stops it: its turn is interrupted, and the
 * session is closed if the run has not ended a few seconds later, which ends
 * the stream and with it the run.
 */

/**
 * How long an interrupted engine gets to end its turn before it is closed.
 * Closing itself takes a few more seconds to end the process (the default
 * engine waits 5 s before killing it), so a silent run still ends within ~10 s.
 */
export const ENGINE_STOP_GRACE_MS = 3_000

/** The part of an engine session a stop needs. */
export interface StoppableEngine {
  interrupt?: () => Promise<unknown> | unknown
  close: () => void
}

/**
 * Stop `engine` when `signal` aborts (at once if it already has).
 *
 * @param canInterrupt whether the engine supports interrupting a turn; one that
 *   does not is closed straight away
 * @returns release, for when the run has ended: no stop is pending after it
 */
export function stopEngineOnAbort(
  signal: AbortSignal,
  engine: StoppableEngine,
  options: { canInterrupt: boolean; runTag: string; graceMs?: number },
): () => void {
  const { canInterrupt, runTag, graceMs = ENGINE_STOP_GRACE_MS } = options
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  let released = false

  const close = (reason: string): void => {
    if (released) return
    console.warn(`[Runtime][${runTag}] Closing the engine: ${reason}`)
    try {
      engine.close()
    } catch (err) {
      console.error(`[Runtime][${runTag}] Closing the engine failed:`, err)
    }
  }

  const stop = (): void => {
    if (!canInterrupt || typeof engine.interrupt !== 'function') {
      close('stop requested and the engine cannot interrupt a turn')
      return
    }
    console.log(`[Runtime][${runTag}] Stop requested — interrupting the engine`)
    closeTimer = setTimeout(() => close(`run still going ${graceMs}ms after the interrupt`), graceMs)
    Promise.resolve()
      .then(() => engine.interrupt!())
      .catch(err => {
        if (closeTimer) clearTimeout(closeTimer)
        close(`interrupt failed (${err instanceof Error ? err.message : String(err)})`)
      })
  }

  if (signal.aborted) stop()
  else signal.addEventListener('abort', stop, { once: true })

  return () => {
    released = true
    signal.removeEventListener('abort', stop)
    if (closeTimer) clearTimeout(closeTimer)
  }
}
