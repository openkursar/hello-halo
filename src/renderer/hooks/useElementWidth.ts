import { useCallback, useLayoutEffect, useState } from 'react'

/** The rendered width of an element, for layouts that follow their own container rather than the window. */
export function useElementWidth<T extends HTMLElement>(): [(element: T | null) => void, number] {
  const [element, setElement] = useState<T | null>(null)
  const [width, setWidth] = useState(0)
  const ref = useCallback((node: T | null) => setElement(node), [])
  useLayoutEffect(() => {
    if (!element) return
    setWidth(element.getBoundingClientRect().width)
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])
  return [ref, width]
}
