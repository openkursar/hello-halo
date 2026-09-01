/**
 * Header Component - Cross-platform title bar
 *
 * Handles platform-specific padding for window controls:
 * - macOS Electron: traffic lights sit over the NavRail, not the Header — no inset here
 * - Windows/Linux Electron: titleBarOverlay buttons on the right (pr-36)
 * - Capacitor: safe area padding on top (status bar)
 * - Browser/Mobile: no extra padding needed (pl-4)
 *
 * Height: 40px (compact, modern style)
 * Traffic light vertical center formula: y = height/2 - 7 = 13
 */

import { ReactNode, CSSProperties } from 'react'
import { Monitor } from 'lucide-react'
import { isElectron, isCapacitor } from '../../api/transport'
import { useAppStore } from '../../stores/app.store'
import { useServerStore } from '../../stores/server.store'

interface HeaderProps {
  /** Left side content (after platform padding) */
  left?: ReactNode
  /** Right side content (before platform padding) */
  right?: ReactNode
  /** Additional className for header */
  className?: string
}

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

export function Header({ left, right, className = '' }: HeaderProps) {
  const platform = getPlatform()
  const isInElectron = isElectron()
  const isInCapacitor = isCapacitor()

  // Capacitor: device switcher
  const navigate = useAppStore(s => s.navigate)
  const activeServer = useServerStore(s => s.getActive())

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
      ? 'pr-4'
      : 'pl-4'
    : isInCapacitor
      ? 'pl-4 pr-4'    // Capacitor: standard padding, safe area handled by globals.css
      : 'pl-4 pr-4'    // Browser/Mobile: normal padding

  const chromeInset: CSSProperties = isInElectron && !platform.isMac
    ? { paddingRight: 'calc(9rem / var(--display-scale, 1))' }  // 144px for titleBarOverlay buttons
    : {}

  // Capacitor: disable drag region (no window chrome)
  const dragClass = isInCapacitor ? '' : 'drag-region'

  // Header height: 40px, trafficLightPosition.y should be 40/2 - 7 = 13
  return (
    <header
      style={chromeInset}
      className={`
        flex items-center justify-between h-10
        border-b border-border ${dragClass}
        ${platformPadding}
        ${className}
      `.trim().replace(/\s+/g, ' ')}
    >
      {/* Left side: Interactive elements need no-drag to allow clicks */}
      <div className="flex items-center gap-2 sm:gap-3 min-w-0">
        <div className="no-drag flex items-center gap-2 sm:gap-3">
          {left}
        </div>
      </div>

      {/* Center: Draggable area - grows to fill space */}
      <div className="flex-1 min-w-[100px]" />

      {/* Right side: Interactive elements need no-drag to allow clicks */}
      <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
        <div className="no-drag flex items-center gap-1 sm:gap-2">
          {right}
          {/* Capacitor: device switcher button — always visible when connected */}
          {isInCapacitor && (
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
          )}
        </div>
      </div>
    </header>
  )
}

// Export platform detection hook for use in other components
export function usePlatform() {
  return getPlatform()
}

