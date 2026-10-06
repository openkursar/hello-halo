/**
 * Store Update Dialog
 *
 * Confirmation shown before receiving an update. Offers three paths: update in
 * place, install the new version as a separate copy, or skip this version. A
 * digital human updated in place keeps every field that differs from the
 * author's new version, and the dialog names those fields before it happens;
 * other app types are replaced by the new version.
 */

import { createPortal } from 'react-dom'
import { Copy, RefreshCw, BellOff, ChevronRight, Loader2, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { specFieldList } from '../apps/spec-field-label'

/** What updating in place would keep at the user's version. */
export type UpgradePreview =
  | { status: 'loading' }
  | { status: 'ready'; kept: string[]; editsKnown: boolean }
  | { status: 'unavailable' }

interface StoreUpdateDialogProps {
  fromVersion: string
  toVersion: string
  changelog?: string
  busy?: boolean
  /** Set for a digital human, whose in-place update keeps what differs from the author's version. */
  preview?: UpgradePreview
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
  accent: 'primary' | 'muted'
}

function OptionRow({ option, busy }: { option: UpdateOption; busy?: boolean }) {
  const { t } = useTranslation()
  const accent =
    option.accent === 'primary'
      ? 'border-primary/40 hover:border-primary hover:bg-primary/5'
      : 'border-border/60 hover:border-border/60 hover:bg-secondary/50'
  const iconColor = option.accent === 'primary' ? 'text-primary' : 'text-muted-foreground'

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
  preview,
  onInstallCopy,
  onOverwrite,
  onIgnore,
  onClose,
}: StoreUpdateDialogProps) {
  const { t, i18n } = useTranslation()

  const options: UpdateOption[] = [
    {
      Icon: RefreshCw,
      title: preview ? t('Update in place') : t('Overwrite upgrade'),
      description: preview
        ? t('Keeps your settings and data. Items that differ from the author’s new version keep your current version.')
        : t('Upgrades in place and keeps your settings and data. Local edits to the app content are replaced.'),
      onClick: onOverwrite,
      recommended: true,
      accent: 'primary',
    },
    {
      Icon: Copy,
      title: t('Keep current, install as a new copy'),
      description: t('Installs the new version as a separate instance — pick a different workspace so the current one is left untouched.'),
      onClick: onInstallCopy,
      accent: 'muted',
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
        className="relative w-full max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto bg-background border border-border/60 rounded-[14px] shadow-xl p-7"
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

        {preview?.status === 'loading' && (
          <p role="status" className="mb-4 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="w-3 h-3 animate-spin" />
            {t('Checking which items keep your current version…')}
          </p>
        )}
        {preview?.status === 'ready' && preview.kept.length > 0 && (
          <div className="mb-4 space-y-1 rounded-lg border border-border/60 p-3 text-xs text-muted-foreground">
            <p className="text-foreground">
              {t('These differ from the author’s new version and will keep your current version: {{items}}', {
                items: specFieldList(preview.kept, t, i18n.language),
              })}
            </p>
            {!preview.editsKnown && <p>{t('Halo cannot tell which of them you changed.')}</p>}
            <p>{t('You can switch any of them to the author’s version later in Work activity.')}</p>
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
