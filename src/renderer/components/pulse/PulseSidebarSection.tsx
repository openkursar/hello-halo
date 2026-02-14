/**
 * PulseSidebarSection - Pinned section embedded in ConversationList
 *
 * Renders as a collapsible top block inside ConversationList sidebar.
 * Width follows ConversationList (not fixed independently).
 * Component is self-contained — ConversationList just renders it at the top.
 *
 * Collapsed: Pin icon + count ▼
 * Expanded: Pin icon + count + PulseList
 */

import { useState, useCallback } from 'react'
import { ChevronDown, ChevronRight, Pin } from 'lucide-react'
import { usePulseCount } from '../../stores/chat.store'
import { useTranslation } from '../../i18n'
import { PulseList } from './PulseList'

/** Fixed height for the list in sidebar mode */
const SIDEBAR_MAX_HEIGHT = '200px'

export function PulseSidebarSection() {
  const { t } = useTranslation()
  const count = usePulseCount()
  const [collapsed, setCollapsed] = useState(false)

  const handleToggle = useCallback(() => {
    setCollapsed(prev => !prev)
  }, [])

  // Don't render if nothing to show
  if (count === 0) return null

  return (
    <div className="border-b border-border">
      {/* Header — always visible */}
      <button
        onClick={handleToggle}
        title={t('Shows active tasks, pending actions, and pinned conversations across all spaces. Completed or errored tasks auto-hide 1 minute after viewing.')}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-secondary/30 transition-colors"
      >
        {collapsed
          ? <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
          : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
        }
        <Pin className="w-3.5 h-3.5 text-muted-foreground" />
        <span className="text-xs text-muted-foreground/60 tabular-nums">
          {count}
        </span>
      </button>

      {/* List — hidden when collapsed */}
      {!collapsed && (
        <PulseList maxHeight={SIDEBAR_MAX_HEIGHT} compact />
      )}
    </div>
  )
}
