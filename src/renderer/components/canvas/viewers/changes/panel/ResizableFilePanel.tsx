import { useCallback, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from 'react'
import { useTranslation } from '../../../../../i18n'
import { useViewerResources } from '../../../viewer-resources'
import { clampPanelWidth, MIN_PANEL_WIDTH, panelWidthBounds } from '../shared/use-container-width'

interface ResizableFilePanelProps {
  containerRef: RefObject<HTMLElement | null>
  preferredWidth?: number
  onWidthChange: (width: number | undefined) => void
  children: ReactNode
}

type ResizeGesture =
  | { kind: 'pointer'; pointerId: number; element: HTMLDivElement; startX: number; startWidth: number; requested: number }
  | { kind: 'keyboard'; startWidth: number; requested: number }

function isResizeKey(key: string): boolean {
  return key === 'ArrowLeft' || key === 'ArrowRight' || key === 'Home' || key === 'End'
}

/** Keeps pixel-sized updates here; the viewer receives only the completed preference. */
export function ResizableFilePanel({ containerRef, preferredWidth, onWidthChange, children }: ResizableFilePanelProps) {
  const { t } = useTranslation()
  const resources = useViewerResources()
  const panelId = useId()
  const latest = useRef({ preferredWidth, onWidthChange })
  latest.current = { preferredWidth, onWidthChange }
  const gesture = useRef<ResizeGesture | null>(null)
  const [size, setSize] = useState(() => {
    const width = containerRef.current?.getBoundingClientRect().width ?? 0
    return { width: clampPanelWidth(width, preferredWidth), max: panelWidthBounds(width).max }
  })
  const liveWidth = useRef(size.width)

  const place = useCallback((requested?: number) => {
    const containerWidth = containerRef.current?.getBoundingClientRect().width ?? 0
    const width = clampPanelWidth(containerWidth, requested)
    const { max } = panelWidthBounds(containerWidth)
    liveWidth.current = width
    setSize((current) => current.width === width && current.max === max ? current : { width, max })
    return width
  }, [containerRef])

  const release = (current: ResizeGesture) => {
    if (current.kind === 'pointer' && current.element.hasPointerCapture(current.pointerId)) {
      current.element.releasePointerCapture(current.pointerId)
    }
  }

  const finish = () => {
    const current = gesture.current
    if (!current) return
    gesture.current = null
    const width = place(current.requested)
    release(current)
    if (width !== current.startWidth) latest.current.onWidthChange(width)
  }

  const cancel = () => {
    const current = gesture.current
    if (!current) return
    gesture.current = null
    release(current)
    place(latest.current.preferredWidth)
  }

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    const scope = resources.scope()
    const measure = () => place(gesture.current?.requested ?? latest.current.preferredWidth)
    measure()
    const observer = scope.add(new ResizeObserver(measure))
    observer.observe(container)
    scope.add(() => {
      const current = gesture.current
      gesture.current = null
      if (current?.kind === 'pointer' && current.element.hasPointerCapture(current.pointerId)) {
        current.element.releasePointerCapture(current.pointerId)
      }
    })
    return () => scope.dispose()
  }, [containerRef, place, resources])

  useLayoutEffect(() => {
    if (!gesture.current) place(preferredWidth)
  }, [preferredWidth, place])

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || event.button !== 0 || gesture.current?.kind === 'pointer') return
    if (gesture.current) finish()
    event.preventDefault()
    event.currentTarget.focus({ preventScroll: true })
    const width = place(liveWidth.current)
    gesture.current = {
      kind: 'pointer', pointerId: event.pointerId, element: event.currentTarget,
      startX: event.clientX, startWidth: width, requested: width,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = gesture.current
    if (current?.kind !== 'pointer' || current.pointerId !== event.pointerId) return
    current.requested = current.startWidth + current.startX - event.clientX
    place(current.requested)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && gesture.current) {
      event.preventDefault()
      event.stopPropagation()
      cancel()
      return
    }
    if (!isResizeKey(event.key) || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return
    event.preventDefault()
    event.stopPropagation()
    if (gesture.current?.kind === 'pointer') return
    const width = place(liveWidth.current)
    const current: ResizeGesture = gesture.current ?? { kind: 'keyboard', startWidth: width, requested: width }
    gesture.current = current
    const { min, max } = panelWidthBounds(containerRef.current?.getBoundingClientRect().width ?? 0)
    const delta = event.shiftKey ? 40 : 10
    current.requested = event.key === 'Home' ? min : event.key === 'End' ? max : width + (event.key === 'ArrowLeft' ? delta : -delta)
    place(current.requested)
  }

  return (
    <aside
      id={panelId}
      aria-label={t('File list')}
      className="relative flex min-h-0 shrink-0 flex-col border-l border-border bg-card"
      style={{ width: size.width }}
    >
      {children}
      <div
        role="separator"
        aria-label={t('Resize file list')}
        aria-orientation="vertical"
        aria-controls={panelId}
        aria-valuemin={MIN_PANEL_WIDTH}
        aria-valuemax={Math.round(size.max)}
        aria-valuenow={Math.round(size.width)}
        title={t('Drag to resize. Double-click to reset.')}
        tabIndex={0}
        className="absolute inset-y-0 -left-[3px] z-10 w-1.5 cursor-col-resize touch-none select-none hover:bg-primary/40 active:bg-primary/40 focus-visible:bg-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => {
          const current = gesture.current
          if (current?.kind === 'pointer' && current.pointerId === event.pointerId) {
            current.requested = current.startWidth + current.startX - event.clientX
            finish()
          }
        }}
        onPointerCancel={(event) => {
          const current = gesture.current
          if (current?.kind === 'pointer' && current.pointerId === event.pointerId) cancel()
        }}
        onLostPointerCapture={(event) => {
          const current = gesture.current
          if (current?.kind === 'pointer' && current.pointerId === event.pointerId) cancel()
        }}
        onKeyDown={onKeyDown}
        onKeyUp={(event) => {
          if (gesture.current?.kind === 'keyboard' && isResizeKey(event.key)) finish()
        }}
        onBlur={() => {
          if (gesture.current?.kind === 'keyboard') finish()
        }}
        onDoubleClick={() => {
          cancel()
          place()
          latest.current.onWidthChange(undefined)
        }}
      />
    </aside>
  )
}
