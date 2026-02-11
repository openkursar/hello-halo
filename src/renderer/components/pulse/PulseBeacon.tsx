/**
 * PulseBeacon - Global task status indicator in the header
 *
 * Shows a breathing dot with task count badge.
 * Dot color reflects the most urgent status across all conversations.
 * Clicking opens the PulsePanel for quick task navigation.
 * Hidden when no active tasks or starred conversations exist.
 */

import { useState, useRef, useCallback } from 'react'
import { usePulseCount, usePulseBeaconStatus } from '../../stores/chat.store'
import { PulsePanel } from './PulsePanel'

const BEACON_DOT_CLASS: Record<string, string> = {
  'waiting': 'pulse-dot-waiting',
  'completed': 'pulse-dot-completed',
  'generating': 'pulse-dot-generating',
  'error': 'pulse-dot-error',
}

export function PulseBeacon() {
  const count = usePulseCount()
  const beaconStatus = usePulseBeaconStatus()
  const [isPanelOpen, setIsPanelOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const handleToggle = useCallback(() => {
    setIsPanelOpen(prev => !prev)
  }, [])

  const handleClose = useCallback(() => {
    setIsPanelOpen(false)
  }, [])

  // Don't render if nothing to show
  if (count === 0 && beaconStatus === null) return null

  const dotClass = beaconStatus ? BEACON_DOT_CLASS[beaconStatus] || '' : ''

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={handleToggle}
        className={`
          flex items-center gap-1.5 px-2 py-1.5 rounded-lg transition-colors
          ${isPanelOpen
            ? 'bg-primary/20 text-primary'
            : 'hover:bg-secondary text-muted-foreground hover:text-foreground'
          }
        `}
        title="Pulse"
        aria-expanded={isPanelOpen}
        aria-haspopup="true"
      >
        <span className={`pulse-dot ${dotClass}`} />
        {count > 0 && (
          <span className="text-xs font-medium tabular-nums">{count}</span>
        )}
      </button>

      {isPanelOpen && (
        <PulsePanel
          onClose={handleClose}
          anchorRef={buttonRef}
        />
      )}
    </div>
  )
}
