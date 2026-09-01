/**
 * ArtifactRail - Space resource rail (shell)
 *
 * Desktop (>=640px): Inline panel with drag-to-resize
 * Mobile (<640px): Floating button + Overlay panel
 *
 * Owns only the shell: expand/collapse, drag-resize, and the top tab strip.
 * Tab content is a sibling component per tab — today just "Files"
 * (`ArtifactFilesTab`); Skill/MCP tabs join later as their own components,
 * added to the strip without touching this shell.
 *
 * Browser/terminal used to be footer buttons here; they now open from
 * Header's more menu (still the same ContentCanvas tab underneath — see
 * `useSpaceQuickActions`), since they aren't space *resources*, they're
 * quick actions.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { ArtifactFilesTab } from './ArtifactFilesTab'
import { useCanvasStore } from '../../stores/canvas.store'
import { ChevronRight, X } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useIsMobile } from '../../hooks/useIsMobile'

// Width constraints (in pixels) - Desktop only
const MIN_WIDTH = 200
const MAX_WIDTH = 400
const DEFAULT_WIDTH = 300
const COLLAPSED_WIDTH = 48
const clampWidth = (v: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, v))

interface ArtifactRailProps {
  // External control props for Canvas integration
  externalExpanded?: boolean        // Controlled expanded state from parent
  onExpandedChange?: (expanded: boolean) => void  // Callback when user toggles
  // Width persistence
  initialWidth?: number             // Persisted width from config
  onWidthChange?: (width: number) => void  // Callback when user finishes resizing
}

/** Tab strip — one tab today; sized to grow without shell changes. */
function TabStrip() {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-1">
      <button
        className="h-7 px-2.5 rounded-md text-sm font-medium bg-secondary text-foreground"
        aria-current="true"
      >
        {t('Files')}
      </button>
    </div>
  )
}

