import { PanelRightClose, PanelRightOpen } from 'lucide-react'
import { useCanvasActions, useCanvasIsOpen, useTabCount } from '../../hooks/useCanvasLifecycle'
import { useTranslation } from '../../i18n'

const PLACEMENT_CLASS = {
  // Among the tab bar's own actions, while the canvas is open
  'tab-bar': 'canvas-tab-bar-action',
  // On the right edge of the area the canvas folded away from, while it is collapsed
  edge: 'absolute right-0 top-1/2 -translate-y-1/2 z-20 flex items-center gap-1 rounded-l-lg border border-r-0 border-border-soft bg-card/90 px-1.5 py-2 text-xs text-muted-foreground shadow-sm hover:bg-secondary hover:text-foreground transition-colors',
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
        <PanelRightClose className="w-4 h-4" />
      ) : (
        <>
          <PanelRightOpen className="w-4 h-4" />
          <span>{tabCount}</span>
        </>
      )}
    </button>
  )
}
