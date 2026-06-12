/**
 * IngestProgress — animated "Learning" progress bar.
 *
 * Driven purely by the live tlon:ingest-progress event (animation only).
 * Counts/learned status are authoritative elsewhere (RawFilesTab pulls them).
 */

import { useTranslation } from '../../i18n'
import { Loader2, CheckCircle2, AlertCircle } from 'lucide-react'
import type { IngestProgressEvent } from '../../../shared/types/tlon'

interface IngestProgressProps {
  progress?: IngestProgressEvent
}

export function IngestProgress({ progress }: IngestProgressProps) {
  const { t } = useTranslation()

  if (!progress || progress.phase === 'idle') return null

  const { phase, total, completed, current, error } = progress
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0

  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3 sm:p-4">
      <div className="flex items-center gap-2 mb-2">
        {phase === 'running' && <Loader2 className="w-4 h-4 text-primary animate-spin flex-shrink-0" />}
        {phase === 'done' && <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />}
        {phase === 'error' && <AlertCircle className="w-4 h-4 text-destructive flex-shrink-0" />}
        <span className="text-sm font-medium truncate">
          {phase === 'running' && t('Learning…')}
          {phase === 'done' && t('Done learning')}
          {phase === 'error' && t('Learning failed')}
        </span>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums flex-shrink-0">
          {completed}/{total}
        </span>
      </div>

      {phase !== 'error' && (
        <div className="h-1.5 w-full rounded-full bg-secondary overflow-hidden">
          <div
            className="h-full rounded-full bg-primary transition-all duration-300"
            style={{ width: `${phase === 'done' ? 100 : pct}%` }}
          />
        </div>
      )}

      {phase === 'running' && current && (
        <p className="mt-2 text-xs text-muted-foreground truncate">{current}</p>
      )}
      {phase === 'error' && error && (
        <p className="mt-2 text-xs text-destructive break-words">{error}</p>
      )}
    </div>
  )
}
