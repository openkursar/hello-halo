/**
 * "New changes in N files · Refresh": files changed while the user was
 * reading. The view never redraws on its own — only Refresh does — so the
 * place being read does not jump.
 */

import { RefreshCw, X } from 'lucide-react'
import { useTranslation } from '../../../../../i18n'
import { IconButton } from '../shared/parts'

export function NewChangesBar({ count, onRefresh, onDismiss }: { count: number; onRefresh: () => void; onDismiss: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center px-3">
      <div
        role="status"
        className="pointer-events-auto flex max-w-full items-center gap-2 rounded-lg border border-primary/50 bg-popover py-1 pl-3 pr-1 text-[12.5px] text-foreground shadow-pop animate-pop-in"
      >
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
        <span className="min-w-0 truncate">{t('New changes in {{count}} files', { count })}</span>
        <button
          type="button"
          onClick={onRefresh}
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md bg-primary px-2 text-[12px] font-medium text-primary-foreground hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <RefreshCw size={12} aria-hidden />
          {t('Refresh')}
        </button>
        <IconButton size="sm" label={t('Dismiss')} onClick={onDismiss}>
          <X size={12} />
        </IconButton>
      </div>
    </div>
  )
}
