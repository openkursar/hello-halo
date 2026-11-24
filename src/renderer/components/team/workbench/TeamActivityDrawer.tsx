import { useState } from 'react'
import { AlertCircle, CheckCircle2, ChevronDown, FileText, Loader2, MessageSquare, RefreshCw } from 'lucide-react'
import { AutomationAvatar } from '../../apps/AutomationAvatar'
import type { TeamConversation, TeamDetail } from '../../../../shared/apps/team-types'
import { parseSpaceCoordinatorAppId } from '../../../../shared/apps/team-types'
import { useTranslation } from '../../../i18n'
import { WorkbenchDrawer } from './WorkbenchDrawer'
import type { TaskBoardState } from './useTaskBoard'
import { useTaskActivity } from './useTaskActivity'
import { TaskCollaborationHistory, TaskDecisionRequests, TaskMemberExecution, TaskMemberExecutions, TaskOutputList } from './TaskActivitySections'

export function TeamActivityDrawer({ detail, task, onClose, onDecision, boardState, activityTarget, executionTarget }: {
  detail: TeamDetail; task: TeamConversation; onClose: () => void; onDecision: (id: string) => void; boardState: TaskBoardState; activityTarget?: string; executionTarget?: string
}) {
  const { t } = useTranslation()
  const [executionMember, setExecutionMember] = useState<string | null>(executionTarget ?? null)
  const data = useTaskActivity(detail, task, boardState, !executionMember)
  const { tasks, pending, artifacts, busy } = data
  const unfinished = tasks.filter(row => row.status !== 'done' && row.status !== 'rejected')
  const statusLabels = { pending: t('Pending'), in_progress: t('Working'), blocked: t('Blocked'), done: t('Completed'), rejected: t('Rejected') }
  const inspected = detail.roster.find(member => member.appId === executionMember)
  if (inspected) return <WorkbenchDrawer title={t('Task execution')} onClose={onClose}>
    <div className="space-y-4 p-3 sm:p-5"><button onClick={() => setExecutionMember(null)} className="min-h-9 rounded px-2 text-xs text-primary hover:bg-secondary">← {t('Back to task activity')}</button>
      <TaskMemberExecution detail={detail} task={task} member={inspected} homepageConversation={false} />
    </div>
  </WorkbenchDrawer>
  return <WorkbenchDrawer title={t('Task activity')} onClose={onClose}>
    <div className="space-y-5 p-3 sm:p-5">
      <div className="rounded-xl border border-border bg-secondary/30 p-4">
        <h2 className="break-words text-base font-semibold leading-6">{task.label}</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('Collaboration, progress and outputs for this task.')}</p>
        {busy.length > 0 && <div className="mt-3 flex items-start gap-2 text-xs text-primary"><Loader2 size={13} className="mt-0.5 shrink-0 animate-spin" /><span className="min-w-0 break-words">{t('Working')} · {busy.map(member => member.memberName).join(', ')}</span></div>}
      </div>
      {data.failed && <div role="alert" className="flex items-start gap-2 rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive"><AlertCircle size={15} className="shrink-0" /><span className="flex-1">{t('Could not load task history.')}</span><button onClick={data.retry} className="inline-flex shrink-0 items-center gap-1 rounded hover:underline"><RefreshCw size={12} />{t('Retry')}</button></div>}
      {!data.loaded && !data.failed && <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 size={14} className="animate-spin" />{t('Loading task…')}</p>}
      <TaskDecisionRequests pending={pending} onDecision={onDecision} />
      <details open className="group/progress overflow-hidden rounded-xl border border-border">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 py-3 text-xs font-medium hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"><CheckCircle2 size={14} className="text-muted-foreground" />{t('Progress')}<span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground">{unfinished.length}</span><ChevronDown size={14} className="ml-auto text-muted-foreground -rotate-90 transition-transform group-open/progress:rotate-0" /></summary>
        <div className="max-h-80 space-y-2 overflow-y-auto border-t border-border bg-secondary/20 p-3">
          {unfinished.map(row => {
            const memberName = row.assigneeAppId && parseSpaceCoordinatorAppId(row.assigneeAppId) ? t('Main chat') : detail.roster.find(member => member.appId === row.assigneeAppId)?.memberName
            return <div key={row.id} className="rounded-lg border border-border bg-background p-3">
              <div className="flex items-start gap-2"><p className="min-w-0 flex-1 break-words text-sm leading-5">{row.title}</p><span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] ${row.status === 'blocked' ? 'bg-halo-warning/10 text-halo-warning' : row.status === 'in_progress' ? 'bg-primary/10 text-primary' : 'bg-secondary text-muted-foreground'}`}>{statusLabels[row.status]}</span></div>
              {memberName && <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground"><AutomationAvatar name={memberName} size={18} /><span className="truncate">{memberName}</span></div>}
              {row.note && <details className="mt-2 text-xs text-muted-foreground"><summary className="cursor-pointer truncate">{row.note}</summary><p className="mt-2 whitespace-pre-wrap break-words leading-5">{row.note}</p></details>}
            </div>
          })}
          {data.loaded && !unfinished.length && <p className="py-1 text-xs leading-5 text-muted-foreground">{t('No unfinished items recorded.')}</p>}
        </div>
      </details>
      <details className="group/outputs overflow-hidden rounded-xl border border-border">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 py-3 text-xs font-medium hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"><FileText size={14} className="text-muted-foreground" />{t('Outputs')}<span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground">{artifacts.list.length}</span>{artifacts.status === 'loading' && <Loader2 size={12} className="animate-spin text-muted-foreground" />}{artifacts.status === 'failed' && <AlertCircle size={13} className="text-destructive" aria-label={t('Could not load outputs.')} />}<ChevronDown size={14} className="ml-auto text-muted-foreground -rotate-90 transition-transform group-open/outputs:rotate-0" /></summary>
        <div className="max-h-80 space-y-2 overflow-y-auto border-t border-border bg-secondary/20 p-3"><TaskOutputList data={data} /></div>
      </details>
      <TaskMemberExecutions roster={detail.roster} epochId={task.epochId} onOpen={setExecutionMember} />
      <section><h3 className="mb-3 flex items-center gap-2 text-xs font-medium"><MessageSquare size={14} className="text-muted-foreground" />{t('Collaboration history')}</h3>
        <TaskCollaborationHistory data={data} detail={detail} task={task} focusActivityId={activityTarget} homepageConversation={false} onOpenMember={setExecutionMember} />
      </section>
    </div>
  </WorkbenchDrawer>
}
