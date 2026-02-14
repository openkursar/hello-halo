/**
 * SidebarToggle - Floating button that toggles the conversation sidebar
 *
 * Shows a pulse status dot overlay to indicate active tasks across all conversations.
 * Positioned absolutely in the chat content area (top-left).
 * Clicking toggles the ConversationList sidebar open/closed.
 */

import { Menu } from 'lucide-react'
import { usePulseBeaconStatus } from '../../stores/chat.store'
import { useTranslation } from '../../i18n'

interface SidebarToggleProps {
  isOpen: boolean
  onToggle: () => void
}

const BEACON_DOT_CLASS: Record<string, string> = {
  waiting: 'pulse-dot-waiting',
  completed: 'pulse-dot-completed',
  generating: 'pulse-dot-generating',
  error: 'pulse-dot-error',
}

export function SidebarToggle({ isOpen, onToggle }: SidebarToggleProps) {
  const { t } = useTranslation()
  const beaconStatus = usePulseBeaconStatus()

  return (
    <button
      onClick={onToggle}
      className={`
        relative flex items-center gap-1.5 p-1.5 rounded-r-lg transition-colors
        bg-background/80 backdrop-blur-sm border border-l-0 border-border/50 shadow-sm
        hover:bg-secondary text-muted-foreground hover:text-foreground
      `}
      title={isOpen ? t('Close sidebar') : t('Open sidebar')}
      aria-expanded={isOpen}
      aria-label={t('Toggle sidebar')}
    >
      <Menu className="w-4 h-4" />

      {/* Pulse status dot overlay - top-right corner of icon */}
      {beaconStatus && (
        <span
          className={`absolute top-0.5 right-0.5 w-2 h-2 rounded-full pulse-dot ${BEACON_DOT_CLASS[beaconStatus] || ''}`}
        />
      )}
    </button>
  )
}
