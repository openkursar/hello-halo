import { AlertCircle, ArrowRight, FileText, Loader2, MessageSquare } from 'lucide-react'
import type { RosterMember, TeamConversation, TeamDetail } from '../../../../shared/apps/team-types'
import { parseSpaceCoordinatorAppId } from '../../../../shared/apps/team-types'
import { useTranslation } from '../../../i18n'
import { AutomationAvatar } from '../../apps/AutomationAvatar'
import type { TaskActivityKind } from './model'
import type { TaskActivityData } from './useTaskActivity'
import { TaskActivityTimeline } from './TaskActivityTimeline'
import { TaskExecutionView } from './TaskExecutionView'

export function TaskDecisionRequests({ pending, onDecision }: { pending: TaskActivityData['pending']; onDecision: (entryId: string) => void }) {
  const { t } = useTranslation()
  if (!pending.length) return null
  return <section aria-label={t('Needs my decision')}>
    <h3 className="mb-2 flex items-center gap-2 text-xs font-medium text-halo-warning"><AlertCircle size={14} />{t('Needs my decision')}<span className="rounded-full bg-halo-warning/10 px-1.5 py-0.5 tabular-nums">{pending.length}</span></h3>
    <div className="space-y-2">{pending.map(decision => <button key={decision.entryId} onClick={() => onDecision(decision.entryId)} className="group block w-full rounded-xl border border-halo-warning/30 bg-halo-warning/5 p-3 text-left transition-colors hover:bg-halo-warning/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
      <span className="flex items-center gap-2"><AutomationAvatar name={decision.memberName} size={24} /><span className="text-xs font-medium">{decision.memberName}</span></span><p className="mt-2 break-words text-sm leading-6">{decision.question}</p><span className="mt-3 flex items-center gap-1.5 text-xs font-medium text-primary">{t('Go to conversation to answer')}<ArrowRight size={13} className="transition-transform group-hover:translate-x-0.5" /></span>
    </button>)}</div>
  </section>
}

export function TaskOutputList({ data }: { data: TaskActivityData }) {
  const { t } = useTranslation()
  const { artifacts } = data
  return <>
    {artifacts.list.map(file => <button key={file.path} onClick={() => void artifacts.openEntry(file)} className="group/file flex min-h-12 w-full items-center gap-3 rounded-lg border border-border bg-background p-3 text-left transition-colors hover:border-primary/40 hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><span className="rounded-lg bg-primary/5 p-2 text-primary"><FileText size={16} /></span><span className="min-w-0 flex-1"><span className="block break-all text-xs font-medium leading-5">{file.name}</span>{file.memberName && <span className="mt-0.5 block text-[11px] text-muted-foreground">{file.appId && parseSpaceCoordinatorAppId(file.appId) ? t('Main chat') : file.memberName}</span>}</span><ArrowRight size={14} className="shrink-0 text-muted-foreground transition-colors group-hover/file:text-primary" /></button>)}
    {artifacts.status === 'loading' && <p className="text-xs text-muted-foreground">{t('Loading outputs…')}</p>}
    {artifacts.status === 'failed' && <p role="alert" className="text-xs text-destructive">{t('Could not load outputs.')} <button className="underline" onClick={data.retry}>{t('Retry')}</button></p>}
    {artifacts.status === 'ready' && !artifacts.list.length && <p className="py-1 text-xs text-muted-foreground">{t('No outputs recorded yet')}</p>}
  </>
}

export function TaskMemberExecutions({ roster, epochId, onOpen }: { roster: RosterMember[]; epochId: string; onOpen: (appId: string) => void }) {
  const { t } = useTranslation()
  return <section><h3 className="mb-2 text-xs font-medium">{t('Member executions')}</h3><div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{roster.map(member => <button key={member.appId} onClick={() => onOpen(member.appId)} className="flex min-h-11 items-center gap-2 rounded-lg border border-border p-2 text-left text-xs hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><AutomationAvatar name={member.memberName} size={22} /><span className="min-w-0 flex-1 truncate">{member.memberName}</span>{member.busy?.some(row => row.epochId === epochId) && <span className="h-2 w-2 rounded-full bg-primary" />}<ArrowRight size={13} /></button>)}</div></section>
}

export function TaskMemberExecution({ detail, task, member, homepageConversation }: { detail: TeamDetail; task: TeamConversation; member: RosterMember; homepageConversation: boolean }) {
  return <>
    <div><h2 className="text-base font-semibold">{member.memberName}</h2><p className="mt-1 text-xs text-muted-foreground">{task.label}</p></div>
    <TaskExecutionView homepageConversation={homepageConversation} key={member.appId} teamId={detail.team.id} epochId={task.epochId} appId={member.appId} spaceId={member.spaceId ?? ''} remote={member.sameMachine === false} />
  </>
}

/** Report gaps, the empty state and the timeline; the heading belongs to the caller. */
export function TaskCollaborationHistory({ data, detail, task, focusActivityId, homepageConversation, onOpenMember, kind, onKindChange }: {
  data: TaskActivityData; detail: TeamDetail; task: TeamConversation; focusActivityId?: string; homepageConversation: boolean; onOpenMember?: (appId: string) => void
  kind?: TaskActivityKind | null; onKindChange?: (kind: TaskActivityKind | null) => void
}) {
  const { t } = useTranslation()
  const { reports, gaps, activities, findings, artifacts } = data
  const ownerLabel = (owner: string | null) => owner ?? t('A teammate')
  return <>
    {reports.loading && !reports.reports.length && <p role="status" className="mb-3 flex items-center gap-2 text-xs text-muted-foreground"><Loader2 size={13} className="animate-spin" />{homepageConversation ? t('Loading conversation…') : t('Loading task…')}</p>}
    {(gaps.offline.length > 0 || gaps.failed.length > 0) && <div role="alert" className="mb-3 space-y-1 rounded-lg bg-halo-warning/10 p-3 text-xs leading-5 text-halo-warning">
      {gaps.offline.map(group => <p key={group.owner ?? ''} className="break-words">{t('{{owner}}’s computer is offline, so reports from {{members}} may be incomplete.', { owner: ownerLabel(group.owner), members: group.members.join(', ') })}</p>)}
      {gaps.failed.length > 0 && <p className="break-words">{t('Reports from {{members}} could not be refreshed.', { members: gaps.failed.join(', ') })}</p>}
      <button className="underline" onClick={data.retry}>{t('Retry')}</button>
    </div>}
    {gaps.elsewhere.length > 0 && <p className="mb-3 break-words text-xs leading-5 text-muted-foreground">{t('Reports from members on offline computers are not shown: {{owners}}.', { owners: gaps.elsewhere.map(ownerLabel).join(', ') })}</p>}
    {data.loaded && !reports.loading && !reports.unavailable.length && !activities.length && !reports.reports.length && <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center"><MessageSquare size={22} className="mx-auto mb-2 text-muted-foreground/50" /><p className="text-xs text-muted-foreground">{t('No activity yet')}</p></div>}
    <TaskActivityTimeline focusActivityId={activities.find(activity => activity.id === focusActivityId || activity.refId === focusActivityId)?.id ?? focusActivityId} messages={reports.reports} activities={activities} detail={detail} showEmpty={false} onOpenMember={onOpenMember} kind={kind} onKindChange={onKindChange} taskCompleted={!!task.completed} canOpenArtifact={ref => { const finding = findings.find(row => row.id === ref); return !!finding?.ref && artifacts.has(finding.ref) }} openArtifact={ref => { const finding = findings.find(row => row.id === ref); if (finding?.ref) artifacts.open(finding.ref) }} />
  </>
}
