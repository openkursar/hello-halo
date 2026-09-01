/**
 * TaskPanel - rail-triggered task panel
 *
 * Replaces PulseSidebarSection's notification duty (that component and its
 * embed in ConversationList are gone). Same underlying data — PulseList,
 * same usePulseCount() the rail badge reads — just triggered from the rail
 * instead of buried inside the conversation sidebar, and visible from every
 * RAIL_VIEWS page instead of only when a space's sidebar happens to be open.
 *
 * Two presentations, matching how every other rail-adjacent surface in this
 * shell already splits: docked column on desktop (participates in layout,
 * doesn't cover content, per the prototype), bottom sheet when
 * useIsNarrowShell() is true (matching NarrowNavSheet/MobileOverflowMenu —
 * there's no room to dock a 320px column on a narrow layout).
 */

import { X } from 'lucide-react'
import { PulseList } from '../pulse/PulseList'
import { usePulseCount } from '../../stores/chat.store'
import { useTaskPanelStore } from '../../stores/taskPanel.store'
import { useIsNarrowShell } from '../../hooks/useIsMobile'
import { useTranslation } from '../../i18n'

export function TaskPanel() {
  const { t } = useTranslation()
  const count = usePulseCount()
  const close = useTaskPanelStore(s => s.close)
  const isNarrow = useIsNarrowShell()

  const header = (
    <div className="flex-shrink-0 h-10 px-4 border-b border-border flex items-center justify-between">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">{t('Tasks')}</span>
        {count > 0 && (
          <span className="text-xs text-muted-foreground tabular-nums">{count}</span>
        )}
      </div>
      <button
        onClick={close}
        className="p-1 hover:bg-secondary rounded-lg transition-colors"
        aria-label={t('Close')}
      >
        <X className="w-4 h-4 text-muted-foreground" />
      </button>
    </div>
  )

  if (isNarrow) {
    return (
      <>
        <div
          onClick={close}
          className="fixed inset-0 bg-black/40 z-40 animate-fade-in"
          style={{ animationDuration: '0.2s' }}
        />
        <div className="fixed inset-x-0 bottom-0 z-50 bg-card rounded-t-2xl border-t border-border/50 shadow-2xl overflow-hidden flex flex-col max-h-[70vh] animate-slide-in-bottom">
          <div className="flex justify-center py-2 flex-shrink-0">
            <div className="w-10 h-1 bg-muted-foreground/30 rounded-full" />
          </div>
          {header}
          <PulseList />
        </div>
      </>
    )
  }

  return (
    <div className="w-[320px] h-full flex-shrink-0 bg-card border-r border-border flex flex-col">
      {header}
      <PulseList />
    </div>
  )
}
