/**
 * Whether the AI is operating a terminal or a web page, as people see it.
 *
 * A tool call is too short to watch, and the gaps between calls would make a
 * mark blink. So work counts as operated from the start of the first call until
 * a while after the last one ends, and only those two moments are reported:
 * every client shows the same steady state, and a busy stretch of calls costs
 * two events, not two per call.
 */

/** How long work still reads as operated after the AI's last call on it. */
export const AI_OPERATING_HOLD_MS = 10_000

export interface ActivityHold<K> {
  /** A call on `key` started. */
  begin(key: K): void
  /** A call on `key` ended; the state turns off after the hold unless another begins. */
  end(key: K): void
  isActive(key: K): boolean
  /** Forget `key` without reporting (the work itself ended). */
  forget(key: K): void
}

interface Entry {
  inFlight: number
  timer: ReturnType<typeof setTimeout> | null
}

export function createActivityHold<K>(
  onChange: (key: K, active: boolean) => void,
  holdMs: number = AI_OPERATING_HOLD_MS,
): ActivityHold<K> {
  const entries = new Map<K, Entry>()

  const stopTimer = (entry: Entry) => {
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = null
  }

  return {
    begin(key) {
      let entry = entries.get(key)
      if (!entry) {
        entry = { inFlight: 0, timer: null }
        entries.set(key, entry)
        entry.inFlight++
        onChange(key, true)
        return
      }
      stopTimer(entry)
      entry.inFlight++
    },
    end(key) {
      const entry = entries.get(key)
      if (!entry) return
      entry.inFlight = Math.max(0, entry.inFlight - 1)
      if (entry.inFlight > 0 || entry.timer) return
      entry.timer = setTimeout(() => {
        if (entries.get(key) !== entry) return
        entries.delete(key)
        onChange(key, false)
      }, holdMs)
      // A pending hold must never keep a process alive on its own.
      ;(entry.timer as { unref?: () => void }).unref?.()
    },
    isActive(key) {
      return entries.has(key)
    },
    forget(key) {
      const entry = entries.get(key)
      if (!entry) return
      stopTimer(entry)
      entries.delete(key)
    },
  }
}
