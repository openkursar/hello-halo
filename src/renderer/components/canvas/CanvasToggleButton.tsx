import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useCanvasActions, useCanvasIsOpen, useTabCount } from '../../hooks/useCanvasLifecycle'
import { useTranslation } from '../../i18n'

const PLACEMENT_CLASS = {
  // Among the tab bar's own actions, while the canvas is open
  'tab-bar': 'canvas-tab-bar-action',
  // Flush with the top-right corner of the area the canvas folded away from, as tall as its tab bar (38px)
  edge: 'absolute right-0 top-0 z-20 flex h-[38px] items-center gap-0.5 rounded-bl-md border-b border-l border-border-soft bg-card/90 px-1.5 text-xs text-muted-foreground shadow-sm hover:bg-secondary hover:text-foreground transition-colors',
} as const

/**
 * Collapses the canvas from its tab bar, keeping its tabs and pages, and brings
 * a collapsed canvas back from the edge of the page, showing how many tabs are
 * waiting. Renders nothing when there are no tabs.
 */
export function CanvasToggleButton({ placement }: { placement: keyof typeof PLACEMENT_CLASS }) {
  const { t } = useTranslation()
  const isOpen = useCanvasIsOpen()
  const tabCount = useTabCount()
  const { toggleOpen } = useCanvasActions()

  if (tabCount === 0 || isOpen !== (placement === 'tab-bar')) return null

  const label = isOpen ? t('Collapse canvas') : t('Expand canvas')
  return (
    <button onClick={toggleOpen} className={PLACEMENT_CLASS[placement]} title={label} aria-label={label}>
      {isOpen ? (
        <ChevronRight className="w-4 h-4" strokeWidth={1.5} />
      ) : (
        <>
          <ChevronLeft className="w-3.5 h-3.5" />
          <span>{tabCount}</span>
        </>
      )}
    </button>
  )
}
