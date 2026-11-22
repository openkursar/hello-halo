import { useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { Loader2, MinusCircle, Square } from 'lucide-react'
import type { TeamActivity, TeamConversation, TeamDetail } from '../../../../shared/apps/team-types'
import { parseSpaceCoordinatorAppId } from '../../../../shared/apps/team-types'
import { useTranslation } from '../../../i18n'
import { formatTimeAgo } from '../../../utils/format-time'
import { markdownPreview } from '../../../utils/markdown-preview'
import { FileIcon } from '../../icons/ToolIcons'
import { taskProgress, type TaskProgress } from '../workbench/progress'
import { progressMemberName } from '../workbench/progress-labels'
import { subtaskBoard } from '../workbench/subtasks'
import { activeBriefHead, BriefCard, BriefItem, CompletedMark, FailedBriefItem, FinishedBrief, finishedSummary, HeldFooter, NAME, namedMember, useWaitText, WorkingFooter } from '../workbench/task-brief'
import { latestActs, newestOutputs, type TaskOutput } from '../workbench/task-record'
import { formatSpan, taskTime } from '../workbench/time'
import type { TaskActivityData } from '../workbench/useTaskActivity'
import { isExchange } from './crew'
import { DecisionCard, type HeldDecisions } from './DecisionCard'
import { isLive, isTeamWork, taskState, type TaskStateKey } from './status'
import { endedText, MemberConversationsLink, MoreToggle, PILL_SECONDARY, sourceLabel, taskOrigin, taskSource } from './task-ui'
import { DECISION_ANCHOR, STEPS_HIDDEN_KEY, stepsHidden, TaskSteps } from './TaskSteps'
import { TeamScene } from './TeamScene'

const OUTPUT_LIMIT = 6
const SECTION = 'mt-8'

export interface TaskOverview {
  progress: TaskProgress
  stateKey: TaskStateKey
  /** Each member's latest act in this task. */
  lastActs: ReadonlyMap<string, TeamActivity>
  /** Newest first. */
  outputs: readonly TaskOutput[]
}

/** What a task's body reads from its activity, wherever it is shown. */
export function useTaskOverview(detail: TeamDetail, task: TeamConversation, data: TaskActivityData): TaskOverview {
  const listedKey = taskState(detail, task).key
  const progress = useMemo(() => taskProgress({
    epochId: task.epochId, roster: detail.roster, leadAppId: detail.team.leadAppId ?? null, activities: data.activities, tasks: data.tasks,
    decisions: data.pending.map(row => ({ id: row.entryId, appId: row.appId, question: row.question })),
    waitingAppIds: task.waitingMemberAppIds ?? [], participants: data.participants, completed: !!task.completed || task.finishedAt !== undefined || listedKey === 'done',
  }), [listedKey, task.epochId, task.waitingMemberAppIds, task.completed, task.finishedAt, detail.roster, detail.team.leadAppId, data.activities, data.tasks, data.pending, data.participants])
  const lastActs = useMemo(() => latestActs(data.activities), [data.activities])
  const outputs = useMemo(() => newestOutputs(data.artifacts.list, data.findings), [data.artifacts.list, data.findings])
  return { progress, stateKey: progress.finished ? 'done' : listedKey, lastActs, outputs }
}

/**
 * One task under its title, the same in the team page and in the canvas beside a chat:
 * status, the brief, questions answered in place, who is on it, the steps and what came out.
 */
export function TaskBody({ detail, task, taskSpaceId, data, overview, held, open, setOpen, onOpenMember, onOpenAll, onOpenExchange, onContinue, onEnd }: {
  detail: TeamDetail
  task: TeamConversation
  taskSpaceId: string | null
  data: TaskActivityData
  overview: TaskOverview
  held: HeldDecisions
  open: Readonly<Record<string, boolean>>
  setOpen: Dispatch<SetStateAction<Record<string, boolean>>>
  /** A member's work on this task. */
  onOpenMember: (appId: string) => void
  /** Everyone's exchanges. */
  onOpenAll: () => void
  onOpenExchange: (activityId: string) => void
  /** Where a person writes to pick stopped work up again; absent where that conversation is already open. */
  onContinue?: () => void
  /** Closes unfinished work by hand; absent where this person may not. */
  onEnd?: () => void
}) {
  const { progress, stateKey, lastActs, outputs } = overview
  const { decisions, answeringId, setAnswering } = held
  const decisionsRef = useRef<HTMLDivElement>(null)
  const answer = (decisionId: string) => {
    const decision = data.pending.find(item => item.entryId === decisionId)
    if (!decision) return
    setAnswering(decision)
    requestAnimationFrame(() => decisionsRef.current?.querySelector(`[data-decision-id="${CSS.escape(decisionId)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
  }
  const stepsRef = useRef<HTMLDivElement>(null)
  const showDecisions = () => {
    setOpen(current => ({ ...current, [STEPS_HIDDEN_KEY]: false }))
    requestAnimationFrame(() => stepsRef.current?.querySelector(`[data-step-anchor="${DECISION_ANCHOR}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }))
  }
  // A plain question has no steps or exchanges to show; empty sections would only suggest missing work.
  const plainChat = !isTeamWork(task) && !data.tasks.length && !data.activities.length && !data.reports.reports.length
  const scene = isTeamWork(task) && !plainChat && task.kind !== 'im'

  return <>
    <StatusLine detail={detail} task={task} stateKey={stateKey} data={data} onWaits={showDecisions} onEnd={onEnd} />

    <Brief detail={detail} task={task} data={data} progress={progress} stateKey={stateKey} onOpenMember={onOpenMember} onContinue={onContinue} />

    {decisions.length > 0 && <div ref={decisionsRef} className="space-y-2.5">
      {decisions.map(decision => <div key={decision.entryId} data-decision-id={decision.entryId}>
        <DecisionCard detail={detail} decision={decision} task={task} taskSpaceId={taskSpaceId}
          open={answeringId === decision.entryId} onOpen={value => setAnswering(value ? decision : null)} />
      </div>)}
    </div>}

    {scene && <TeamScene detail={detail} epochId={task.epochId} progress={progress} ended={!!task.endedManually} data={data} onOpenMember={onOpenMember} onOpenAll={onOpenAll} onOpenExchange={onOpenExchange} />}

    {!plainChat && <div ref={stepsRef} className={decisions.length && !scene ? SECTION : 'mt-6'}>
      <TaskSteps detail={detail} data={data} progress={progress} stateKey={stateKey} lastActs={lastActs} open={open} onToggle={key => setOpen(current => ({ ...current, [key]: key === STEPS_HIDDEN_KEY ? !stepsHidden(current, progress.finished) : !current[key] }))} onAnswer={answer} onOpenMember={onOpenMember} />
    </div>}

    <Outputs data={data} outputs={outputs} />

    {/* Without a scene, nothing above leads to the exchanges. */}
    {!plainChat && !scene && <section className={SECTION}><MemberConversationsLink count={data.activities.filter(isExchange).length} onOpen={onOpenAll} /></section>}
  </>
}

function taskSpan(task: TeamConversation, finished: boolean, data: TaskActivityData): number | null {
  const started = taskTime(task.startedAt)
  const ended = !finished ? Date.now()
    : task.finishedAt ?? (task.completed ? taskTime(task.lastActivityAt) : data.tasks.length ? Math.max(...data.tasks.map(row => row.updatedAt)) : null)
  return started !== null && ended !== null && ended > started ? ended - started : null
}

/**
 * Where the work came from, and how long it has been going or took, with how much
 * of a finished task's time went on waiting for answers; work that is not running says
 * when it last moved instead.
 */
function StatusLine({ detail, task, stateKey, data, onWaits, onEnd }: { detail: TeamDetail; task: TeamConversation; stateKey: TaskStateKey; data: TaskActivityData; onWaits: () => void; onEnd?: () => void }) {
  const { t } = useTranslation()
  const finished = stateKey === 'done'
  const ended = finished && !!task.endedManually
  const span = taskSpan(task, finished, data)
  const waits = useWaitText(detail.roster, data.activities, finished && !ended ? span : null)
  const lastActive = t('Last active {{time}}', { time: formatTimeAgo(task.lastActivityAt, t) })
  const time = stateKey === 'idle' ? `${taskState(detail, task).fact.kind === 'stalled' ? t('Stopped partway') : t('Idle')} · ${lastActive}`
    : ended ? lastActive
    : stateKey !== 'running' && !finished ? lastActive
    : span === null ? null : finished ? t('Took {{time}}', { time: formatSpan(span, t) }) : t('Running for {{time}}', { time: formatSpan(span, t) })
  return <p className="mt-1 flex min-w-0 items-center gap-1.5 text-[12.5px] text-faint-foreground">
    {ended ? <><MinusCircle size={14} aria-hidden="true" className="shrink-0" /><span className="shrink-0 text-subtle-foreground">{endedText(task.endedBy, task.endedByMe, t)}</span><span aria-hidden="true">·</span></>
      : finished && <><CompletedMark /><span className="shrink-0 text-subtle-foreground">{t('Completed')}</span><span aria-hidden="true">·</span></>}
    <span className="min-w-0 truncate">
      {[taskOrigin(detail, task, t) ?? sourceLabel(taskSource(task), t), time].filter(Boolean).join(' · ')}
      {waits && <> · <button onClick={onWaits} className="rounded underline decoration-faint-foreground/50 underline-offset-[3px] transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{waits}</button></>}
    </span>
    {/* Ending changes the state this line reports, so it is offered here rather than beside the panel's action. */}
    {onEnd && <><span aria-hidden="true">·</span><button onClick={onEnd} className="inline-flex shrink-0 items-center gap-1 rounded text-subtle-foreground underline-offset-[3px] transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><Square size={9} fill="currentColor" strokeWidth={0} aria-hidden="true" />{t('End task')}</button></>}
  </p>
}

/** Where the task stands right now; a finished task with nothing beyond its status line has none. */
function Brief({ detail, task, data, progress, stateKey, onOpenMember, onContinue }: {
  detail: TeamDetail; task: TeamConversation; data: TaskActivityData; progress: TaskProgress; stateKey: TaskStateKey
  onOpenMember: (appId: string) => void; onContinue?: () => void
}) {
  const { t } = useTranslation()
  const roster = detail.roster
  const card = 'my-5 text-[13.5px] leading-[1.7]'
  if (progress.finished) {
    const lead = roster.find(member => member.appId === detail.team.leadAppId) ?? roster.find(member => member.isLead)
    return <FinishedBrief summary={finishedSummary(task, lead, data.reports.finals)} tasks={data.tasks} lead={lead} onOpenLead={onOpenMember} className={card} />
  }

  const nameOf = (appId: string | null) => (appId ? progressMemberName(roster, appId, t) : t('Unassigned'))
  // The face and name lead to the member's work inside this team.
  const who = (text: string, appId: string | null) => namedMember(text, nameOf(appId),
    appId && roster.some(member => member.appId === appId) ? () => onOpenMember(appId) : undefined)
  const items: ReactNode[] = []
  const failed = progress.members.filter(row => row.state === 'failed')
  for (const row of failed) items.push(<FailedBriefItem key={row.appId} row={row} roster={roster} who={who} />)
  const failedIds = new Set(failed.map(row => row.appId))
  for (const row of data.tasks) {
    if (row.status !== 'blocked' || failedIds.has(row.assigneeAppId ?? '')) continue
    items.push(<BriefItem key={row.id} text={who(t('{{name}} ran into an error: {{reason}}', { name: NAME, reason: row.note?.trim() || row.title }), row.assigneeAppId)} />)
  }
  const errors = items.length
  for (const decision of data.pending) items.push(<BriefItem key={decision.entryId} text={who(t('{{name}} is waiting for your answer.', { name: NAME }), decision.appId)} />)
  // Only its owner can answer: nothing for this user to do, yet the work is held on it.
  const pendingIds = new Set(data.pending.map(decision => decision.appId))
  const held = progress.members
    .filter(row => row.state === 'waiting' && !row.decisionId && !pendingIds.has(row.appId))
    .map(row => ({ appId: row.appId, owner: roster.find(member => member.appId === row.appId)?.owner?.trim(), question: openQuestion(data.activities, row.appId) }))
  // A lone hold, when nothing else needs the user, names its owner and wait in the heading, so its line only says who asked.
  const single = held.length === 1 && !errors && !data.pending.length ? held[0] : null
  for (const { appId, owner, question } of held) {
    const text = single?.owner && question ? t('{{name}} asked:', { name: NAME })
      : owner ? t('{{name}} is waiting for {{owner}} to confirm.', { name: NAME, owner })
        : t('{{name}} is waiting for its owner to confirm.', { name: NAME })
    items.push(<BriefItem key={`owner:${appId}`} text={who(text, appId)} quote={question?.text} />)
  }
  const heldTitle = !held.length ? null
    : !single?.owner ? t('Waiting for someone')
      : [t('Waiting for {{owner}} to confirm', { owner: single.owner }), single.question && t('Waited {{time}}', { time: formatSpan(Math.max(0, Date.now() - single.question.at), t) })].filter(Boolean).join(' · ')
  const stalled = !items.length && stateKey === 'idle' && taskState(detail, task).fact.kind === 'stalled'
  const { tone, title } = activeBriefHead(errors > 0, data.pending.length > 0, stalled ? t('Stopped partway') : heldTitle, t)
  // Work whose member failed or waits is told above; the footer names only work that is moving.
  const working = isLive(stateKey) ? subtaskBoard(data.tasks, progress.members).groups.find(group => group.id === 'working')?.tasks ?? [] : []
  if (stalled) {
    const open = data.tasks.filter(row => row.status === 'pending' || row.status === 'in_progress')
    const text = open.length === 1 ? t('Stopped at “{{step}}”; no one has carried it on since.', { step: open[0].title })
      : open.length > 1 ? t('{{count}} subtasks left; no one has carried it on since.', { count: open.length })
        : t('Stopped partway; no one has carried it on since.')
    items.push(<BriefItem key="stalled" text={text} action={onContinue && <button onClick={onContinue} className={PILL_SECONDARY}>{t('Continue in conversation')}</button>} />)
  }
  if (!items.length) items.push(<p key="calm">{stateKey === 'idle' ? t('Nothing is running right now.') : t('Going normally, nothing needs you.')}</p>)
  const footer = working.length > 0 ? <WorkingFooter working={working} roster={roster} onOpenMember={onOpenMember} />
    : single && roster.some(member => member.appId === single.appId) && <HeldFooter name={nameOf(single.appId)} onOpen={() => onOpenMember(single.appId)} />
  return <BriefCard tone={tone} title={title} className={card} footer={footer}>
    {items}
  </BriefCard>
}

/** Past two lines of the card nobody reads it; the rest is in the member's conversation. */
const QUESTION_CHARS = 300

/** The member's latest question still without an answer, as plain text, and when it was asked. */
function openQuestion(activities: readonly TeamActivity[], appId: string): { text: string; at: number } | null {
  const answered = new Set(activities.filter(row => row.kind === 'decision' && row.status === 'ok' && row.refId).map(row => row.refId))
  const asked = activities
    .filter(row => row.kind === 'decision' && row.status === 'escalation' && row.actorAppId === appId && row.refId && !answered.has(row.refId))
    .sort((a, b) => (taskTime(b.createdAt) ?? 0) - (taskTime(a.createdAt) ?? 0))[0]
  const text = asked ? markdownPreview(asked.subject.trim() || asked.body?.trim() || '').replace(/\s+/g, ' ').trim() : ''
  const at = asked ? taskTime(asked.createdAt) : null
  return !text || at === null ? null : { text: text.length > QUESTION_CHARS ? `${text.slice(0, QUESTION_CHARS)}…` : text, at }
}

/** Absent while nothing is listed: files written by commands are never listed, so "none" could not be claimed. */
function Outputs({ data, outputs }: { data: TaskActivityData; outputs: readonly TaskOutput[] }) {
  const { t } = useTranslation()
  const [all, setAll] = useState(false)
  if (!outputs.length && data.artifacts.status === 'ready') return null
  return <section className={SECTION} aria-label={t('Outputs')}>
    <h3 className="mb-2 ml-0.5 flex items-baseline gap-1.5 text-[13px] font-medium text-foreground/85">
      {t('Outputs')}{outputs.length > 0 && <span className="font-normal tabular-nums text-faint-foreground">{outputs.length}</span>}
    </h3>
    {outputs.length > 0 && <div className="-mx-2 flex flex-col gap-y-0.5">
      {(all ? outputs : outputs.slice(0, OUTPUT_LIMIT)).map(output => <OutputCard key={output.entry.path} output={output} onOpen={() => void data.artifacts.openEntry(output.entry)} />)}
    </div>}
    {outputs.length > OUTPUT_LIMIT && <MoreToggle up={all} onClick={() => setAll(value => !value)}>
      {all ? t('Show less') : t('Show {{count}} more', { count: outputs.length - OUTPUT_LIMIT })}
    </MoreToggle>}
    {data.artifacts.status === 'loading' && <p role="status" className="mt-1 flex items-center gap-2 text-xs text-faint-foreground"><Loader2 size={14} className="animate-spin" />{t('Loading outputs…')}</p>}
    {data.artifacts.status === 'failed' && <p role="alert" className="mt-1 text-xs text-destructive">{t('Could not load outputs.')} <button className="underline" onClick={data.retry}>{t('Retry')}</button></p>}
  </section>
}

function OutputCard({ output, onOpen }: { output: TaskOutput; onOpen: () => void }) {
  const { t } = useTranslation()
  const { entry, at } = output
  const by = entry.appId && parseSpaceCoordinatorAppId(entry.appId) ? t('Main chat') : entry.memberName
  const dot = entry.name.lastIndexOf('.')
  const meta = [by, at !== null ? formatTimeAgo(at, t) : null].filter(Boolean).join(' · ')
  return <button onClick={onOpen} title={entry.name} className="flex min-w-0 items-center gap-2.5 rounded-lg p-2 text-left transition-colors hover:bg-secondary/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
    <FileIcon extension={dot > 0 ? entry.name.slice(dot + 1) : ''} size={20} className="shrink-0" />
    <span className="min-w-0 flex-1">
      <span className="block truncate text-[13px] font-medium">{entry.name}</span>
      {meta && <span className="mt-px block truncate text-[11.5px] text-faint-foreground">{meta}</span>}
    </span>
  </button>
}
