/**
 * TokenUsageIndicator - Displays token usage in a subtle, non-intrusive way
 *
 * Design principles:
 * - Minimal by default: a small fill ring and "12K" in muted color
 * - Hover reveals details: full usage breakdown in tooltip
 * - Independent component: can be placed anywhere
 * - Mobile-friendly: tap to see details on touch devices
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { TokenUsage } from '../../types'
import { useTranslation } from '../../i18n'

interface TokenUsageIndicatorProps {
  tokenUsage: TokenUsage
  previousCost?: number  // Previous cumulative cost, used to calculate current message cost
  className?: string
}

// Format number to K format (e.g., 12345 -> "12K")
function formatTokens(tokens: number): string {
  if (tokens < 1000) return tokens.toString()
  if (tokens < 10000) return `${(tokens / 1000).toFixed(1)}K`
  return `${Math.round(tokens / 1000)}K`
}

// Format cost to USD (e.g., 0.0123 -> "$0.01")
function formatCost(cost: number): string {
  if (cost < 0.01) return `$${cost.toFixed(4)}`
  return `$${cost.toFixed(2)}`
}

/** Fixed-position offsets that put the tooltip above `anchor`, left-aligned (it sits under the reply's first column). */
function placeAbove(anchor: HTMLElement | null): { bottom: number; left: number } | null {
  if (!anchor?.isConnected) return null
  const rect = anchor.getBoundingClientRect()
  return { bottom: window.innerHeight - rect.top + 8, left: rect.left }
}

// r=5 in a 14-unit box; the arc starts at 12 o'clock and runs clockwise.
const RING_CIRCUMFERENCE = 2 * Math.PI * 5
/** Below this, a sliver of arc still shows that some context is in use. */
const RING_MIN_FRACTION = 0.04

export function TokenUsageIndicator({ tokenUsage, previousCost = 0, className = '' }: TokenUsageIndicatorProps) {
  const { t } = useTranslation()
  const anchorRef = useRef<HTMLDivElement>(null)
  // Viewport position of the tooltip; null while hidden. Portaled and fixed
  // because transcript rows clip their own paint.
  const [tooltipAt, setTooltipAt] = useState<{ bottom: number; left: number } | null>(null)
  const showTooltip = tooltipAt !== null
  const setShowTooltip = (show: boolean) => setTooltipAt(show ? placeAbove(anchorRef.current) : null)

  // A fixed tooltip does not travel with its anchor: follow it while the
  // transcript scrolls (it keeps scrolling while a reply streams in).
  useEffect(() => {
    if (!showTooltip) return
    let frame = 0
    const follow = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const next = placeAbove(anchorRef.current)
        // Move it only while still open: the scroll that carries the anchor
        // away from the pointer lands right after mouseleave has closed it.
        setTooltipAt(prev => (prev ? next : null))
      })
    }
    window.addEventListener('scroll', follow, true)
    window.addEventListener('resize', follow)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', follow, true)
      window.removeEventListener('resize', follow)
    }
  }, [showTooltip])

  // Current context size, matching CC's /context formula:
  //   input_tokens + cache_read_input_tokens + cache_creation_input_tokens
  // output_tokens is excluded — it is the generated reply, not part of the prompt the model saw.
  const contextUsed = tokenUsage.inputTokens + tokenUsage.cacheReadTokens +
                      tokenUsage.cacheCreationTokens

  // Defensive: avoid NaN when contextWindow is 0
  const contextWindow = tokenUsage.contextWindow > 0 ? tokenUsage.contextWindow : 200000
  const usagePercent = Math.round((contextUsed / contextWindow) * 100)

  // Calculate current message cost
  const currentCost = tokenUsage.totalCostUsd - previousCost

  // The ring shows how full the context is without reading the number; it turns
  // amber, then red, at the same points as the tooltip's warning.
  const ringFraction = Math.min(1, Math.max(RING_MIN_FRACTION, contextUsed / contextWindow))
  const ringColor = usagePercent >= 95 ? 'stroke-red-500' : usagePercent >= 80 ? 'stroke-amber-500' : 'stroke-current'

  return (
    <div
      ref={anchorRef}
      className={`relative inline-flex items-center ${className}`}
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
      onClick={() => setShowTooltip(!showTooltip)}
    >
      {/* Minimal display - cumulative context, subtle color to avoid anxiety */}
      {/* Hover answers like the copy button beside it: it is a control, not a caption. */}
      <span className="flex items-center gap-1 h-6 px-2 rounded-md text-xs text-faint-foreground cursor-default select-none transition-colors hover:bg-secondary hover:text-foreground">

        <svg viewBox="0 0 14 14" className="h-3.5 w-3.5 -rotate-90" aria-hidden="true">
          <circle cx="7" cy="7" r="5" fill="none" strokeWidth="2" className="stroke-border" />
          <circle
            cx="7" cy="7" r="5" fill="none" strokeWidth="2" strokeLinecap="round"
            className={ringColor}
            strokeDasharray={`${ringFraction * RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`}
          />
        </svg>
        {formatTokens(contextUsed)}
      </span>

      {/* Tooltip - shows on hover/tap */}
      {tooltipAt && createPortal(
        <div
          className="fixed z-50 pointer-events-none animate-fade-in"
          style={{ bottom: tooltipAt.bottom, left: tooltipAt.left }}
        >
          <div className="bg-popover border border-border rounded-lg shadow-lg p-3 min-w-[180px]">
            {/* Header */}
            <div className="text-xs font-medium text-foreground mb-2">
              {t('Token usage')}
            </div>

            {/* Progress bar */}
            <div className="h-1.5 bg-secondary rounded-full mb-2 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${
                  usagePercent >= 95
                    ? 'bg-red-500'
                    : usagePercent >= 80
                      ? 'bg-amber-500'
                      : 'bg-primary/60'
                }`}
                style={{ width: `${Math.min(usagePercent, 100)}%` }}
              />
            </div>

            {/* Usage stats */}
            <div className="space-y-1 text-xs">
              <div className="flex justify-between text-muted-foreground">
                <span>{t('Used / limit')}</span>
                <span className="text-foreground">
                  {formatTokens(contextUsed)} / {formatTokens(contextWindow)}
                </span>
              </div>
              <div className="flex justify-between text-muted-foreground">
                <span>{t('Input')}</span>
                <span>{formatTokens(tokenUsage.inputTokens)}</span>
              </div>
              <div className="flex justify-between text-muted-foreground">
                <span>{t('Output')}</span>
                <span>{formatTokens(tokenUsage.outputTokens)}</span>
              </div>
              {tokenUsage.cacheReadTokens > 0 && (
                <div className="flex justify-between text-muted-foreground">
                  <span>{t('Cache read')}</span>
                  <span>{formatTokens(tokenUsage.cacheReadTokens)}</span>
                </div>
              )}
              {tokenUsage.totalCostUsd > 0 && (
                <div className="flex justify-between text-muted-foreground pt-1 border-t border-border-faint">
                  <span>{t('Current / total')}</span>
                  <span className="text-foreground">
                    {formatCost(currentCost)}/{formatCost(tokenUsage.totalCostUsd)}
                  </span>
                </div>
              )}
            </div>

            {/* Warning if near limit */}
            {usagePercent >= 80 && (
              <div className={`mt-2 pt-2 border-t border-border-faint text-xs ${
                usagePercent >= 95 ? 'text-red-500' : 'text-amber-500'
              }`}>
                {usagePercent >= 95
                  ? t('Context will be automatically compressed soon')
                  : t('Approaching context limit')
                }
              </div>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
