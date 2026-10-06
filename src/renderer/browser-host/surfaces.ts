interface BrowserSurface {
  element: HTMLElement
  enabled: boolean
}

// Only mounted viewers hold surfaces. Guests themselves belong to the host.
const surfaces = new Map<string, BrowserSurface>()
const listeners = new Set<(id: string) => void>()

export function getBrowserSurface(id: string): BrowserSurface | undefined {
  return surfaces.get(id)
}

export function subscribeBrowserSurfaces(listener: (id: string) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Borrows a guest's presentation without moving or owning its DOM element. */
export function bindBrowserSurface(
  id: string,
  element: HTMLElement,
  enabled = true,
  onBoundsChanged?: () => void
): () => void {
  const surface = { element, enabled }
  surfaces.set(id, surface)
  let frame = 0
  let disposed = false
  let previousBounds: { x: number; y: number; width: number; height: number } | undefined
  const win = element.ownerDocument.defaultView!

  const publish = () => {
    if (disposed) return
    const bounds = element.getBoundingClientRect()
    if (previousBounds && bounds.x === previousBounds.x && bounds.y === previousBounds.y &&
      bounds.width === previousBounds.width && bounds.height === previousBounds.height) return
    previousBounds = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
    for (const listener of listeners) listener(id)
    onBoundsChanged?.()
  }

  const isAnimating = () => {
    for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor.getAnimations().some(animation => animation.playState === 'running')) return true
    }
    return false
  }

  const followLayout = () => {
    frame = 0
    if (disposed) return
    publish()
    if (isAnimating()) frame = win.requestAnimationFrame(followLayout)
  }

  const scheduleLayout = () => {
    if (!frame && !disposed) frame = win.requestAnimationFrame(followLayout)
  }

  const onAnimation = (event: Event) => {
    if (event.target instanceof Element && event.target.contains(element)) scheduleLayout()
  }

  const observer = new ResizeObserver(scheduleLayout)
  observer.observe(element)
  win.addEventListener('resize', scheduleLayout)
  win.addEventListener('scroll', scheduleLayout, true)
  element.ownerDocument.addEventListener('transitionrun', onAnimation, true)
  element.ownerDocument.addEventListener('animationstart', onAnimation, true)
  publish()
  scheduleLayout()

  return () => {
    if (disposed) return
    disposed = true
    observer.disconnect()
    win.cancelAnimationFrame(frame)
    win.removeEventListener('resize', scheduleLayout)
    win.removeEventListener('scroll', scheduleLayout, true)
    element.ownerDocument.removeEventListener('transitionrun', onAnimation, true)
    element.ownerDocument.removeEventListener('animationstart', onAnimation, true)
    if (surfaces.get(id) === surface) {
      surfaces.delete(id)
      for (const listener of listeners) listener(id)
    }
  }
}
