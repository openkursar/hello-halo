import type { ReactNode } from 'react'
import { ArrowLeft, X } from 'lucide-react'
import { useTranslation } from '../../../i18n'

const ICON_BUTTON = 'shrink-0 rounded-full p-1.5 text-subtle-foreground transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'

export function PanelClose({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  return <button onClick={onClose} aria-label={t('Close details')} title={t('Close details')} className={ICON_BUTTON}><X size={16} /></button>
}

/** The top of a side panel: a way back to what opened it, a way out, and the panel's own action. */
export function PanelBar({ docked, backTo, onBack, onClose, children }: {
  docked: boolean
  /** What the back arrow returns to, when this panel was opened from another one. */
  backTo?: string
  onBack: () => void
  onClose: () => void
  children?: ReactNode
}) {
  const { t } = useTranslation()
  const back = backTo ?? (docked ? null : t('Back'))
  return <div className="flex min-h-12 shrink-0 items-center gap-1 px-3">
    {back !== null && <button onClick={backTo ? onBack : onClose} className="inline-flex h-8 min-w-0 items-center gap-1.5 rounded-full px-2 text-[13px] text-subtle-foreground transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
      <ArrowLeft size={15} className="shrink-0" aria-hidden="true" /><span className="truncate">{back}</span>
    </button>}
    <div className="ml-auto flex min-w-0 items-center justify-end gap-1">
      {children}
      {docked && <PanelClose onClose={onClose} />}
    </div>
  </div>
}
