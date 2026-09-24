/**
 * ArtifactRail - Space resource rail (shell)
 *
 * Desktop (>=640px): Inline panel with drag-to-resize
 * Mobile (<640px): Floating button + Overlay panel
 *
 * Owns only the shell: expand/collapse, drag-resize, and the top tab strip.
 * Tab content is a sibling component per tab — Files/Skill/MCP, each a
 * standalone component the shell just mounts by active-tab id.
 *
 * Browser/terminal used to be footer buttons here; they now open from
 * Header's more menu (still the same ContentCanvas tab underneath — see
 * `useSpaceQuickActions`), since they aren't space *resources*, they're
 * quick actions.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { ArtifactFilesTab } from './ArtifactFilesTab'
import { DigitalHumansTab } from './DigitalHumansTab'
import { SkillsTab } from './SkillsTab'
import { McpTab } from './McpTab'
import { useCanvasStore } from '../../stores/canvas.store'
import { ChevronRight, X } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { useIsMobile } from '../../hooks/useIsMobile'
import type { ArtifactRailTab as RailTab } from '../../types'

// Width constraints (in pixels) - Desktop only
const MIN_WIDTH = 200
const MAX_WIDTH = 400
const DEFAULT_WIDTH = 300
// Prototype: `.rail{display:none}` unless `.body.rail-open` — collapsed
// means fully gone, not a persistent icon strip. 0 (not e.g. 48) so no
// border/background is left visible; content stays mounted underneath
// (CSS `hidden`, not unmounted) purely to preserve tab-internal state
// (tree expansion, fetched lists) across a collapse/expand cycle.
const COLLAPSED_WIDTH = 0
const clampWidth = (v: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, v))

interface ArtifactRailProps {
  // External control props for Canvas integration
  externalExpanded?: boolean        // Controlled expanded state from parent
  onExpandedChange?: (expanded: boolean) => void  // Callback when user toggles
  // Width persistence
  initialWidth?: number             // Persisted width from config
  onWidthChange?: (width: number) => void  // Callback when user finishes resizing
  /** One-shot external tab request (e.g. a workspace card's asset chip) —
   * every change switches to that tab, not just the first. */
  initialTab?: RailTab
}

/** Tab strip — Files/Skill/MCP, each a sibling content component below. */
function TabStrip({ active, onChange }: { active: RailTab; onChange: (tab: RailTab) => void }) {
  const { t } = useTranslation()
  const tabs: { id: RailTab; label: string }[] = [
    { id: 'files', label: t('Files') },
    { id: 'digital-humans', label: t('Digital Humans') },
    { id: 'skill', label: t('Skill') },
    { id: 'mcp', label: t('MCP') },
  ]
  return (
    <div className="flex items-center gap-1 overflow-x-auto">
      {tabs.map(tab => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={`h-[26px] px-2.5 rounded-sm text-[13px] transition-colors ease-halo ${
            active === tab.id ? 'bg-secondary text-foreground font-medium' : 'text-subtle-foreground hover:text-foreground'
          }`}
          aria-current={active === tab.id}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}

export function ArtifactRail({
  externalExpanded,
  onExpandedChange,
  initialWidth,
  onWidthChange,
  initialTab
}: ArtifactRailProps) {
  const { t } = useTranslation()

  const [activeTab, setActiveTab] = useState<RailTab>(initialTab ?? 'files')
  // Skill/MCP each do a real fetch (disk scan / IPC call) on mount, so they
  // must not mount until the user actually opens that tab — CSS-hidden
  // alone isn't enough, since hidden tabs still stay in the React tree and
  // run their effects. Once opened, a tab keeps its mount (added to this
  // set, never removed) so switching away and back doesn't refetch.
  const [mountedTabs, setMountedTabs] = useState<Set<RailTab>>(() => new Set<RailTab>(['files', ...(initialTab ? [initialTab] : [])]))

  const handleTabChange = useCallback((tab: RailTab) => {
    setActiveTab(tab)
    setMountedTabs(prev => (prev.has(tab) ? prev : new Set(prev).add(tab)))
  }, [])

  // The rail is a long-lived singleton (mounted once by SpacePage), so a
  // later `initialTab` change — e.g. a workspace card's asset chip, clicked
  // while already on this space — must still switch tabs, not just seed the
  // first render.
  useEffect(() => {
    if (initialTab) handleTabChange(initialTab)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTab])

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

  // Once a tab has been opened it stays mounted (CSS-hidden when inactive)
  // so switching back doesn't re-fetch or lose state — but a tab that was
  // never opened isn't in the DOM at all (see mountedTabs above), so Skill's
  // disk scan and MCP's IPC call only run for a space page whose user
  // actually opened that tab.
  const tabContent = (
    <>
      <div className={`flex-1 flex flex-col overflow-hidden${activeTab === 'files' ? '' : ' hidden'}`}>
        <ArtifactFilesTab />
      </div>
      {mountedTabs.has('digital-humans') && (
        <div className={`flex-1 flex flex-col overflow-hidden${activeTab === 'digital-humans' ? '' : ' hidden'}`}>
          <DigitalHumansTab />
        </div>
      )}
      {mountedTabs.has('skill') && (
        <div className={`flex-1 flex flex-col overflow-hidden${activeTab === 'skill' ? '' : ' hidden'}`}>
          <SkillsTab />
        </div>
      )}
      {mountedTabs.has('mcp') && (
        <div className={`flex-1 flex flex-col overflow-hidden${activeTab === 'mcp' ? '' : ' hidden'}`}>
          <McpTab />
        </div>
      )}
    </>
  )

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
          aria-label={t('Open workspace resources')}
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
                <TabStrip active={activeTab} onChange={handleTabChange} />
                <button
                  onClick={() => setMobileOverlayOpen(false)}
                  className="p-1 hover:bg-secondary rounded transition-colors"
                  aria-label={t('Close')}
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {tabContent}
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
      className={`h-full flex-shrink-0 flex flex-col relative overflow-hidden ${isExpanded ? 'border-l border-border bg-card' : ''}`}
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

      {/* Header — only rendered while expanded. Reopening is the page
          Header's toggle button (prototype: `#railBtn`), same as this
          button (prototype: rail-head's own `.icon-btn`) is only the
          collapse direction — there's no icon-only strip to click when
          closed, matching the prototype's binary show/hide. */}
      {isExpanded && (
        <div className="flex-shrink-0 pl-3 pr-1.5 h-10 border-b border-border flex items-center justify-between">
          <TabStrip active={activeTab} onChange={handleTabChange} />
          <button
            onClick={handleToggleExpanded}
            className="w-8 h-8 flex items-center justify-center rounded-sm text-subtle-foreground transition-colors ease-halo hover:bg-secondary hover:text-foreground"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Content — CSS-hidden when collapsed to preserve tab-internal state (tree expansion, fetched lists) */}
      <div className={`flex-1 flex flex-col overflow-hidden${isExpanded ? '' : ' hidden'}`}>
        {tabContent}
      </div>
    </div>
  )
}
