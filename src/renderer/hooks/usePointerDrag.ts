import { useCallback, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'

interface DragPoint {
  clientX: number
  clientY: number
}

interface PointerDragOptions {
  enabled: boolean
  onStart: () => void
  onMove: (point: DragPoint) => void
  onEnd: (point: DragPoint) => void
}

/** Owns capture, a guest-safe input shield, and frame-coalesced updates for one gesture. */
export function usePointerDrag(options: PointerDragOptions) {
  const optionsRef = useRef(options)
  const cleanupRef = useRef<((notify: boolean) => void) | null>(null)

  useLayoutEffect(() => {
    optionsRef.current = options
    if (!options.enabled) cleanupRef.current?.(true)
  })
  useLayoutEffect(() => () => cleanupRef.current?.(false), [])

  return useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!optionsRef.current.enabled || !event.isPrimary || event.button !== 0 || cleanupRef.current) return
    event.preventDefault()
    const target = event.currentTarget
    const document = target.ownerDocument
    const view = document.defaultView!
    const pointerId = event.pointerId
    target.setPointerCapture(pointerId)
    let point: DragPoint = { clientX: event.clientX, clientY: event.clientY }
    let frame: number | null = null

    // Guest documents do not bubble input to the host; never move or hide the guest itself.
    const shield = document.createElement('div')
    shield.dataset.pointerDragShield = ''
    shield.className = 'fixed inset-0 z-50 cursor-col-resize touch-none select-none no-drag'
    shield.setAttribute('aria-hidden', 'true')
    document.body.appendChild(shield)

    const finish = (notify: boolean) => {
      if (cleanupRef.current !== finish) return
      cleanupRef.current = null
      if (frame !== null) view.cancelAnimationFrame(frame)
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
      target.removeEventListener('pointercancel', cancel)
      target.removeEventListener('lostpointercapture', cancel)
      view.removeEventListener('blur', blur)
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
      shield.remove()
      if (notify) optionsRef.current.onEnd(point)
    }
    const move = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return
      point = { clientX: event.clientX, clientY: event.clientY }
      if (frame !== null) return
      frame = view.requestAnimationFrame(() => {
        frame = null
        optionsRef.current.onMove(point)
      })
    }
    const up = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return
      point = { clientX: event.clientX, clientY: event.clientY }
      finish(true)
    }
    const cancel = (event: PointerEvent) => {
      if (event.pointerId === pointerId) finish(true)
    }
    const blur = () => finish(true)

    cleanupRef.current = finish
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
    target.addEventListener('pointercancel', cancel)
    target.addEventListener('lostpointercapture', cancel)
    view.addEventListener('blur', blur)
    optionsRef.current.onStart()
  }, [])
}
