/**
 * PulseInlinePanel - Form A: Floating card pinned to chat area top-left
 *
 * Two sub-states:
 * - Expanded: Card with rounded corners, shadow, showing PulseList
 * - Collapsed: Small pill button with task count [▶ Pulse (3)]
 *
 * Uses absolute positioning to overlay on the chat area without affecting layout.
 * Semi-transparent background (pulse-glass) lets underlying chat content show through.
 * On Mac (GPU enabled): frosted glass with backdrop-filter blur.
 * On Windows (GPU disabled): solid semi-transparent background, no blur.
 *
 * No animations — switches instantly for performance.
 */

import { useCallback } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { usePulseCount } from '../../stores/chat.store'
import { useTranslation } from '../../i18n'
import { PulseList } from './PulseList'

/** Fixed width of the expanded card */
export const PULSE_PANEL_WIDTH = 260

/** Max height for the list area inside the card */
const PANEL_MAX_HEIGHT = '220px'

interface PulseInlinePanelProps {
  /** Controlled collapsed state (lifted to parent for persistence) */
  collapsed: boolean
  /** Called when user toggles collapse */
  onCollapsedChange: (collapsed: boolean) => void
}

export function PulseInlinePanel({ collapsed, onCollapsedChange }: PulseInlinePanelProps) {
  const { t } = useTranslation()
  const count = usePulseCount()

  const handleToggle = useCallback(() => {
    onCollapsedChange(!collapsed)
  }, [collapsed, onCollapsedChange])

  // Don't render at all if nothing to show
  if (count === 0) return null

  if (collapsed) {
    // Form A-collapsed: Small pill pinned to top-left (absolute overlay)
    return (
      <div className="absolute top-2 left-2 z-10">
        <button
          onClick={handleToggle}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg
            pulse-glass border border-border/50 shadow-md shadow-black/10
            hover:bg-secondary/50
            text-sm text-muted-foreground hover:text-foreground
            transition-colors"
        >
          <ChevronRight className="w-3.5 h-3.5" />
          <span className="font-medium">Pulse</span>
          <span className="text-xs bg-primary/20 text-primary px-1.5 py-0.5 rounded-full tabular-nums">
            {count}
          </span>
        </button>
      </div>
    )
  }

  // Form A: Expanded floating card (absolute overlay)
  return (
    <div className="absolute top-2 left-2 z-10">
      <div
        className="flex flex-col rounded-xl border border-border/50 pulse-glass shadow-lg shadow-black/10 overflow-hidden"
        style={{ width: PULSE_PANEL_WIDTH }}
      >
        {/* Header */}
        <div className="px-3 py-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Pulse
            </h3>
            <span className="text-xs text-muted-foreground/60 tabular-nums">
              {count}
            </span>
          </div>
          <button
            onClick={handleToggle}
            className="-m-1 p-2.5 rounded hover:bg-secondary/50 text-muted-foreground hover:text-foreground transition-colors"
            title={t('Collapse')}
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Divider */}
        <div className="mx-3 border-t border-border/30" />

        {/* List */}
        <PulseList maxHeight={PANEL_MAX_HEIGHT} compact />
      </div>
    </div>
  )
}
