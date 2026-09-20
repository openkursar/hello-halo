/**
 * Header Component - Cross-platform title bar
 *
 * Handles platform-specific padding for window controls:
 * - macOS Electron: traffic lights get their own vertical clearance strip
 *   above the whole NavRail+Header row (App.tsx) — that's a separate concern
 *   from this header's own horizontal breathing room, so it still gets the
 *   same pl-3 as every other platform (prototype: `.header{padding:0 6px 0 12px}`)
 * - Windows/Linux Electron: titleBarOverlay buttons on the right (pr-36)
 * - Capacitor: safe area padding on top (status bar)
 * - Browser/Mobile: no extra padding needed (pl-3 pr-1.5)
 *
 * Height: 48px, matching the prototype's `.header{height:48px}` — its own
 * `.hbtn` (36px) needs more breathing room than a 40px row leaves.
 *
 * Single persistent instance, mounted once by `HeaderShell` in the app shell.
 * Pages don't render a `<header>` element themselves — they call `<Header
 * left right hidden />`, which portals its content into the shell's slots.
 * This keeps each page's own left/right JSX (and the hooks/state it reads)
 * exactly where it always was, while only one `<header>` DOM node ever exists.
 */

import { ReactNode, CSSProperties, createContext, useContext, useLayoutEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Monitor } from 'lucide-react'
import { isElectron, isCapacitor } from '../../api/transport'
import { useAppStore } from '../../stores/app.store'
import { useServerStore } from '../../stores/server.store'
import { useIsNarrowShell } from '../../hooks/useIsMobile'
import { NarrowNavSheet } from './NarrowNavSheet'

// Get platform info with fallback for SSR/browser
const getPlatform = () => {
  if (typeof window !== 'undefined' && window.platform) {
    return window.platform
  }
  // Fallback for non-Electron environments (e.g., remote web access)
  return {
    platform: 'darwin' as const,
    isMac: true,
    isWindows: false,
    isLinux: false
  }
}

// Export platform detection hook for use in other components
export function usePlatform() {
  return getPlatform()
}

// ============================================
// Slot registry — connects the shell's single <header> to whichever page is
// currently mounted, without either side needing a reference to the other.
// ============================================

interface HeaderSlotsContextValue {
  leftEl: HTMLDivElement | null
  rightEl: HTMLDivElement | null
  titleEl: HTMLDivElement | null
  setHidden: (hidden: boolean) => void
}

const HeaderSlotsContext = createContext<HeaderSlotsContextValue | null>(null)

interface HeaderProps {
  /** Left side content (after platform padding) */
  left?: ReactNode
  /** Right side content (before platform padding) */
  right?: ReactNode
  /**
   * Centered title (prototype `.header-title`: current conversation name,
   * single-line, truncated). Stays part of the draggable header — it's
   * plain text, not interactive.
   */
  title?: ReactNode
  /**
   * Replace the header with a bare drag strip for this page (e.g. a
   * maximized canvas that needs the traffic-light clearance but no chrome).
   * Cleared automatically when the calling page unmounts.
   */
  hidden?: boolean
}

/** Page-facing: portals left/right/title content into the shell's single header. */
export function Header({ left, right, title, hidden }: HeaderProps) {
  const ctx = useContext(HeaderSlotsContext)

  // Layout effect, not a passive one: this gates which DOM (real header vs
  // drag strip) the shell renders. A passive effect runs after paint, so the
  // outgoing page's cleanup and the incoming page's set land in different
  // frames — the wrong variant is visible for a beat during every view
  // switch. Layout effects for the unmount and the mount both resolve
  // before the browser paints, so only the correct state ever gets drawn.
  useLayoutEffect(() => {
    ctx?.setHidden(!!hidden)
    return () => ctx?.setHidden(false)
  }, [hidden, ctx])

  if (!ctx?.leftEl || !ctx?.rightEl || !ctx?.titleEl) return null

  return (
    <>
      {createPortal(left ?? null, ctx.leftEl)}
      {createPortal(title ?? null, ctx.titleEl)}
      {createPortal(right ?? null, ctx.rightEl)}
    </>
  )
}

// ============================================
// Shell chrome — the actual <header> DOM, rendered once by App.tsx
// ============================================

interface HeaderShellProps {
  children: ReactNode
}