export function ArtifactRail({
  externalExpanded,
  onExpandedChange,
  initialWidth,
  onWidthChange
}: ArtifactRailProps) {
  const { t } = useTranslation()

  const isControlled = externalExpanded !== undefined
  const [internalExpanded, setInternalExpanded] = useState(true)
  const isExpanded = isControlled ? externalExpanded : internalExpanded

  const [width, setWidth] = useState(initialWidth != null ? clampWidth(initialWidth) : DEFAULT_WIDTH)
  const widthRef = useRef(width)
  const [isDragging, setIsDragging] = useState(false)
  const [mobileOverlayOpen, setMobileOverlayOpen] = useState(false)
  const railRef = useRef<HTMLDivElement>(null)
  const onWidthChangeRef = useRef(onWidthChange)
  onWidthChangeRef.current = onWidthChange
  const isMobile = useIsMobile()

  // Sync width when initialWidth arrives from async config load
  useEffect(() => {
    if (initialWidth !== undefined && !isDragging) {
      const clamped = clampWidth(initialWidth)
      setWidth(clamped)
      widthRef.current = clamped
    }
  }, [initialWidth, isDragging])

  // When Canvas is open, disable transition to prevent layout flicker during resize/close
  const isCanvasOpen = useCanvasStore(state => state.isOpen)

  // Handle expand/collapse toggle
  const handleToggleExpanded = useCallback(() => {
    const newExpanded = !isExpanded

    // UI-first optimization: When Canvas is open, directly update DOM
    // before React state update to ensure layout resizes immediately
    if (isCanvasOpen && railRef.current) {
      const targetWidth = newExpanded ? width : COLLAPSED_WIDTH
      railRef.current.style.width = `${targetWidth}px`
    }

    if (isControlled) {
      onExpandedChange?.(newExpanded)
    } else {
      setInternalExpanded(newExpanded)
    }
  }, [isExpanded, isControlled, onExpandedChange, isCanvasOpen, width])

  // Handle drag resize (desktop only)
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (isMobile) return
    e.preventDefault()
    setIsDragging(true)
  }, [isMobile])

  useEffect(() => {
    if (!isDragging || isMobile) return

    const handleMouseMove = (e: MouseEvent) => {
      if (!railRef.current) return
      const newWidth = window.innerWidth - e.clientX
      const clampedWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, newWidth))
      setWidth(clampedWidth)
      widthRef.current = clampedWidth
    }

    const handleMouseUp = () => {
      setIsDragging(false)
      onWidthChangeRef.current?.(widthRef.current)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging, isMobile])

  // Close mobile overlay when switching to desktop
  useEffect(() => {
    if (!isMobile && mobileOverlayOpen) {
      setMobileOverlayOpen(false)
    }
  }, [isMobile, mobileOverlayOpen])

  // ==================== Mobile Overlay Mode ====================
  if (isMobile) {
    return (
      <>
        {/* Floating trigger button - z-[60] to stay above Canvas overlay (z-50) */}
        <button
          onClick={() => setMobileOverlayOpen(true)}
          className="
            fixed right-0 top-1/3 z-[60]
            w-10 h-14
            bg-card
            border-l border-y border-border
            rounded-l-xl
            shadow-lg
            flex flex-col items-center justify-center gap-1
            hover:bg-card
            active:scale-95
            transition-all duration-200
          "
          aria-label={t('Open space resources')}
        >
          <ChevronRight className="w-4 h-4 text-muted-foreground rotate-180" />
        </button>

        {/* Overlay backdrop + panel - z-[70] to stay above Canvas overlay (z-50) */}
        {mobileOverlayOpen && (
          <div className="fixed z-[70] flex justify-end" style={{ top: 'var(--sat, 0px)', right: 0, bottom: 0, left: 0 }}>
            {/* Backdrop */}
            <div
              className="absolute inset-0 bg-background/70 animate-fade-in"
              onClick={() => setMobileOverlayOpen(false)}
            />

            {/* Slide-in panel */}
            <div
              className="
                relative w-[min(280px,75vw)] h-full
                bg-card border-l border-border
                flex flex-col
                animate-slide-in-right-full
                shadow-2xl
              "
            >
              {/* Header */}
              <div className="p-3 border-b border-border flex items-center justify-between">
                <TabStrip />
                <button
                  onClick={() => setMobileOverlayOpen(false)}
                  className="p-1 hover:bg-secondary rounded transition-colors"
                  aria-label={t('Close')}
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <ArtifactFilesTab />
            </div>
          </div>
        )}
      </>
    )
  }

  // ==================== Desktop Inline Mode ====================
  const displayWidth = isExpanded ? width : COLLAPSED_WIDTH

  return (
    <div
      ref={railRef}
      className="h-full flex-shrink-0 border-l border-border bg-card/30 flex flex-col relative"
      style={{
        width: displayWidth,
        // Disable transition when: dragging OR Canvas is open (prevent layout flicker)
        transition: (isDragging || isCanvasOpen) ? 'none' : 'width 0.2s ease'
      }}
    >
      {/* Drag handle - only show when expanded */}
      {isExpanded && (
        <div
          className={`absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-primary/50 transition-colors z-20 ${
            isDragging ? 'bg-primary/50' : ''
          }`}
          onMouseDown={handleMouseDown}
          title={t('Drag to resize')}
        />
      )}

      {/* Header - height matches CanvasTabs (py-1.5 + h-7 content = ~40px) */}
      <div className="flex-shrink-0 px-3 h-10 border-b border-border flex items-center justify-between">
        {isExpanded && <TabStrip />}
        <button
          onClick={handleToggleExpanded}
          className="p-1 hover:bg-secondary rounded transition-colors"
        >
          <ChevronRight className={`w-4 h-4 transition-transform ${isExpanded ? '' : 'rotate-180'}`} />
        </button>
      </div>

      {/* Content — CSS-hidden when collapsed to preserve ArtifactTree folder expansion state */}
      <div className={`flex-1 flex flex-col overflow-hidden${isExpanded ? '' : ' hidden'}`}>
        <ArtifactFilesTab />
      </div>
    </div>
  )
}
