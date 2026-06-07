/**
 * HistoryTab — past runs (epochs) listed newest-first; selecting one reveals
 * its tasks, findings, and per-member conversations.
 */

import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, CheckCircle2, StopCircle, Clock, AlertTriangle, FileText, File } from 'lucide-react'
import type { TeamDetail, RosterMember, EpochBoard, TeamEpochSummary, EpochEndReason } from '../../../shared/apps/team-types'
import { useTeamStore } from '../../stores/team.store'
import { useTranslation } from '../../i18n'
import { useTeamArtifacts } from './TeamArtifacts'

interface HistoryTabProps {
  detail: TeamDetail
  /** Open a member's chat for a specific run. */
  onOpenMember: (member: RosterMember, epochId: string) => void
}

export function HistoryTab({ detail, onOpenMember }: HistoryTabProps) {
  const { t } = useTranslation()
  const epochs = useTeamStore(s => s.epochs)
  const isLoading = useTeamStore(s => s.isLoadingEpochs)
  const loadEpochs = useTeamStore(s => s.loadEpochs)
  const loadEpochBoard = useTeamStore(s => s.loadEpochBoard)

  const teamId = detail.team.id
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [board, setBoard] = useState<EpochBoard | null>(null)
  const [loadingReview, setLoadingReview] = useState(false)

  useEffect(() => { void loadEpochs(teamId) }, [teamId, loadEpochs])

  useEffect(() => {
    if (!selectedId) { setBoard(null); return }
    let cancelled = false
    setLoadingReview(true)
    void loadEpochBoard(teamId, selectedId).then((b) => {
      if (cancelled) return
      setBoard(b)
      setLoadingReview(false)
    })
    return () => { cancelled = true }
  }, [selectedId, teamId, loadEpochBoard])

  if (selectedId && board) {
    return (
      <EpochReview
        board={board}
        onBack={() => setSelectedId(null)}
        onOpenMember={(m) => onOpenMember(m, selectedId)}
      />
    )
  }

  return (
    <div className="p-3 sm:p-6">
      <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('Run history')}</h3>
      {isLoading && epochs.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">{t('Loading…')}</p>
      ) : epochs.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-10 text-center text-sm text-muted-foreground/70">
          {t('No runs yet. Press Run to start the first one.')}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {epochs.map((e, i) => (
            <li key={e.id}>
              <EpochRow epoch={e} index={epochs.length - i} onClick={() => setSelectedId(e.id)} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ──────────────────────────────────────────────
// Epoch list row
// ──────────────────────────────────────────────

function endReasonMeta(reason: EpochEndReason | null, running: boolean, t: (k: string) => string) {
  if (running) return { Icon: Clock, cls: 'text-emerald-500', label: t('Running') }
  switch (reason) {
    case 'completed': return { Icon: CheckCircle2, cls: 'text-emerald-500', label: t('Completed') }
    case 'stopped': return { Icon: StopCircle, cls: 'text-muted-foreground', label: t('Stopped') }
    case 'timeout': return { Icon: Clock, cls: 'text-amber-500', label: t('Timed out') }
    case 'error': return { Icon: AlertTriangle, cls: 'text-red-500', label: t('Error') }
    default: return { Icon: Clock, cls: 'text-muted-foreground', label: t('Ended') }
  }
}

function EpochRow({ epoch, index, onClick }: { epoch: TeamEpochSummary; index: number; onClick: () => void }) {
  const { t } = useTranslation()
  const running = epoch.endedAt == null
  const { Icon, cls, label } = endReasonMeta(epoch.endReason, running, t)
  const duration = epoch.endedAt ? formatDuration(epoch.endedAt - epoch.startedAt) : null

  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-xl border border-border bg-background px-3 py-3 text-left transition-colors hover:bg-secondary/40"
    >
      <Icon className={`h-4 w-4 flex-shrink-0 ${cls}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{t('Run #{{n}}', { n: index })}</span>
          <span className={`text-xs ${cls}`}>{label}</span>
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {formatDateTime(epoch.startedAt)}
          {duration && ` · ${duration}`}
          {` · ${t('{{done}}/{{total}} tasks', { done: epoch.doneCount, total: epoch.taskCount })}`}
        </p>
        {epoch.summary && <p className="mt-0.5 truncate text-xs text-muted-foreground/70">{epoch.summary}</p>}
      </div>
    </button>
  )
}

// ──────────────────────────────────────────────
// Epoch review (read-only)
// ──────────────────────────────────────────────

interface EpochReviewProps {
  board: EpochBoard
  onBack: () => void
  onOpenMember: (member: RosterMember) => void
}

/** Extract just the filename from a path for compact display. */
function basename(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i >= 0 ? path.slice(i + 1) : path
}

function EpochReview({ board, onBack, onOpenMember }: EpochReviewProps) {
  const { t } = useTranslation()
  const { epoch, tasks, findings, members } = board

  const nameFor = useMemo(() => {
    const map = new Map(members.map(m => [m.appId, m.memberName]))
    return (appId: string | null) => (appId ? map.get(appId) ?? t('Unknown') : t('Unassigned'))
  }, [members, t])

  const roster: RosterMember[] = members.map(m => ({
    appId: m.appId, memberName: m.memberName, role: m.role, isLead: m.isLead,
    spaceId: null, status: 'idle' as const,
  }))

  const { has: hasArtifact, open: openArtifact } = useTeamArtifacts(epoch.teamId, epoch.id)

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 sm:px-4">
        <button onClick={onBack} className="flex items-center gap-1 text-sm text-primary">
          <ChevronLeft className="h-4 w-4" />
          {t('History')}
        </button>
        <span className="ml-auto text-xs text-muted-foreground">{formatDateTime(epoch.startedAt)}</span>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto p-3 sm:p-6">
        {epoch.summary && (
          <div className="rounded-xl border border-border bg-secondary/20 p-3 text-sm text-foreground">{epoch.summary}</div>
        )}

        {/* Members — open to read each one's full conversation for this run */}
        <Section title={t('Members')}>
          <div className="flex flex-wrap gap-2">
            {roster.map(m => (
              <button
                key={m.appId}
                onClick={() => onOpenMember(m)}
                className="flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm text-foreground transition-colors hover:bg-secondary/50"
              >
                {m.isLead && <span className="text-amber-500">★</span>}
                {m.memberName}
                <FileText className="h-3 w-3 text-muted-foreground" />
              </button>
            ))}
          </div>
        </Section>

        {/* Tasks (with inline resultRef when produced) */}
        <Section title={t('Tasks')}>
          {tasks.length === 0 ? (
            <p className="text-sm text-muted-foreground/70">{t('No tasks recorded.')}</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {tasks.map(tk => (
                <li key={tk.id} className="flex items-start gap-2 text-sm">
                  <span className={`mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full ${tk.status === 'done' ? 'bg-emerald-500' : tk.status === 'rejected' ? 'bg-red-500' : tk.status === 'blocked' ? 'bg-amber-500' : 'bg-muted-foreground/40'}`} />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium text-foreground">{nameFor(tk.assigneeAppId)}</span>
                    <span className="text-muted-foreground"> · {tk.title}</span>
                    {tk.status === 'done' && <span className="ml-1 text-emerald-600 dark:text-emerald-400">— {t('done')}</span>}
                    {tk.status === 'rejected' && <span className="ml-1 text-red-600 dark:text-red-400">— {t('sent back')}</span>}
                    {tk.resultRef && (
                      hasArtifact(tk.resultRef) ? (
                        <button
                          type="button"
                          onClick={() => openArtifact(tk.resultRef!)}
                          title={t('Open with the default app')}
                          className="ml-1.5 inline-flex items-center gap-1 font-mono text-xs text-primary underline-offset-2 hover:underline"
                        >
                          <File className="inline h-3 w-3" />{basename(tk.resultRef)}
                        </button>
                      ) : (
                        <span className="ml-1.5 inline-flex items-center gap-1 font-mono text-xs text-muted-foreground" title={tk.resultRef}>
                          <File className="inline h-3 w-3" />{basename(tk.resultRef)}
                        </span>
                      )
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* Findings */}
        {findings.length > 0 && (
          <Section title={t('Findings')}>
            <ul className="flex flex-col gap-1.5">
              {findings.map(f => (
                <li key={f.id} className="text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">{nameFor(f.authorAppId)}</span> · {f.body || f.ref}
                  {f.ref && (
                    hasArtifact(f.ref) ? (
                      <button
                        type="button"
                        onClick={() => openArtifact(f.ref!)}
                        title={t('Open with the default app')}
                        className="ml-1.5 inline-flex items-center gap-1 font-mono text-xs text-primary underline-offset-2 hover:underline"
                      >
                        <File className="inline h-3 w-3" />{basename(f.ref)}
                      </button>
                    ) : (
                      <span className="ml-1.5 inline-flex items-center gap-1 font-mono text-xs text-muted-foreground" title={f.ref}>
                        <File className="inline h-3 w-3" />{basename(f.ref)}
                      </span>
                    )
                  )}
                </li>
              ))}
            </ul>
          </Section>
        )}

      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </div>
  )
}

// ──────────────────────────────────────────────
// Formatting
// ──────────────────────────────────────────────

function formatDateTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch { return '' }
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}
