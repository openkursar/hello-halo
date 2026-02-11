/**
 * PulsePanel - Floating panel for Form C (Header Beacon dropdown)
 *
 * Positioned as a dropdown from PulseBeacon or as a mobile bottom sheet.
 * Delegates item rendering to PulseList.
 * Only used when PulseBeacon is active (narrow window / mobile).
 */

import { useEffect, useRef, useState, useCallback, RefObject } from 'react'
import { X } from 'lucide-react'
import { usePulseCount } from '../../stores/chat.store'
import { useTranslation } from '../../i18n'
import { useIsMobile } from '../../hooks/useIsMobile'
import { PulseList } from './PulseList'

interface PulsePanelProps {
  onClose: () => void
  anchorRef: RefObject<HTMLButtonElement | null>
}

export function PulsePanel({ onClose, anchorRef }: PulsePanelProps) {
  const { t } = useTranslation()
  const isMobile = useIsMobile()
  const count = usePulseCount()
  const panelRef = useRef<HTMLDivElement>(null)
  const [panelPosition, setPanelPosition] = useState({ top: 0, left: 0 })

  // Calculate position (desktop only)
  useEffect(() => {
    if (!isMobile && anchorRef.current) {
      const rect = anchorRef.current.getBoundingClientRect()
      setPanelPosition({
        top: rect.bottom + 8,
        left: Math.max(8, rect.left)
      })
    }
  }, [isMobile, anchorRef])

  // Click outside to close
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        panelRef.current &&
        !panelRef.current.contains(event.target as Node) &&
        anchorRef.current &&
        !anchorRef.current.contains(event.target as Node)
      ) {
        onClose()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [anchorRef, onClose])

  // Escape to close
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const panelHeader = (
    <div className="px-4 py-3 border-b border-border/50 flex items-center justify-between">
      <div>
        <h3 className="text-sm font-semibold text-foreground">Pulse</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          {count === 0
            ? t('No active tasks')
            : t('{{count}} items', { count })
          }
        </p>
      </div>
      {isMobile && (
        <button
          onClick={onClose}
          className="p-1.5 hover:bg-secondary rounded-lg transition-colors"
        >
          <X className="w-5 h-5 text-muted-foreground" />
        </button>
      )}
    </div>
  )

  if (isMobile) {
    // Mobile: Bottom sheet
    return (
      <>
        <div
          onClick={onClose}
          className="fixed inset-0 bg-black/40 z-40"
        />
        <div
          ref={panelRef}
          className="fixed inset-x-0 bottom-0 z-50 bg-card rounded-t-2xl border-t border-border/50 shadow-2xl overflow-hidden"
          style={{ maxHeight: '60vh' }}
        >
          <div className="flex justify-center py-2">
            <div className="w-10 h-1 bg-muted-foreground/30 rounded-full" />
          </div>
          {panelHeader}
          <PulseList maxHeight="360px" onItemClick={onClose} />
        </div>
      </>
    )
  }

  // Desktop: Dropdown panel
  return (
    <>
      <div
        onClick={onClose}
        className="fixed inset-0 z-40"
        style={{ background: 'transparent' }}
      />
      <div
        ref={panelRef}
        className="fixed z-50 pulse-panel bg-card/95 rounded-xl border border-border/50 shadow-2xl shadow-black/20 overflow-hidden min-w-[320px] max-w-[380px]"
        style={{
          top: panelPosition.top,
          left: panelPosition.left
        }}
      >
        {panelHeader}
        <PulseList maxHeight="360px" onItemClick={onClose} />
      </div>
    </>
  )
}
