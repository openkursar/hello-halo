import { useMemo, useState } from 'react'
import { AlertCircle, ArrowRight, CheckCircle2, ChevronDown, FileText, Loader2, MessageSquare, RefreshCw } from 'lucide-react'
import { AutomationAvatar } from '../../apps/AutomationAvatar'
import type { TeamConversation, TeamDetail } from '../../../../shared/apps/team-types'
import { useTranslation } from '../../../i18n'
import { useTeamArtifacts } from '../TeamArtifacts'
import { WorkbenchDrawer } from './WorkbenchDrawer'
import { useTaskReports } from './useTaskReports'
import type { TaskBoardState } from './useTaskBoard'
import { TaskExecutionView } from './TaskExecutionView'
import { TaskActivityTimeline } from './TaskActivityTimeline'

export function TeamActivityDrawer({ detail, task, onClose, onDecision, boardState, activityTarget, executionTarget }: {
  detail: TeamDetail; task: TeamConversation; onClose: () => void; onDecision: (id: string) => void; boardState: TaskBoardState; activityTarget?: string; executionTarget?: string
}) {
  const { t } = useTranslation()
  const { board, failed } = boardState
  const [executionMember, setExecutionMember] = useState<string | null>(executionTarget ?? null)
  const [reload, setReload] = useState(0)
  const reports = useTaskReports(detail.team.id, task.epochId, executionMember ? [] : detail.roster, reload)
  const tasks = useMemo(() => board?.tasks ?? detail.tasks.filter(row => row.epochId === task.epochId), [board?.tasks, detail.tasks, task.epochId])
  const findings = useMemo(() => board?.findings ?? detail.findings.filter(row => row.epochId === task.epochId), [board?.findings, detail.findings, task.epochId])
  const activities = useMemo(() => {
    const byId = new Map(tasks.map(row => [row.id, row]))
    const labels = { done: t('Completed'), error: t('Failed'), pending: t('Pending'), in_progress: t('Working'), rejected: t('Rejected'), blocked: t('Blocked'), sent: t('Sent'), undelivered: t('Not delivered'), ok: t('Completed'), timeout: t('Timed out'), escalation: t('Needs my decision') }
    return boardState.activities.map(activity => {
      if (activity.subject.trim() || activity.body?.trim()) return activity
      const item = activity.refId ? byId.get(activity.refId) : undefined
      const status = activity.status ? labels[activity.status] : undefined
      return { ...activity, subject: [item?.title, status].filter(Boolean).join(' · ') }
    }).filter(activity => activity.subject.trim() || activity.body?.trim())
  }, [boardState.activities, tasks, t])
  const unfinished = tasks.filter(row => row.status !== 'done' && row.status !== 'rejected')
  const pending = (detail.pendingEscalations ?? []).filter(row => row.epochId === task.epochId)
  const artifacts = useTeamArtifacts(detail.team.id, task.epochId, `${activities.length}:${reload}`)
  const busy = detail.roster.filter(member => member.busy?.some(row => row.epochId === task.epochId))
  const statusLabels = { pending: t('Pending'), in_progress: t('Working'), blocked: t('Blocked'), done: t('Completed'), rejected: t('Rejected') }
  const retry = () => { setReload(value => value + 1); boardState.retry() }
  const inspected = detail.roster.find(member => member.appId === executionMember)
  if (inspected) return <WorkbenchDrawer title={t('Task execution')} onClose={onClose}>
    <div className="space-y-4 p-3 sm:p-5"><button onClick={() => setExecutionMember(null)} className="min-h-9 rounded px-2 text-xs text-primary hover:bg-secondary">← {t('Back to task activity')}</button>
      <div><h2 className="text-base font-semibold">{inspected.memberName}</h2><p className="mt-1 text-xs text-muted-foreground">{task.label}</p></div>
      <TaskExecutionView key={inspected.appId} teamId={detail.team.id} epochId={task.epochId} appId={inspected.appId} spaceId={inspected.spaceId ?? ''} remote={inspected.sameMachine === false} />
    </div>
  </WorkbenchDrawer>
  return <WorkbenchDrawer title={t('Task activity')} onClose={onClose}>
    <div className="space-y-5 p-3 sm:p-5">
      <div className="rounded-xl border border-border bg-secondary/30 p-4">
        <h2 className="break-words text-base font-semibold leading-6">{task.label}</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('Collaboration, progress and outputs for this task.')}</p>
        {busy.length > 0 && <div className="mt-3 flex items-start gap-2 text-xs text-halo-success"><Loader2 size={13} className="mt-0.5 shrink-0 animate-spin" /><span className="min-w-0 break-words">{t('Working')} · {busy.map(member => member.memberName).join(', ')}</span></div>}
      </div>
      {failed && <div role="alert" className="flex items-start gap-2 rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive"><AlertCircle size={15} className="shrink-0" /><span className="flex-1">{t('Could not load task history.')}</span><button onClick={retry} className="inline-flex shrink-0 items-center gap-1 rounded hover:underline"><RefreshCw size={12} />{t('Retry')}</button></div>}
      {!board && !failed && <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 size={14} className="animate-spin" />{t('Loading task…')}</p>}
      {pending.length > 0 && <section aria-label={t('Needs my decision')}>
        <h3 className="mb-2 flex items-center gap-2 text-xs font-medium text-halo-warning"><AlertCircle size={14} />{t('Needs my decision')}<span className="rounded-full bg-halo-warning/10 px-1.5 py-0.5 tabular-nums">{pending.length}</span></h3>
        <div className="space-y-2">{pending.map(decision => <button key={decision.entryId} onClick={() => onDecision(decision.entryId)} className="group block w-full rounded-xl border border-halo-warning/30 bg-halo-warning/5 p-3 text-left transition-colors hover:bg-halo-warning/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
          <span className="flex items-center gap-2"><AutomationAvatar name={decision.memberName} size={24} /><span className="text-xs font-medium">{decision.memberName}</span></span><p className="mt-2 break-words text-sm leading-6">{decision.question}</p><span className="mt-3 flex items-center gap-1.5 text-xs font-medium text-primary">{t('Go to conversation to answer')}<ArrowRight size={13} className="transition-transform group-hover:translate-x-0.5" /></span>
        </button>)}</div>
      </section>}
      <details open className="group/progress overflow-hidden rounded-xl border border-border">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 py-3 text-xs font-medium hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"><CheckCircle2 size={14} className="text-muted-foreground" />{t('Progress')}<span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground">{unfinished.length}</span><ChevronDown size={14} className="ml-auto text-muted-foreground transition-transform group-open/progress:rotate-180" /></summary>
        <div className="max-h-80 space-y-2 overflow-y-auto border-t border-border bg-secondary/20 p-3">
          {unfinished.map(row => {
            const memberName = detail.roster.find(member => member.appId === row.assigneeAppId)?.memberName
            return <div key={row.id} className="rounded-lg border border-border bg-background p-3">
              <div className="flex items-start gap-2"><p className="min-w-0 flex-1 break-words text-sm leading-5">{row.title}</p><span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] ${row.status === 'blocked' ? 'bg-halo-warning/10 text-halo-warning' : row.status === 'in_progress' ? 'bg-halo-success/10 text-halo-success' : 'bg-secondary text-muted-foreground'}`}>{statusLabels[row.status]}</span></div>
              {memberName && <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground"><AutomationAvatar name={memberName} size={18} /><span className="truncate">{memberName}</span></div>}
              {row.note && <details className="mt-2 text-xs text-muted-foreground"><summary className="cursor-pointer truncate">{row.note}</summary><p className="mt-2 whitespace-pre-wrap break-words leading-5">{row.note}</p></details>}
            </div>
          })}
          {board && !unfinished.length && <p className="py-1 text-xs leading-5 text-muted-foreground">{t('No unfinished items recorded.')}</p>}
        </div>
      </details>
      <details className="group/outputs overflow-hidden rounded-xl border border-border">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 py-3 text-xs font-medium hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"><FileText size={14} className="text-muted-foreground" />{t('Outputs')}<span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground">{artifacts.list.length}</span>{artifacts.status === 'loading' && <Loader2 size={12} className="animate-spin text-muted-foreground" />}{artifacts.status === 'failed' && <AlertCircle size={13} className="text-destructive" aria-label={t('Could not load outputs.')} />}<ChevronDown size={14} className="ml-auto text-muted-foreground transition-transform group-open/outputs:rotate-180" /></summary>
        <div className="max-h-80 space-y-2 overflow-y-auto border-t border-border bg-secondary/20 p-3">{artifacts.list.map(file => <button key={file.path} onClick={() => artifacts.openPath(file.path)} className="group/file flex min-h-12 w-full items-center gap-3 rounded-lg border border-border bg-background p-3 text-left transition-colors hover:border-primary/40 hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><span className="rounded-lg bg-primary/5 p-2 text-primary"><FileText size={16} /></span><span className="min-w-0 flex-1"><span className="block break-all text-xs font-medium leading-5">{file.name}</span>{file.memberName && <span className="mt-0.5 block text-[11px] text-muted-foreground">{file.memberName}</span>}</span><ArrowRight size={14} className="shrink-0 text-muted-foreground transition-colors group-hover/file:text-primary" /></button>)}
          {artifacts.status === 'loading' && <p className="text-xs text-muted-foreground">{t('Loading outputs…')}</p>}
          {artifacts.status === 'failed' && <p role="alert" className="text-xs text-destructive">{t('Could not load outputs.')} <button className="underline" onClick={retry}>{t('Retry')}</button></p>}
          {artifacts.status === 'ready' && !artifacts.list.length && <p className="py-1 text-xs text-muted-foreground">{t('No outputs recorded yet')}</p>}
        </div>
      </details>
      <section><h3 className="mb-2 text-xs font-medium">{t('Member executions')}</h3><div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{detail.roster.map(member => <button key={member.appId} onClick={() => setExecutionMember(member.appId)} className="flex min-h-11 items-center gap-2 rounded-lg border border-border p-2 text-left text-xs hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><AutomationAvatar name={member.memberName} size={22} /><span className="min-w-0 flex-1 truncate">{member.memberName}</span>{member.busy?.some(row => row.epochId === task.epochId) && <span className="h-2 w-2 rounded-full bg-halo-success" />}<ArrowRight size={13} /></button>)}</div></section>
      <section><h3 className="mb-3 flex items-center gap-2 text-xs font-medium"><MessageSquare size={14} className="text-muted-foreground" />{t('Collaboration history')}</h3>
        {reports.loading && !reports.reports.length && <p role="status" className="mb-3 flex items-center gap-2 text-xs text-muted-foreground"><Loader2 size={13} className="animate-spin" />{t('Loading task…')}</p>}
        {reports.failed && <p role="alert" className="mb-3 rounded-lg bg-halo-warning/10 p-3 text-xs text-halo-warning">{t('Some member reports could not be refreshed.')} <button className="underline" onClick={retry}>{t('Retry')}</button></p>}
        {board && !reports.loading && !reports.failed && !activities.length && !reports.reports.length && <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center"><MessageSquare size={22} className="mx-auto mb-2 text-muted-foreground/50" /><p className="text-xs text-muted-foreground">{t('No activity yet')}</p></div>}
        <TaskActivityTimeline focusActivityId={activityTarget} messages={reports.reports} activities={activities} detail={detail} showEmpty={false} canOpenArtifact={ref => { const finding = findings.find(row => row.id === ref); return !!finding?.ref && artifacts.has(finding.ref) }} openArtifact={ref => { const finding = findings.find(row => row.id === ref); if (finding?.ref) artifacts.open(finding.ref) }} />
      </section>
    </div>
  </WorkbenchDrawer>
}
