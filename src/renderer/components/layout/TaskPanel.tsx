/**
 * TaskPanel - rail-triggered task panel
 *
 * Surfaces active tasks and unseen completions (PulseList; the rail badge
 * counts the same items via useTaskCount()) from a rail click, visible from
 * every RAIL_VIEWS page instead of only when a space's sidebar happens to
 * be open.
 *
 * Two presentations, matching how every other rail-adjacent surface in this
 * shell already splits: docked column on desktop (participates in layout,
 * doesn't cover content, per the prototype), bottom sheet when
 * useIsNarrowShell() is true (matching NarrowNavSheet/MobileOverflowMenu —
 * there's no room to dock a 340px column on a narrow layout).
 */

import { X, SquareCheckBig } from 'lucide-react'
import { PulseList } from '../pulse/PulseList'
import { countTaskItems, useTaskItems } from '../../stores/task.store'
import { useTaskPanelStore } from '../../stores/taskPanel.store'
import { useIsNarrowShell } from '../../hooks/useIsMobile'
import { useTranslation } from '../../i18n'
import { trackHome } from '../../services/home-telemetry'

export function TaskPanel() {
  const { t } = useTranslation()
  const items = useTaskItems()
  const closePanel = useTaskPanelStore(s => s.close)
  const isNarrow = useIsNarrowShell()

  const { continueCount, runningCount } = countTaskItems(items)

  const close = () => {
    trackHome('nav.task_panel.toggle', { open: false, surface: 'panel' })
    closePanel()
  }

  const header = (
    <div className="flex-shrink-0 px-3 pt-3 pb-2.5 flex items-center justify-between">
      <div className="flex items-center gap-2">
        <SquareCheckBig className="w-[17px] h-[17px]" strokeWidth={1.8} />
        <span className="text-sm font-semibold">{t('Tasks')}</span>
        {(continueCount > 0 || runningCount > 0) && (
          <span className="text-[11px] font-normal text-subtle-foreground tabular-nums">
            {continueCount > 0 && runningCount > 0
              ? t('{{continue}} to continue · {{running}} running', { continue: continueCount, running: runningCount })
              : continueCount > 0
                ? t('{{continue}} to continue', { continue: continueCount })
                : t('{{running}} running', { running: runningCount })}
          </span>
        )}
      </div>
      <button
        onClick={close}
        className="w-7 h-7 rounded-sm flex items-center justify-center text-subtle-foreground transition-colors hover:bg-secondary hover:text-foreground"
        aria-label={t('Close')}
      >
        <X className="w-4 h-4" strokeWidth={1.8} />
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
    <div className="w-[340px] h-full flex-shrink-0 bg-card border-r border-border flex flex-col animate-fade-up">
      {header}
      <PulseList />
    </div>
  )
}
