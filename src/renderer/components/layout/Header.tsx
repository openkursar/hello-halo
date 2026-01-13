/**
 * Header Component - Cross-platform title bar
 *
 * Handles platform-specific padding for window controls:
 * - macOS Electron: traffic lights on the left (pl-20)
 * - Windows/Linux Electron: titleBarOverlay buttons on the right (pr-36)
 * - Browser/Mobile: no extra padding needed (pl-4)
 *
 * Height: 40px (compact, modern style)
 * Traffic light vertical center formula: y = height/2 - 7 = 13
 */

import { ReactNode } from 'react'
import { isElectron } from '../../api/transport'

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

  // Platform-specific padding classes
  // macOS: traffic lights overlay on the left
  // Windows/Linux: titleBarOverlay buttons overlay on the right
  // Browser/Mobile: no overlay, use normal padding
  const platformPadding = isInElectron
    ? platform.isMac
      ? 'pl-20 pr-4'   // Electron macOS: 80px left for traffic lights
      : 'pl-4 pr-36'   // Electron Windows/Linux: 140px right for titleBarOverlay buttons
    : 'pl-4 pr-4'      // Browser/Mobile: normal padding

  // Header height: 40px, trafficLightPosition.y should be 40/2 - 7 = 13
  return (
    <header
      className={`
        flex items-center justify-between h-10
        border-b border-border drag-region
        ${platformPadding}
        ${className}
      `.trim().replace(/\s+/g, ' ')}
    >
      <div className="flex items-center gap-3 no-drag min-w-0">
        {left}
      </div>

      <div className="flex items-center gap-2 no-drag flex-shrink-0">
        {right}
      </div>
    </header>
  )
}

// Export platform detection hook for use in other components
export function usePlatform() {
  return getPlatform()
}
