/**
 * OAuthRedirectLogin — the body of a redirect-flow sign-in: open the login
 * window (desktop only), or copy the link and paste the authorization code.
 * The surrounding layout belongs to the screen that hosts it.
 */

import { Check, Copy, ExternalLink, Globe, Loader2 } from 'lucide-react'
import { api } from '../../api'
import { useTranslation } from '../../i18n'
import type { RedirectLoginView } from '../../hooks/useOAuthLogin'

interface OAuthRedirectLoginProps {
  title: string
  redirect: RedirectLoginView
  onOpenWindow: () => void
  onSubmitCode: () => void
  onCodeChange: (code: string) => void
  onCopyLink: () => void
  onCancel: () => void
}

export function OAuthRedirectLogin({
  title,
  redirect,
  onOpenWindow,
  onSubmitCode,
  onCodeChange,
  onCopyLink,
  onCancel
}: OAuthRedirectLoginProps) {
  const { t } = useTranslation()
  const remote = api.isRemoteMode()
  const busy = redirect.windowOpen || redirect.submitting
  const canSubmit = !!redirect.manualCode.trim() && !busy

  return (
    <div className="w-full min-w-0 space-y-5">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 shrink-0 rounded-lg flex items-center justify-center bg-primary/15 text-primary">
          <Globe size={20} />
        </div>
        <div className="min-w-0">
          <h3 className="font-medium text-foreground truncate">{title}</h3>
          <p className="text-xs text-muted-foreground">{remote ? t('Manual login') : t('Choose a login method')}</p>
        </div>
      </div>

      {redirect.error && (
        <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg">
          <p role="alert" className="text-sm text-destructive break-words">{redirect.error}</p>
        </div>
      )}

      {!remote && (
        <>
          <button
            type="button"
            onClick={onOpenWindow}
            disabled={busy}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-primary hover:bg-primary/90
                     disabled:opacity-50 text-primary-foreground rounded-lg transition-colors text-sm font-medium"
          >
            {redirect.windowOpen
              ? <><Loader2 size={16} className="animate-spin" />{t('Logging in...')}</>
              : <><ExternalLink size={16} />{t('Open Login Window')}</>}
          </button>
          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-border" />
            <span className="text-xs text-muted-foreground">{t('or')}</span>
            <div className="flex-1 h-px bg-border" />
          </div>
        </>
      )}

      <div className="p-4 bg-card border border-border rounded-xl space-y-3">
        <h4 className="text-sm font-medium text-foreground">{t('Manual login')}</h4>
        <p className="text-xs text-muted-foreground">
          {t('Open or copy the link, sign in, then paste the authorization code below.')}
        </p>

        <div className="flex items-center gap-2">
          <a
            href={redirect.loginUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 min-w-0 p-2.5 bg-muted/50 rounded-md border border-border font-mono text-xs
                     text-muted-foreground break-all select-all overflow-hidden max-h-16 overflow-y-auto"
          >
            {redirect.loginUrl}
          </a>
          <button
            type="button"
            onClick={onCopyLink}
            className="shrink-0 flex items-center gap-1 px-3 py-2.5 text-sm bg-muted/50 hover:bg-muted
                     border border-border rounded-md transition-colors"
            title={t('Copy link')}
          >
            <Copy size={14} className={redirect.copied ? 'text-green-500' : 'text-muted-foreground'} />
            <span className={`text-xs ${redirect.copied ? 'text-green-500' : 'text-muted-foreground'}`}>
              {redirect.copied ? t('Copied') : t('Copy')}
            </span>
          </button>
        </div>

        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{t('Paste the authorization code from the login page')}</p>
          <input
            type="text"
            value={redirect.manualCode}
            onChange={event => onCodeChange(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && canSubmit) onSubmitCode()
            }}
            placeholder={t('Paste authorization code here')}
            disabled={redirect.submitting}
            className="w-full px-3 py-2.5 bg-background border border-border rounded-md text-sm text-foreground
                     placeholder:text-muted-foreground focus:outline-none focus:border-primary
                     focus:ring-1 focus:ring-primary/30 font-mono"
          />
        </div>

        <button
          type="button"
          onClick={onSubmitCode}
          disabled={!canSubmit}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-primary hover:bg-primary/90
                   disabled:opacity-50 text-primary-foreground rounded-lg transition-colors text-sm font-medium"
        >
          {redirect.submitting
            ? <><Loader2 size={16} className="animate-spin" />{t('Verifying...')}</>
            : <><Check size={16} />{t('Complete Login')}</>}
        </button>
      </div>

      <button
        type="button"
        onClick={onCancel}
        className="w-full px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        {t('Cancel')}
      </button>
    </div>
  )
}
