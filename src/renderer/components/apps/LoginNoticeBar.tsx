/**
 * LoginNoticeBar
 *
 * Renders a dismissible amber notice bar below AutomationHeader when the
 * spec declares `browser_login` entries and the user hasn't dismissed it.
 *
 * Single site  → inline "Open [site]" + "Logged in" dismiss button
 * Multi site   → stacked site links + "Already logged in" dismiss button
 *
 * Pure presentational — all state management is handled by the parent.
 */

import { X, ExternalLink, Globe } from 'lucide-react'
import { useTranslation } from '../../i18n'
import type { BrowserLoginEntry } from '../../../shared/apps/spec-types'

interface LoginNoticeBarProps {
  browserLogin: BrowserLoginEntry[]
  onDismiss: () => void
  onOpenBrowser: (url: string, label: string) => void
}

export function LoginNoticeBar({ browserLogin, onDismiss, onOpenBrowser }: LoginNoticeBarProps) {
  const { t } = useTranslation()

  if (browserLogin.length === 0) return null

  const isSingle = browserLogin.length === 1

  if (isSingle) {
    const entry = browserLogin[0]
    return (
      <div className="flex-shrink-0 mx-4 sm:mx-10 mt-3 mb-0">
        <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg border-l-2 border-amber-500 bg-amber-500/10">
          <Globe className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0" />
          <span className="text-sm text-amber-700 dark:text-amber-400 flex-1 min-w-0 truncate">
            {t('Log in to {{site}} before running', { site: entry.label })}
          </span>
          <button
            onClick={() => onOpenBrowser(entry.url, entry.label)}
            className="flex-shrink-0 px-3 py-1 text-xs font-medium rounded-md bg-amber-500 text-white hover:bg-amber-600 transition-colors"
          >
            {t('Open to log in')}
          </button>
          <button
            onClick={onDismiss}
            className="flex-shrink-0 text-xs text-muted-foreground hover:text-foreground transition-colors whitespace-nowrap"
          >
            {t('Logged in')} ✓
          </button>
        </div>
      </div>
    )
  }

  // Multi-site layout
  return (
    <div className="flex-shrink-0 mx-4 sm:mx-10 mt-3 mb-0">
      <div className="px-3 py-2.5 rounded-lg border-l-2 border-amber-500 bg-amber-500/10">
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-2 min-w-0">
            <Globe className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0" />
            <span className="text-sm text-amber-700 dark:text-amber-400 truncate">
              {t('Log in to the following sites before running')}
            </span>
          </div>
          <button
            onClick={onDismiss}
            title={t('Dismiss')}
            className="p-0.5 text-muted-foreground hover:text-foreground rounded transition-colors flex-shrink-0"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {browserLogin.map(entry => (
            <button
              key={entry.url}
              onClick={() => onOpenBrowser(entry.url, entry.label)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md bg-amber-500 text-white hover:bg-amber-600 transition-colors"
            >
              {t('Open {{site}}', { site: entry.label })}
              <ExternalLink className="w-3 h-3" />
            </button>
          ))}
          <button
            onClick={onDismiss}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors whitespace-nowrap ml-auto"
          >
            {t('Already logged in, don\'t show again')}
          </button>
        </div>
      </div>
    </div>
  )
}
