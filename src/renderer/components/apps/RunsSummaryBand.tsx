/**
 * RunsSummaryBand
 *
 * One compact band answering "can I trust this digital human": the success
 * rate across its most recent runs, those runs as a dot strip, and the newest
 * one as a link into its execution trace.
 *
 * It is a summary, not a second feed — the full history lives in the activity
 * thread it sits above, and listing runs here would duplicate it.
 */

import { useEffect, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { useAppsStore } from '../../stores/apps.store'
import { runStatusDotClass } from '../../utils/automation-status'
import type { AutomationRunWithSummary } from '../../../shared/apps/app-types'

/** Runs fetched for the glance; the paginated history is the activity thread's job. */
const SAMPLE_SIZE = 7

function formatRunTimestamp(ts: number): string {
  const date = new Date(ts)
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (new Date().toDateString() === date.toDateString()) return time
  return `${date.toLocaleDateString(undefined, { month: '2-digit', day: '2-digit' })} ${time}`
}

export function RunsSummaryBand({ appId }: { appId: string }) {
  const { t } = useTranslation()
  const openSessionDetail = useAppsPageStore(state => state.openSessionDetail)
  const [runs, setRuns] = useState<AutomationRunWithSummary[]>([])
  // Refetched when the newest run's start time moves, so a run that finishes
  // while this tab is open is reflected without remounting the thread.
  const lastRunAtMs = useAppsStore(state => state.appStates[appId]?.lastRunAtMs)

  useEffect(() => {
    let cancelled = false
    api.appGetRuns(appId, { limit: SAMPLE_SIZE }).then(res => {
      if (!cancelled && res.success && Array.isArray(res.data)) {
        setRuns(res.data as AutomationRunWithSummary[])
      }
    })
    return () => { cancelled = true }
  }, [appId, lastRunAtMs])

  if (runs.length === 0) return null

  const succeeded = runs.filter(run => run.status === 'ok').length
  const latest = runs[0]

  return (
    <section
      aria-label={t('Reliability')}
      className="mb-6 rounded-xl border border-border bg-secondary/20 px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-[15px] font-semibold tabular-nums text-foreground">
          {Math.round((succeeded / runs.length) * 100)}%
        </span>
        <span className="text-xs text-muted-foreground">
          {t('succeeded in the last {{count}} runs', { count: runs.length })}
        </span>
        {runs.length > 1 && (
          <span className="flex items-center gap-1.5">
            {[...runs].reverse().map(run => (
              <span
                key={run.runId}
                className={`w-2 h-2 rounded-full flex-shrink-0 ${runStatusDotClass(run.status)}`}
                title={formatRunTimestamp(run.startedAt)}
              />
            ))}
          </span>
        )}
        {latest && (
          /* flex-1 + min-w-0 must hold at every width: without them the button
             sizes to its content and the summary's `truncate` never engages,
             pushing the band past the viewport on long run summaries. */
          <button
            onClick={() => latest.sessionKey && openSessionDetail(appId, latest.runId, latest.sessionKey)}
            disabled={!latest.sessionKey}
            title={latest.status === 'error' ? (latest.errorMessage ?? latest.summary ?? '') : (latest.summary ?? '')}
            className="flex min-w-0 flex-1 basis-full sm:basis-auto items-center gap-2 text-left disabled:cursor-default"
          >
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${runStatusDotClass(latest.status)}`} />
            <span className="text-[11px] text-subtle-foreground flex-shrink-0">{t('Latest')}</span>
            <span className="text-xs text-muted-foreground truncate min-w-0 flex-1">
              {latest.status === 'error' ? (latest.errorMessage ?? latest.summary ?? '') : (latest.summary ?? '')}
            </span>
            <span className="text-[11px] text-muted-foreground font-mono tabular-nums flex-shrink-0">
              {formatRunTimestamp(latest.startedAt)}
            </span>
            {latest.sessionKey && <ChevronRight className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />}
          </button>
        )}
      </div>
    </section>
  )
}
