import type { AnimationEvent, ReactNode } from 'react'
import { Check, ChevronRight, Edit2, Globe, Key, Loader2, LogOut, Trash2 } from 'lucide-react'
import type { AISource } from '../../types'
import { getBuiltinProvider } from '../../types'
import { useTranslation } from '../../i18n'
import { getBrandIcon } from '../icons/BrandIcons'

interface AISourceCardProps {
  source: AISource
  chosen: boolean
  expanded: boolean
  editor?: ReactNode
  busy: boolean
  signingOut: boolean
  deleteError?: string
  highlighted?: boolean
  onHighlightEnd: (event: AnimationEvent<HTMLDivElement>) => void
  onToggle: () => void
  onChoose: () => void
  onEdit: () => void
  onDelete: () => void
  onLogout: () => void
}

export function AISourceCard({ source, chosen, expanded, editor, busy, signingOut, deleteError, highlighted, onHighlightEnd, onToggle, onChoose, onEdit, onDelete, onLogout }: AISourceCardProps) {
  const { t } = useTranslation()
  const name = source.name || getBuiltinProvider(source.provider)?.name || source.provider
  const delegated = source.authType === 'delegated'
  const credentialless = source.authType === 'oauth' || delegated
  const Brand = getBrandIcon(source.provider)

  return (
    <div
      data-ai-source-id={source.id}
      tabIndex={-1}
      onAnimationEnd={onHighlightEnd}
      className={`scroll-mt-4 rounded-lg border transition-colors ${chosen ? 'border-primary/50 bg-primary/[0.04] theme-dark:bg-primary/10' : 'border-border bg-card'} ${editor ? 'shadow-soft' : ''} ${highlighted ? 'animate-[pulse-highlight_600ms_ease-in-out_1] motion-reduce:animate-none' : ''}`}
    >
      <div data-ai-source-header className={`flex items-center gap-3 p-3 ${editor ? '' : 'cursor-pointer'}`} onClick={editor ? undefined : onToggle}>
        <button
          type="button"
          aria-pressed={chosen}
          aria-label={t('Use {{name}} for new chats', { name })}
          disabled={busy}
          onClick={event => {
            event.stopPropagation()
            if (!chosen) onChoose()
          }}
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${chosen ? 'border-primary bg-primary' : 'border-border hover:border-primary'}`}
        >
          {chosen && <Check size={12} className="text-primary-foreground" />}
        </button>
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-secondary">
          {Brand ? <Brand size={18} className="text-muted-foreground" /> : credentialless ? <Globe size={18} className="text-muted-foreground" /> : <Key size={18} className="text-muted-foreground" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className={`${editor ? 'break-words sm:truncate' : 'truncate'} font-medium text-foreground`} title={name}>{name}</div>
          <div className="truncate text-xs text-muted-foreground">{source.model || t('No model selected')}</div>
          {editor && <span className="text-xs text-muted-foreground sm:hidden">{t('Editing')}</span>}
          {credentialless && source.user?.name && <div className="truncate text-xs text-muted-foreground" title={source.user.name}>{source.user.name}</div>}
        </div>
        {editor ? <span className="hidden text-xs text-muted-foreground sm:inline">{t('Editing')}</span> : <ChevronRight size={18} aria-hidden className={`shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`} />}
      </div>
      {editor ? (
        <div className="border-t border-border p-3 sm:p-4 animate-slide-down motion-reduce:animate-none">{editor}</div>
      ) : expanded && (
        <div className="space-y-2 border-t border-border p-3">
          <div className="flex justify-between gap-3 text-sm">
            <span className="text-muted-foreground">{t('Provider')}</span>
            <span className="text-foreground">{source.provider}</span>
          </div>
          <div className="flex justify-between gap-3 text-sm">
            <span className="text-muted-foreground">{t('Auth Type')}</span>
            <span className="text-foreground">{delegated ? t('Claude Code CLI') : credentialless ? t('OAuth') : t('API Key')}</span>
          </div>
          {!credentialless && (
            <div className="flex justify-between gap-3 text-sm">
              <span className="shrink-0 text-muted-foreground">{t('API URL')}</span>
              <span className="max-w-[200px] truncate text-foreground">{source.apiUrl}</span>
            </div>
          )}
          <div className="flex flex-wrap gap-2 pt-2">
            {!delegated && (
              <button type="button" data-ai-source-edit onClick={onEdit} disabled={busy} className="flex min-h-11 items-center gap-1 rounded-md bg-secondary px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-surface-hover disabled:opacity-50 sm:min-h-0">
                <Edit2 size={14} />{t('Edit')}
              </button>
            )}
            <button
              type="button"
              onClick={credentialless ? onLogout : onDelete}
              disabled={busy || signingOut}
              className="flex min-h-11 items-center gap-1 rounded-md bg-destructive/10 px-3 py-1.5 text-sm text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-50 sm:min-h-0"
            >
              {signingOut ? <Loader2 size={14} className="animate-spin" /> : credentialless ? <LogOut size={14} /> : <Trash2 size={14} />}
              {delegated ? t('Remove') : credentialless ? t('Logout') : t('Delete')}
            </button>
          </div>
          {deleteError && <p role="alert" className="text-sm text-destructive">{deleteError}</p>}
        </div>
      )}
    </div>
  )
}
