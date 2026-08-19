import { useEffect, useState } from 'react'

/** Returns a copy of `value` that only updates after it has stopped changing
 * for `delayMs`. Use to keep expensive effects (network/IPC probes) off every
 * keystroke of a controlled input. */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(id)
  }, [value, delayMs])
  return debounced
}
