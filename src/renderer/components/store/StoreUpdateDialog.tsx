/**
 * Store Update Dialog
 *
 * Confirmation shown before receiving an update, so an overwrite never happens
 * silently. Offers three paths: install the new version as a separate copy,
 * overwrite in place, or skip this version.
 */

import { createPortal } from 'react-dom'
import { Copy, RefreshCw, BellOff, ChevronRight, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useTranslation } from '../../i18n'

interface StoreUpdateDialogProps {
  fromVersion: string
  toVersion: string
  changelog?: string
  busy?: boolean
  onInstallCopy: () => void
  onOverwrite: () => void
  onIgnore: () => void
  onClose: () => void
}

interface UpdateOption {
  Icon: LucideIcon
  title: string
  description: string
  onClick: () => void
  recommended?: boolean
  accent: 'primary' | 'warning' | 'muted'
}

function OptionRow({ option, busy }: { option: UpdateOption; busy?: boolean }) {
  const { t } = useTranslation()
  const accent =
    option.accent === 'primary'
      ? 'border-primary/40 hover:border-primary hover:bg-primary/5'
      : option.accent === 'warning'
        ? 'border-border/60 hover:border-amber-600/50 hover:bg-amber-600/5'
        : 'border-border/60 hover:border-border/60 hover:bg-secondary/50'
  const iconColor =
    option.accent === 'primary' ? 'text-primary' : option.accent === 'warning' ? 'text-amber-600' : 'text-muted-foreground'

  return (
    <button
      onClick={option.onClick}
      disabled={busy}
      className={`w-full flex items-start gap-3 text-left p-3 rounded-lg border transition-colors disabled:opacity-60 ${accent}`}
    >
      <option.Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${iconColor}`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{option.title}</span>
          {option.recommended && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary">
              {t('Recommended')}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">{option.description}</p>
      </div>
      <ChevronRight className="w-4 h-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
    </button>
  )
}

export function StoreUpdateDialog({
  fromVersion,
  toVersion,
  changelog,
  busy,
  onInstallCopy,
  onOverwrite,
  onIgnore,
  onClose,
}: StoreUpdateDialogProps) {
  const { t } = useTranslation()

  const options: UpdateOption[] = [
    {
      Icon: Copy,
      title: t('Keep current, install as a new copy'),
      description: t('Installs the new version as a separate instance — pick a different space so the current one is left untouched.'),
      onClick: onInstallCopy,
      recommended: true,
      accent: 'primary',
    },
    {
      Icon: RefreshCw,
      title: t('Overwrite upgrade'),
      description: t('Replaces the current install in place. Local changes are lost, a running session may be interrupted, and it cannot be undone.'),
      onClick: onOverwrite,
      accent: 'warning',
    },
    {
      Icon: BellOff,
      title: t('Skip this version'),
      description: t('This version stops prompting; newer versions still notify.'),
      onClick: onIgnore,
      accent: 'muted',
    },
  ]

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onMouseDown={onClose}>
      <div
        className="relative w-full max-w-md bg-background border border-border/60 rounded-[14px] shadow-xl p-7"
        onMouseDown={e => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute top-4 right-4 flex h-7 w-7 items-center justify-center rounded-md border border-border/60 bg-background text-muted-foreground hover:text-foreground hover:border-border/60 transition-colors"
          aria-label={t('Close')}
        >
          <X className="w-3.5 h-3.5" />
        </button>
        <div className="mb-4 pr-8">
          <h2 className="text-base font-bold text-foreground">{t('Update available')}</h2>
          <p className="text-xs text-muted-foreground mt-1">
            v{fromVersion} <ChevronRight className="inline w-3 h-3" /> v{toVersion}
          </p>
        </div>

        {changelog && (
          <div className="mb-4 max-h-32 overflow-y-auto rounded-lg bg-muted/40 border border-border/60 p-3">
            <p className="text-xs text-muted-foreground whitespace-pre-line">{changelog}</p>
          </div>
        )}

        <div className="space-y-2">
          {options.map(option => (
            <OptionRow key={option.title} option={option} busy={busy} />
          ))}
        </div>

        <div className="flex mt-5">
          <button
            onClick={onClose}
            className="flex-1 px-5 py-2.5 text-[13px] text-muted-foreground border border-border/60 rounded-lg hover:text-foreground hover:border-border/60 transition-colors"
          >
            {t('Cancel')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
