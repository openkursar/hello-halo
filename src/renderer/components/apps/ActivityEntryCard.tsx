/**
 * ActivityEntryCard
 *
 * Renders a single activity entry in the timeline.
 * Each entry has a left-side timeline node (color-coded dot)
 * connected by the parent's timeline rail, and right-side content.
 *
 * Supports all 6 entry types: run_complete, run_skipped, run_error,
 * milestone, escalation, output.
 */

import { useState } from 'react'
import { CheckCircle2, SkipForward, XCircle, Bell, FileOutput, Clock, ChevronRight, Play, FileText, FolderOpen } from 'lucide-react'
import type { ActivityEntry } from '../../../shared/apps/app-types'
import { ActivitySource } from './ActivitySource'
import { EscalationCard } from './EscalationCard'
import { MarkdownRenderer } from '../chat/MarkdownRenderer'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { useAppsStore } from '../../stores/apps.store'
import { useDataContent } from '../../hooks/useDataContent'
import { useTranslation } from '../../i18n'
import { api } from '../../api'

interface ActivityEntryCardProps {
  entry: ActivityEntry
  appId: string
  /** Whether this is the last entry (hides the rail tail) */
  isLast?: boolean
  /** Staggered animation delay in seconds (undefined = no animation) */
  animationDelay?: number
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function formatTs(ts: number): string {
  const d = new Date(ts)
  const date = d.toLocaleDateString(undefined, { month: '2-digit', day: '2-digit' })
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return `${date}  ${time}`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  return `${Math.round(ms / 60_000)}m`
}

// ──────────────────────────────────────────────
// Timeline node color per entry type
// ──────────────────────────────────────────────

function nodeColorClass(type: ActivityEntry['type']): string {
  switch (type) {
    case 'run_complete': return 'bg-halo-success'
    case 'run_skipped':  return 'bg-muted-foreground/40'
    case 'run_error':    return 'bg-destructive'
    case 'milestone':    return 'bg-primary'
    case 'escalation':   return 'bg-halo-warning'
    case 'output':       return 'bg-primary'
    default:             return 'bg-muted-foreground/40'
  }
}

// ──────────────────────────────────────────────
// Type-specific header elements
// ──────────────────────────────────────────────

function EntryIcon({ type }: { type: ActivityEntry['type'] }) {
  switch (type) {
    case 'run_complete':
      return <CheckCircle2 className="w-3.5 h-3.5 text-halo-success" />
    case 'run_skipped':
      return <SkipForward className="w-3.5 h-3.5 text-muted-foreground" />
    case 'run_error':
      return <XCircle className="w-3.5 h-3.5 text-destructive" />
    case 'milestone':
      return <Bell className="w-3.5 h-3.5 text-primary" />
    case 'escalation':
      return <Clock className="w-3.5 h-3.5 text-halo-warning" />
    case 'output':
      return <FileOutput className="w-3.5 h-3.5 text-primary" />
    default:
      return null
  }
}

function entryLabel(type: ActivityEntry['type']): string {
  switch (type) {
    case 'run_complete': return 'Completed'
    case 'run_skipped': return 'Skipped'
    case 'run_error': return 'Failed'
    case 'milestone': return 'Milestone'
    case 'escalation': return 'Waiting for you'
    case 'output': return 'Output'
    default: return type
  }
}

/** Whether this entry type supports "View process" drill-down */
function hasSessionLink(entry: ActivityEntry): boolean {
  return (entry.type === 'run_complete' || entry.type === 'run_error') && !!entry.sessionKey
}

// ──────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────

export function ActivityEntryCard({ entry, appId, isLast, animationDelay }: ActivityEntryCardProps) {
  const { t } = useTranslation()
  const openSessionDetail = useAppsPageStore(s => s.openSessionDetail)
  const continueApp = useAppsStore(s => s.continueApp)
  const appState = useAppsStore(s => s.appStates[appId])
  const [isContinuing, setIsContinuing] = useState(false)
  const [continueError, setContinueError] = useState(false)

  const { content } = entry
  const durationMs = content.durationMs
  const canViewProcess = hasSessionLink(entry)
  const resolvedData = useDataContent(content)

  const canResume =
    entry.type === 'run_error' && content.resumeAvailable === true

  /** Disable Continue while already running/queued or a continue is in-flight */
  const isAppBusy = appState?.status === 'running' || appState?.status === 'queued'

  const handleViewProcess = () => {
    if (entry.sessionKey) {
      openSessionDetail(appId, entry.runId, entry.sessionKey)
    }
  }

  const handleContinue = async () => {
    if (isContinuing || isAppBusy) return
    setIsContinuing(true)
    setContinueError(false)
    try {
      setContinueError(!await continueApp(appId, entry.runId))
    } finally {
      setIsContinuing(false)
    }
  }

  return (
    <div
      id={`activity-${entry.id}`}
      tabIndex={-1}
      className={`relative flex gap-3 ${isLast ? 'pb-2' : 'pb-4'}${animationDelay != null ? ' activity-entry-in' : ''}`}
      style={animationDelay != null ? { animationDelay: `${animationDelay}s` } : undefined}
    >
      {/* Timeline node */}
      <div className="relative z-10 flex-shrink-0 mt-1">
        <div className="w-[19px] h-[19px] rounded-full flex items-center justify-center bg-background">
          <div className={`w-2 h-2 rounded-full ${nodeColorClass(entry.type)}`} />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <ActivitySource entry={entry} />
        {/* Meta row: timestamp + type indicator + optional "View process" link */}
        <div className="flex flex-wrap items-center gap-2 mb-1">
          <span className="font-mono text-[11px] text-muted-foreground/80 tabular-nums">{formatTs(entry.ts)}</span>
          <EntryIcon type={entry.type} />
          <span className="text-xs font-medium text-muted-foreground">{entry.type === 'escalation' && entry.content.resolution ? t(entry.content.resolution.reason === 'expired' ? 'Expired' : 'Closed') : entry.type === 'escalation' && entry.userResponse ? t('Answered') : content.stopped ? t('Execution stopped') : t(entryLabel(entry.type))}</span>
          {durationMs != null && (
            <span className="font-mono text-[11px] text-muted-foreground/60">{formatDuration(durationMs)}</span>
          )}
          {/* "View process" link — right-aligned */}
          {canViewProcess && (
            <button
              onClick={handleViewProcess}
              className="ml-auto flex items-center gap-0.5 text-xs text-primary/70 hover:text-primary transition-colors"
            >
              {t('View process')}
              <ChevronRight className="w-3 h-3" />
            </button>
          )}
        </div>

        {/* Content */}
        {entry.type === 'escalation' ? (
          <EscalationCard entry={entry} appId={appId} />
        ) : (
          <div className="space-y-1.5">
            <MarkdownRenderer content={content.summary} className="text-sm" />

            {/* Detailed data: file-sourced (dataPath) or inline */}
            {content.dataPath ? (
              <div className="rounded-md border border-border overflow-hidden">
                <button
                  onClick={() => api.showArtifactInFolder(content.dataPath!)}
                  title={content.dataPath}
                  className="w-full flex items-center gap-1.5 px-2.5 py-1.5
                    bg-secondary/60 hover:bg-secondary text-muted-foreground
                    text-[11px] font-mono transition-colors group border-b border-border"
                >
                  <FileText className="w-3 h-3 flex-shrink-0" />
                  <span className="truncate">{content.dataPath.split('/').pop()}</span>
                  <FolderOpen className="w-3 h-3 flex-shrink-0 ml-auto opacity-0 group-hover:opacity-100 transition-opacity" />
                </button>
                {resolvedData && (
                  <div className="p-3">
                    <MarkdownRenderer content={resolvedData} className="text-sm" />
                  </div>
                )}
              </div>
            ) : (
              <>
                {resolvedData && (
                  <MarkdownRenderer content={resolvedData} className="text-sm" />
                )}
                {!resolvedData && content.data != null && typeof content.data === 'object' && (
                  <pre className="text-xs bg-secondary rounded-md p-2 overflow-x-auto text-muted-foreground">
                    {JSON.stringify(content.data, null, 2)}
                  </pre>
                )}
              </>
            )}

            {/* Output download link */}
            {entry.type === 'output' && content.outputUrl && (
              <a
                href={content.outputUrl}
                download
                className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <FileOutput className="w-3 h-3" />
                {t('Download')}
              </a>
            )}

            {/* Error details for run_error */}
            {entry.type === 'run_error' && content.error && (
              <p className="text-xs text-destructive">{content.error}</p>
            )}

            {continueError && <p role="alert" className="text-xs text-destructive">{t('Could not continue this execution. Please refresh and try again.')}</p>}
            {canResume && (
              <button
                onClick={handleContinue}
                disabled={isContinuing || isAppBusy}
                className="mt-1 inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-md
                  bg-primary/10 text-primary hover:bg-primary/20 transition-colors
                  disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Play className="w-3 h-3" />
                {isContinuing ? t('Continuing…') : t('Continue')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
