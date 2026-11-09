/**
 * Closes an open dropdown on a click outside `ref` or on Escape. The click
 * path is fixed at dispatch, so a click whose target that same click swaps out
 * (the model card's name opening the list) still counts as inside.
 */

import { useEffect, useRef } from 'react'

export function useDismiss(ref: React.RefObject<HTMLElement>, open: boolean, close: () => void) {
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    if (!open) return
    const handleClick = (event: MouseEvent) => {
      if (ref.current && !event.composedPath().includes(ref.current)) closeRef.current()
    }
    const handleKey = (event: KeyboardEvent) => { if (event.key === 'Escape') closeRef.current() }
    // Deferred so the click that opened it doesn't close it.
    const timer = setTimeout(() => document.addEventListener('click', handleClick), 0)
    document.addEventListener('keydown', handleKey)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('click', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [open, ref])
}
