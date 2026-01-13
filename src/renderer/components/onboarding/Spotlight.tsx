/**
 * Spotlight - Overlay component that highlights a target element
 *
 * Creates a dark overlay with a "hole" cut out around the target element,
 * drawing user attention to specific UI elements during onboarding.
 */

import { useState, useEffect, useCallback, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { useTranslation } from '../../i18n'

interface SpotlightProps {
  // CSS selector for the target element to highlight
  targetSelector: string

  // Content to display (tooltip/message)
  children: ReactNode

  // Position of the tooltip relative to the target
  tooltipPosition?: 'top' | 'bottom' | 'left' | 'right'

  // Padding around the highlighted area
  padding?: number

  // Border radius of the highlight hole
  borderRadius?: number

  // Whether to show skip button
  showSkip?: boolean

  // Skip button handler
  onSkip?: () => void

  // Called when user clicks the highlighted target
  onTargetClick?: () => void
}

interface HolePosition {
  x: number
  y: number
  width: number
  height: number
}

export function Spotlight({
  targetSelector,
  children,
  tooltipPosition = 'bottom',
  padding = 8,
  borderRadius = 12,
  showSkip = true,
  onSkip,
  onTargetClick,
}: SpotlightProps) {
  const [hole, setHole] = useState<HolePosition | null>(null)
  const [tooltipStyle, setTooltipStyle] = useState<React.CSSProperties>({})
  const { t } = useTranslation()

  // Calculate hole position and tooltip position
  const updatePositions = useCallback(() => {
    const target = document.querySelector(targetSelector)
    if (!target) return

    const rect = target.getBoundingClientRect()

    // Hole position with padding
    const holePos: HolePosition = {
      x: rect.x - padding,
      y: rect.y - padding,
      width: rect.width + padding * 2,
      height: rect.height + padding * 2,
    }
    setHole(holePos)

    // Calculate tooltip position
    const tooltipGap = 16
    let style: React.CSSProperties = {}

    switch (tooltipPosition) {
      case 'top':
        style = {
          left: rect.x + rect.width / 2,
          top: rect.y - padding - tooltipGap,
          transform: 'translate(-50%, -100%)',
        }
        break
      case 'bottom':
        style = {
          left: rect.x + rect.width / 2,
          top: rect.y + rect.height + padding + tooltipGap,
          transform: 'translate(-50%, 0)',
        }
        break
      case 'left':
        style = {
          left: rect.x - padding - tooltipGap,
          top: rect.y + rect.height / 2,
          transform: 'translate(-100%, -50%)',
        }
        break
      case 'right':
        style = {
          left: rect.x + rect.width + padding + tooltipGap,
          top: rect.y + rect.height / 2,
          transform: 'translate(0, -50%)',
        }
        break
    }

    setTooltipStyle(style)
  }, [targetSelector, padding, tooltipPosition])

  // Update positions on mount and resize
  useEffect(() => {
    updatePositions()

    // Re-calculate on resize
    window.addEventListener('resize', updatePositions)

    // Also observe DOM changes (in case target renders later)
    const observer = new MutationObserver(() => {
      setTimeout(updatePositions, 50)
    })
    observer.observe(document.body, { childList: true, subtree: true })

    return () => {
      window.removeEventListener('resize', updatePositions)
      observer.disconnect()
    }
  }, [updatePositions])

  // Timeout protection: if target element is not found within 5 seconds, auto-skip
  // This prevents the app from being stuck in a broken onboarding state
  useEffect(() => {
    if (hole) return // Target found, no need for timeout

    const timeoutId = setTimeout(() => {
      console.warn(`[Spotlight] Target element "${targetSelector}" not found after 5s, auto-skipping`)
      if (onSkip) {
        onSkip()
      }
    }, 5000)

    return () => clearTimeout(timeoutId)
  }, [hole, targetSelector, onSkip])

  // Handle click on the overlay (outside the hole)
  const handleOverlayClick = (e: React.MouseEvent) => {
    // Prevent clicks on the dark area from doing anything
    e.stopPropagation()
  }

  // When target element is not found yet, show a waiting overlay
  // This prevents the spotlight from "disappearing" while waiting for DOM to update
  if (!hole) {
    return (
      <>
        {/* Full screen overlay while waiting for target */}
        <div
          className="fixed inset-0 z-[100] bg-black/75"
          onClick={(e) => e.stopPropagation()}
        />
        {/* Loading indicator with skip option */}
        <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[103]">
          <div className="bg-card border border-border rounded-xl p-4 shadow-2xl">
            <div className="flex items-center gap-3">
              <div className="w-5 h-5 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
              <span className="text-sm text-muted-foreground">{t('Loading...')}</span>
            </div>
            {showSkip && onSkip && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onSkip()
                }}
                className="mt-3 pt-3 border-t border-border w-full text-center
                  text-sm text-muted-foreground hover:text-foreground
                  transition-colors cursor-pointer"
              >
                {t('Skip guide')}
              </button>
            )}
          </div>
        </div>
        </>
    )
  }

  // Generate clip-path polygon for the hole
  // This creates a full-screen shape with a rectangular hole cut out
  const clipPath = `polygon(
    0% 0%,
    0% 100%,
    ${hole.x}px 100%,
    ${hole.x}px ${hole.y}px,
    ${hole.x + hole.width}px ${hole.y}px,
    ${hole.x + hole.width}px ${hole.y + hole.height}px,
    ${hole.x}px ${hole.y + hole.height}px,
    ${hole.x}px 100%,
    100% 100%,
    100% 0%
  )`

  // Handle click on the clickable hole area
  // For view-artifact step, we don't auto-trigger click - let user click the actual element
  const handleHoleClick = () => {
    // Only trigger target click if onTargetClick is provided
    // This allows steps like view-artifact to handle clicks differently
    if (onTargetClick) {
      const target = document.querySelector(targetSelector) as HTMLElement
      if (target) {
        target.click()
      }
      onTargetClick()
    }
    // If no onTargetClick, do nothing - let the click pass through to the actual element
  }

  // When onTargetClick is undefined, we need to cut a hole in the overlay
  // so clicks can pass through to the actual element underneath
  const overlayStyle: React.CSSProperties = onTargetClick
    ? {}
    : {
        clipPath: `polygon(
          0% 0%,
          0% 100%,
          ${hole.x}px 100%,
          ${hole.x}px ${hole.y}px,
          ${hole.x + hole.width}px ${hole.y}px,
          ${hole.x + hole.width}px ${hole.y + hole.height}px,
          ${hole.x}px ${hole.y + hole.height}px,
          ${hole.x}px 100%,
          100% 100%,
          100% 0%
        )`
      }

  return (
    <>
      {/* Full screen overlay to block all clicks */}
      {/* When onTargetClick is undefined, cut a hole so clicks pass through */}
      <div
        className="fixed inset-0 z-[100] bg-black/75"
        style={overlayStyle}
        onClick={handleOverlayClick}
      />

      {/* Clickable hole area - sits above the overlay */}
      {/* When onTargetClick is defined, this captures clicks. Otherwise it's transparent */}
      {onTargetClick && (
        <div
          className="fixed z-[101] cursor-pointer"
          style={{
            left: hole.x,
            top: hole.y,
            width: hole.width,
            height: hole.height,
            borderRadius: borderRadius,
          }}
          onClick={handleHoleClick}
        />
      )}

      {/* Highlight border around the hole */}
      <div
        className="fixed pointer-events-none border-2 border-primary z-[102]"
        style={{
          left: hole.x,
          top: hole.y,
          width: hole.width,
          height: hole.height,
          borderRadius: borderRadius,
          boxShadow: '0 0 0 4px hsl(var(--primary) / 0.2), 0 0 20px hsl(var(--primary) / 0.3)',
        }}
      />

      {/* Tooltip content */}
      <div
        className="fixed z-[103] max-w-xs sm:max-w-sm animate-fade-in"
        style={tooltipStyle}
      >
        <div className="bg-card border border-border rounded-xl p-4 shadow-2xl">
          {children}

          {/* Skip button inside tooltip */}
          {showSkip && onSkip && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                onSkip()
              }}
              className="mt-3 pt-3 border-t border-border w-full text-center
                text-sm text-muted-foreground hover:text-foreground
                transition-colors cursor-pointer"
            >
              {t('Skip guide')}
            </button>
          )}
        </div>
      </div>
    </>
  )
}
