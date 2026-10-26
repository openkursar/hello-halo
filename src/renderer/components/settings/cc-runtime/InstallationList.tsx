import { AlertCircle, Check, CheckCircle2, ChevronRight, Loader2, RefreshCw } from 'lucide-react'
import type { CcInstallation } from '../../../../shared/types/cc-runtime'
import { useTranslation } from '../../../i18n'
import { useCcRuntimeMessages } from './messages'
import { RuntimeButton } from './ui'

interface CcInstallationListProps {
  installations: CcInstallation[]
  selectedPath?: string
  busyPath?: string
  disabled?: boolean
  onSelect: (item: CcInstallation) => void
  onCheck: (item: CcInstallation) => void
  label?: string
}

export function CcInstallationList({ installations, selectedPath, busyPath, disabled, onSelect, onCheck, label }: CcInstallationListProps) {
  const { t } = useTranslation()
  const messages = useCcRuntimeMessages()

  if (installations.length === 0) return null

  return (
    <ul role="list" aria-label={label ?? t('Installed Claude Code versions')} className="space-y-2">
      {installations.map(item => {
        const selected = item.path === selectedPath
        const busy = item.path === busyPath
        const usable = item.compatibility === 'verified' || item.compatibility === 'compatible'
        const selectable = usable || item.compatibility === 'unchecked'
        const blocked = disabled || Boolean(busyPath)
        const title = item.version ? t('Claude Code {{version}}', { version: item.version }) : t('Claude Code')

        return (
          <li key={item.path} className="min-w-0">
            <article aria-label={title} aria-busy={busy} className={`min-w-0 rounded-lg border p-3 ${selected ? 'border-primary/40 bg-primary/5' : 'border-border bg-background'}`}>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium">{title}</p>
                    {selected && <span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">{t('Selected')}</span>}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>{item.managed ? t('Installed by Halo') : t('Local installation')}</span>
                    <span className={`inline-flex items-center gap-1 ${usable ? 'text-halo-success' : item.compatibility === 'unchecked' ? '' : 'text-halo-warning'}`}>
                      {usable ? <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                        : item.compatibility !== 'unchecked' && <AlertCircle aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />}
                      {messages.compatibility(item.compatibility)}
                    </span>
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {selectable ? (
                    <RuntimeButton disabled={blocked || selected} onClick={() => onSelect(item)}>
                      {busy ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
                        : selected && <Check aria-hidden="true" className="h-4 w-4" />}
                      {busy ? t('Checking…') : selected ? t('Selected') : t('Use this version')}
                    </RuntimeButton>
                  ) : (
                    <RuntimeButton disabled={blocked} onClick={() => onCheck(item)}>
                      {busy ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : <RefreshCw aria-hidden="true" className="h-4 w-4" />}
                      {busy ? t('Checking…') : t('Check again')}
                    </RuntimeButton>
                  )}
                </div>
              </div>
              {item.issue && <p className="mt-2 text-xs text-halo-warning">{messages.issue(item.issue)}</p>}
              <details className="group/installation mt-2 text-xs text-muted-foreground">
                <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 [&::-webkit-details-marker]:hidden">
                  <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 transition-transform group-open/installation:rotate-90" />
                  {t('Details')}
                </summary>
                <div className="mt-2 space-y-2">
                  <p className="break-all select-text">{item.path}</p>
                  {item.compatibility === 'compatible' && <p>{t('The required interfaces responded. This version has not completed Halo’s full compatibility tests; you can try it.')}</p>}
                  {item.compatibility === 'unchecked' && <p>{t('Halo will check this installation before using it.')}</p>}
                  {selectable && (
                    <RuntimeButton disabled={blocked} onClick={() => onCheck(item)}>
                      <RefreshCw aria-hidden="true" className="h-4 w-4" />
                      {t('Check again')}
                    </RuntimeButton>
                  )}
                </div>
              </details>
            </article>
          </li>
        )
      })}
    </ul>
  )
}