/** Renders the single persistent header (or its hidden/drag-only variant) and provides the slot registry to whichever page is mounted as `children`. */
export function HeaderShell({ children }: HeaderShellProps) {
  const platform = getPlatform()
  const isInElectron = isElectron()
  const isInCapacitor = isCapacitor()
  const isNarrow = useIsNarrowShell()

  const navigate = useAppStore(s => s.navigate)
  const activeServer = useServerStore(s => s.getActive())

  const [leftEl, setLeftEl] = useState<HTMLDivElement | null>(null)
  const [rightEl, setRightEl] = useState<HTMLDivElement | null>(null)
  const [titleEl, setTitleEl] = useState<HTMLDivElement | null>(null)
  const [hidden, setHidden] = useState(false)

  const ctxValue = useMemo(() => ({ leftEl, rightEl, titleEl, setHidden }), [leftEl, rightEl, titleEl])

  // Platform-specific padding classes
  // macOS: traffic lights now live over the NavRail, Header needs no left inset
  // Windows/Linux: titleBarOverlay buttons overlay on the right
  // Capacitor: safe area left/right padding, no drag region
  // Browser/Mobile: no overlay, use normal padding
  //
  // The overlay-side inset clears native window chrome (titleBarOverlay
  // buttons) that does NOT scale with the persistent display zoom. Dividing
  // by --display-scale keeps the reserved space constant in real pixels so
  // content never slides under the buttons when zoomed out.
  const platformPadding = isInElectron
    ? platform.isMac
      ? 'pl-3 pr-1.5'
      : 'pl-3'
    : isInCapacitor
      ? 'pl-3 pr-1.5'    // Capacitor: standard padding, safe area handled by globals.css
      : 'pl-3 pr-1.5'    // Browser/Mobile: normal padding

  const chromeInset: CSSProperties = isInElectron && !platform.isMac
    ? { paddingRight: 'calc(9rem / var(--display-scale, 1))' }  // 144px for titleBarOverlay buttons
    : {}

  // Capacitor: disable drag region (no window chrome)
  const dragClass = isInCapacitor ? '' : 'drag-region'

  return (
    <HeaderSlotsContext.Provider value={ctxValue}>
      {hidden ? (
        // Bare drag strip: same footprint a maximized canvas needs (draggable)
        // with no chrome content on top of it. Matches the real header's height.
        <div
          className="h-12 flex-shrink-0 bg-background"
          style={{ WebkitAppRegion: 'drag' } as CSSProperties}
        />
      ) : (
        <header
          style={chromeInset}
          className={`
            flex items-center justify-between h-12 flex-shrink-0
            border-b border-border ${dragClass}
            ${platformPadding}
          `.trim().replace(/\s+/g, ' ')}
        >
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            {/* Unified destination menu: only way to reach Conversation/Digital
                Humans/Knowledge Base/Store/Settings when NavRail is hidden —
                every RAIL_VIEWS page reaches it the same way, so none of them
                need their own copy. */}
            {isNarrow && <NarrowNavSheet />}
            {/* Left slot — pure portal target, no sibling JSX children */}
            <div className="no-drag flex items-center gap-2 sm:gap-3 min-w-0" ref={setLeftEl} />
          </div>

          {/* Center: draggable title slot (prototype `.header-title`) — stays
              part of the drag region since it's plain text, no controls.
              Portal target itself always renders so empty pages just show a
              blank draggable strip, matching the prototype's flex:1 filler. */}
          <div className="flex-1 min-w-[100px] px-2 text-center text-[13px] text-subtle-foreground truncate" ref={setTitleEl} />

          {/* Right slot — kept as its own portal-only div; the Capacitor
              switcher is a separate sibling so it never shares DOM-child
              ownership with the portaled content. */}
          <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
            <div className="no-drag flex items-center gap-1 sm:gap-2" ref={setRightEl} />
            {/* Divider between the app's own header buttons and the native
                titleBarOverlay buttons living in chromeInset's reserved
                padding — without it the two groups visually run together. */}
            {isInElectron && !platform.isMac && (
              <div className="w-px h-5 bg-border flex-shrink-0" />
            )}
            {isInCapacitor && (
              <div className="no-drag">
                <button
                  onClick={() => navigate('serverList')}
                  className="flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-secondary transition-colors max-w-[120px]"
                  title={activeServer?.name}
                >
                  <Monitor className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                  <span className="text-xs text-muted-foreground truncate hidden sm:block">
                    {activeServer?.name ?? ''}
                  </span>
                </button>
              </div>
            )}
          </div>
        </header>
      )}
      {children}
    </HeaderSlotsContext.Provider>
  )
}
