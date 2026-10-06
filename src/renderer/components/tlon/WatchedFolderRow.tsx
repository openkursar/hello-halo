/**
 * One watched folder in the knowledge base settings. A folder that is not being
 * learned says why: unavailable (with a Retry), or over the watched-folder limits.
 */

import { useTranslation } from '../../i18n'
import { FolderOpen, RefreshCw, X } from 'lucide-react'
import type { LinkedDirectory } from '../../../shared/types/tlon'

interface WatchedFolderRowProps {
  dir: LinkedDirectory
  retrying: boolean
  onRetry: () => void
  onRemove: () => void
}

export function WatchedFolderRow({ dir, retrying, onRetry, onRemove }: WatchedFolderRowProps) {
  const { t } = useTranslation()
  const pause = dir.watching ? dir.learningPaused : undefined

  return (
    <div className="group flex items-center gap-2.5 px-3 py-2.5 rounded-lg border border-border/60 bg-background">
      <FolderOpen className="w-4 h-4 text-muted-foreground flex-shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm truncate">{dir.label}</p>
        <p className="text-xs text-muted-foreground truncate">{dir.path}</p>
        {pause && (
          <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">
            {pause.reason === 'too-many-files'
              ? t('{{count}} files, over the {{limit}}-file limit: learning paused. It resumes once the folder is back under the limit.', { count: pause.count, limit: pause.limit })
              : t('Too many files and subfolders to scan: learning paused. Watch a smaller folder instead.')}
          </p>
        )}
      </div>
      {!dir.watching && (
        <>
          <span className="text-xs text-destructive flex-shrink-0">{t('Unavailable')}</span>
          <button
            onClick={onRetry}
            disabled={retrying}
            className="flex-shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
            title={t('Look for the folder again and resume learning it if it is back')}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${retrying ? 'animate-spin' : ''}`} />
            {t('Retry')}
          </button>
        </>
      )}
      <button
        onClick={onRemove}
        className="p-1.5 rounded-md opacity-0 group-hover:opacity-100 hover:bg-destructive/10 transition-all flex-shrink-0"
        title={t('Remove')}
      >
        <X className="w-3.5 h-3.5 text-destructive" />
      </button>
    </div>
  )
}
