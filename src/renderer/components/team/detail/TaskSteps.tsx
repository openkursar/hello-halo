import { useMemo, useRef, type ReactNode } from 'react'
import type { TFunction } from 'i18next'
import { ChevronRight, Loader2, MessageCircle } from 'lucide-react'
import type { BlackboardTask, RosterMember, TeamActivity, TeamDetail } from '../../../../shared/apps/team-types'
import { useTranslation } from '../../../i18n'
import { markdownPreview } from '../../../utils/markdown-preview'
import { AutomationAvatar } from '../../apps/AutomationAvatar'
import { FileIcon } from '../../icons/ToolIcons'
import { isDelegatedTask } from '../../../../shared/apps/team-delegations'
import { ActivityContent } from '../workbench/TaskActivityTimeline'
import type { MemberProgress, TaskProgress } from '../workbench/progress'
import { memberProgressText, progressMemberName } from '../workbench/progress-labels'
import { answeredDecisions, subtaskBoard, subtaskDurations, subtaskRecord, type AnsweredDecision, type SubtaskDuration, type SubtaskRecord } from '../workbench/subtasks'
import { memberAnsweredText, memberWaitText } from '../workbench/task-brief'
import { formatSpan, taskTime } from '../workbench/time'
import type { TaskActivityData } from '../workbench/useTaskActivity'
import type { TaskStateKey } from './status'

/** `stalled`: taken up on the board, but the task is idle and nobody is on it. */
type StepState = 'done' | 'rejected' | 'waiting' | 'failed' | 'running' | 'stalled' | 'todo'

interface Step { row: BlackboardTask; state: StepState }

/** A line on the timeline: a step, or a question someone had to answer. */
type Entry = { key: string; at: number | null; state: StepState } & ({ step: Step; decision?: undefined } | { decision: AnsweredDecision; step?: undefined })

/** Plans this long fold their earlier done steps while work goes on. */
const FOLD_FROM = 10
const FOLD_KEY = 'steps:done'
/** Open-state key that collapses the whole timeline; absent means shown. */
export const STEPS_HIDDEN_KEY = 'steps:hidden'

/** A finished task's steps are history, folded until asked for; a running task's are its progress. */
export function stepsHidden(open: Readonly<Record<string, boolean>>, finished: boolean): boolean {
  return open[STEPS_HIDDEN_KEY] ?? finished
}
/** Marks the timeline's answered questions, so the brief can bring them into view. */
export const DECISION_ANCHOR = 'decision'

/** The lead's plan as a timeline: what is done, the questions it waited on, what is under way, and what comes next. Trouble is told by the brief card above, so here it is only a node and a word. */
export function TaskSteps({ detail, data, progress, stateKey, lastActs, open, onToggle, onAnswer, onOpenMember }: {
  detail: TeamDetail
  stateKey: TaskStateKey
  data: TaskActivityData
  progress: TaskProgress
  lastActs: ReadonlyMap<string, TeamActivity>
  open: Readonly<Record<string, boolean>>
  onToggle: (key: string) => void
  onAnswer: (decisionId: string) => void
  onOpenMember: (appId: string) => void
}) {
  const { t } = useTranslation()
  const steps = useMemo(() => {
    const inOrder = data.tasks.some(isDelegatedTask)
    const board = subtaskBoard(data.tasks, progress.members, inOrder)
    const group = (id: string) => board.groups.find(item => item.id === id)?.tasks ?? []
    const done = inOrder ? group('done') : [...group('done')].reverse()
    return [
      ...done.map(row => ({ row, state: row.status === 'rejected' ? 'rejected' : 'done' }) as Step),
      ...group('failed').map(row => ({ row, state: 'failed' }) as Step),
      ...group('waiting').map(row => ({ row, state: 'waiting' }) as Step),
      ...group('working').map(row => ({ row, state: stateKey === 'idle' ? 'stalled' : 'running' }) as Step),
      ...group('pending').map(row => ({ row, state: 'todo' }) as Step),
    ]
  }, [data.tasks, progress.members, stateKey])
  const durations = useMemo(() => subtaskDurations(data.tasks, data.activities), [data.tasks, data.activities])
  const records = useMemo(() => new Map(steps.map(step => [step.row.id, subtaskRecord(step.row, data.activities)])), [steps, data.activities])
  const decisions = useMemo(() => answeredDecisions(data.activities), [data.activities])
  const entries = useMemo(() => timeline(steps, records, decisions), [steps, records, decisions])
  const stateOf = useMemo(() => new Map(progress.members.map(row => [row.appId, row])), [progress.members])
  const hidden = stepsHidden(open, progress.finished)

  const settled = steps.filter(step => step.state === 'done' || step.state === 'rejected').length
  const foldable = !progress.finished && steps.length >= FOLD_FROM && settled > 2 ? settled - 1 : 0
  const shown = foldable && !open[FOLD_KEY] ? entries.slice(entries.findIndex(entry => entry.step === steps[foldable])) : entries

  const stepItem = (step: Step, at: number | null, next: StepState | undefined) => {
    const key = `step:${step.row.id}`
    const member = stateOf.get(step.row.assigneeAppId ?? '')
    const decisionId = step.state === 'waiting' ? member?.decisionId : undefined
    return <StepItem key={key} step={step} next={next} at={at} detail={detail} member={member}
      took={durations.get(step.row.id)} latest={step.row.assigneeAppId ? lastActs.get(step.row.assigneeAppId)?.subject : undefined}
      record={records.get(step.row.id)!} data={data} open={!!open[key]} onToggle={() => onToggle(key)} onAnswer={decisionId ? () => onAnswer(decisionId) : undefined} onOpenMember={onOpenMember} />
  }

  const counts = [
    steps.length ? t('Subtasks {{done}}/{{total}}', { done: settled, total: steps.length }) : null,
    decisions.length ? t('{{count}} confirmations', { count: decisions.length }) : null,
  ].filter(Boolean).join(' · ')

  return <section aria-label={t('Work process')}>
    <h3 className="mb-2 ml-0.5 text-[13px] font-medium leading-5 tabular-nums text-foreground/85">
      <button onClick={() => onToggle(STEPS_HIDDEN_KEY)} aria-expanded={!hidden} className="inline-flex items-center gap-1 rounded transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
        {t('Work process')}
        {counts && <span className="ml-1 font-normal text-faint-foreground">{counts}</span>}
        <ChevronRight size={13} aria-hidden="true" className={`text-faint-foreground transition-transform ${hidden ? '' : 'rotate-90'}`} />
      </button>
    </h3>
    {!hidden && !steps.length && !decisions.length && (!data.loaded && !data.failed
      ? <p role="status" className="flex items-center gap-2 text-xs text-faint-foreground"><Loader2 size={14} className="animate-spin" />{t('Loading conversation…')}</p>
      : <p className="mb-2 text-[13px] text-faint-foreground">{progress.finished || stateKey === 'idle' ? t('This task was not split into subtasks.') : t('The lead has not split this into subtasks yet.')}</p>)}
    {!hidden && shown.length > 0 && <ol className="pl-3">
      {foldable > 0 && <FoldItem count={foldable} open={!!open[FOLD_KEY]} onToggle={() => onToggle(FOLD_KEY)} />}
      {shown.map((entry, index) => {
        const next = shown[index + 1]?.state
        if (entry.decision) return <DecisionItem key={entry.key} decision={entry.decision} next={next} detail={detail} open={!!open[entry.key]} onToggle={() => onToggle(entry.key)} onOpenMember={onOpenMember} />
        return stepItem(entry.step, entry.at, next)
      })}
    </ol>}
  </section>
}

/** Answered questions go among the finished steps by when they were asked; later ones come before the work still open. */
function timeline(steps: readonly Step[], records: ReadonlyMap<string, SubtaskRecord>, decisions: readonly AnsweredDecision[]): Entry[] {
  const settled = steps.filter(step => step.state === 'done' || step.state === 'rejected').length
  const queue = [...decisions]
  const asked = (decision: AnsweredDecision): Entry => ({ key: `decision:${decision.id}`, at: decision.askedAt, state: 'done', decision })
  const entries: Entry[] = []
  steps.forEach((step, index) => {
    const at = stepStart(step, records.get(step.row.id)!)
    while (queue.length && (index >= settled || (at !== null && queue[0].askedAt < at))) entries.push(asked(queue.shift()!))
    entries.push({ key: `step:${step.row.id}`, at, state: step.state, step })
  })
  return [...entries, ...queue.map(asked)]
}

/** When the step was taken up, else posted; a step not started yet has no place on the clock. */
function stepStart(step: Step, record: SubtaskRecord): number | null {
  if (step.state === 'todo') return null
  return taskTime(record.updates.find(update => update.status === 'in_progress')?.createdAt) ?? step.row.createdAt
}

function FoldItem({ count, open, onToggle }: { count: number; open: boolean; onToggle: () => void }) {
  const { t } = useTranslation()
  return <li className="relative grid grid-cols-[9px_1fr] gap-x-2.5">
    <span aria-hidden="true" className={`absolute bottom-[-11px] left-[4px] top-[25px] w-0 border-l ${LINE_WALKED}`} />
    <span className="flex self-start justify-center pt-[15px]"><StepNode state="done" /></span>
    <div className="min-w-0 pb-1">
      <button onClick={onToggle} aria-expanded={open} className="flex items-center gap-1 rounded-[10px] px-2.5 py-2 text-[13px] text-subtle-foreground transition-colors hover:bg-secondary/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
        {t('{{count}} steps done', { count })}
        <ChevronRight size={14} aria-hidden="true" className={`text-faint-foreground transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
    </div>
  </li>
}

const LINE_WALKED = 'border-subtle-foreground/35'

/** A step unfolds in place into what it was asked, how it went and what it produced. */
function StepItem({ step, next, at, detail, member, took, latest, record, data, open, onToggle, onAnswer, onOpenMember }: {
  step: Step; next: StepState | undefined; at: number | null; detail: TeamDetail; member: MemberProgress | undefined
  took: SubtaskDuration | undefined; latest: string | undefined; record: SubtaskRecord; data: TaskActivityData; open: boolean; onToggle: () => void
  onAnswer: (() => void) | undefined; onOpenMember: (appId: string) => void
}) {
  const { t } = useTranslation()
  const { row, state } = step
  const trouble = state === 'waiting' || state === 'failed'
  const note = stepNote(step, member, latest, detail, t)
  const waited = state === 'done' && took && took.waited > 0 && row.assigneeAppId ? t('Of that, {{waits}}', { waits: memberWaitText(detail.roster, row.assigneeAppId, took.waited, t) }) : null
  const settled = state === 'done' || state === 'rejected' || state === 'failed'
  const result = settled ? row.note?.trim() || null : null
  const updates = result && record.updates.at(-1)?.status === row.status ? record.updates.slice(0, -1) : record.updates
  const opens = state !== 'todo' && !!(record.brief || updates.length || result || row.resultRef)
  const expanded = opens && open
  // Trouble says where it stands beside its member; other steps say what they did under the title.
  const summary = trouble ? null : state === 'running' || state === 'stalled' ? note : result ? { text: headline(result, row.title), tone: '' } : null
  const file = state === 'done' || state === 'rejected' ? row.resultRef : null
  const span = state === 'done' && took !== undefined ? t('Took {{time}}', { time: formatSpan(took.ms, t) })
    : state === 'running' && at !== null && Date.now() > at ? t('{{time}} so far', { time: formatSpan(Date.now() - at, t) }) : null
  const head = <>
    <span className="min-w-0 flex-1">
      <span className={BYLINE}>
        <MemberTag roster={detail.roster} appId={row.assigneeAppId} onOpen={onOpenMember} />
        <span title={trouble ? note?.full ?? note?.text : waited ?? undefined} className="min-w-0 truncate">{waited && <> · {waited}</>}{trouble && note && <> · <span className={note.tone}>{note.text}</span></>}</span>
      </span>
      <span className={`mt-0.5 line-clamp-2 break-words text-[13.5px] ${state === 'rejected' ? 'text-subtle-foreground line-through decoration-faint-foreground' : state === 'todo' ? 'text-subtle-foreground' : 'font-medium text-foreground'}`}>{row.title}</span>
      {!expanded && (summary?.text || file) && <span className="mt-1 flex min-w-0 items-center gap-2 text-[12.5px] text-subtle-foreground">
        {summary?.text && <span title={summary.full ?? summary.text} className="min-w-0 truncate">{summary.text}</span>}
        {file && <FileTag resultRef={file} data={data} alone={!summary?.text} />}
      </span>}
    </span>
    {(opens || at !== null) && <span className="flex h-5 shrink-0 items-center gap-1.5 self-start">
      {at !== null && <span className="whitespace-nowrap text-xs tabular-nums text-faint-foreground"><AxisTime at={at} />{span && <> · {span}</>}</span>}
      {opens && <ChevronRight size={14} aria-hidden="true" className={`text-faint-foreground transition-transform ${expanded ? 'rotate-90' : ''}`} />}
    </span>}
  </>

  return <TimelineRow next={next} node={<StepNode state={state} />} head={head} opens={opens} expanded={expanded} onToggle={onToggle}
    action={onAnswer && <button onClick={onAnswer} className="mt-[5px] inline-flex h-[26px] shrink-0 items-center rounded-full border border-halo-warning/45 px-2.5 text-xs text-halo-warning transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('Answer')}</button>}>
    <StepDetail brief={record.brief} updates={updates} result={result} resultRef={row.resultRef} data={data} />
  </TimelineRow>
}

/** The first line of a step's closing note that says more than its title, which is often that same line. */
function headline(note: string, title: string): string {
  const lines = markdownPreview(note).split('\n')
  return lines.find(line => line !== title.trim()) ?? ''
}

/** A file a step produced, opening it without unfolding the step when the panel can show it. */
function FileTag({ resultRef, data, alone }: { resultRef: string; data: TaskActivityData; alone: boolean }) {
  const name = resultRef.split(/[\\/]/).pop() || resultRef
  const dot = name.lastIndexOf('.')
  const canOpen = data.artifacts.has(resultRef)
  return <span title={resultRef} onClick={canOpen ? event => { event.stopPropagation(); data.artifacts.open(resultRef) } : undefined}
    className={`inline-flex min-w-0 items-center gap-1.5 rounded-md bg-secondary/70 px-1.5 py-0.5 text-[12px] text-foreground/85 ${alone ? 'max-w-full' : 'max-w-[55%] shrink-0'} ${canOpen ? 'cursor-pointer hover:bg-secondary' : ''}`}>
    <FileIcon extension={dot > 0 ? name.slice(dot + 1) : ''} size={14} className="shrink-0" /><span className="min-w-0 truncate">{name}</span>
  </span>
}

/** A question someone had to answer before the work went on, as one quiet line: who asked whom, the reply, how long it waited. */
function DecisionItem({ decision, next, detail, open, onToggle, onOpenMember }: {
  decision: AnsweredDecision; next: StepState | undefined; detail: TeamDetail; open: boolean; onToggle: () => void
  onOpenMember: (appId: string) => void
}) {
  const { t } = useTranslation()
  const { asked: askedWhom, replied } = memberAnsweredText(detail.roster, decision.appId, t)
  const question = markdownPreview(decision.ask.subject.trim() || decision.ask.body?.trim() || '').replace(/\n/g, ' ')
  const asked = decision.ask.body?.trim()
  const reply = decision.answer.body?.trim() || decision.answer.subject.trim()
  const head = <>
    <span className="flex h-5 min-w-0 flex-1 items-center text-[12px] text-faint-foreground">
      <MemberTag roster={detail.roster} appId={decision.appId} onOpen={onOpenMember} />
      <span title={question} className="min-w-0 truncate">&nbsp;{askedWhom} <span className="text-subtle-foreground">{question}</span></span>
      <span className="shrink-0 whitespace-nowrap">&nbsp;· <span className="text-halo-success">{replied}</span></span>
    </span>
    <span className="flex h-5 shrink-0 items-center gap-1.5">
      <span className="whitespace-nowrap text-xs tabular-nums text-faint-foreground"><AxisTime at={decision.askedAt} /><span className="hidden sm:inline"> · {t('Waited {{time}}', { time: formatSpan(decision.answeredAt - decision.askedAt, t) })}</span></span>
      <ChevronRight size={14} aria-hidden="true" className={`text-faint-foreground transition-transform ${open ? 'rotate-90' : ''}`} />
    </span>
  </>
  return <TimelineRow anchor={DECISION_ANCHOR} compact next={next} head={head}
    node={<span role="img" aria-label={t('Decision')} className="-mx-[3px] -mt-[2px] flex h-[15px] w-[15px] items-center justify-center bg-background text-faint-foreground"><MessageCircle size={12} strokeWidth={2} aria-hidden="true" /></span>} opens expanded={open} onToggle={onToggle}>
    <div className="mb-2 mt-0.5 space-y-3.5 pl-2.5 pr-1">
      {asked && markdownPreview(asked).replace(/\n/g, ' ') !== question && <div>
        <p className={DETAIL_LABEL}>{t('Question')}</p>
        <ActivityContent content={asked} full />
      </div>}
      <div>
        <p className={DETAIL_LABEL}>{t('Reply')} · <AxisTime at={decision.answeredAt} /></p>
        <ActivityContent content={reply} full />
      </div>
    </div>
  </TimelineRow>
}

/** A line's first row, level with its node: who it belongs to and where it stands. */
const BYLINE = 'flex h-5 min-w-0 items-center text-[12px] text-faint-foreground'

/** Who a line belongs to; a member of this work leads to what it did here without unfolding the line. */
function MemberTag({ roster, appId, onOpen }: { roster: readonly RosterMember[]; appId: string | null; onOpen: (appId: string) => void }) {
  const { t } = useTranslation()
  const member = appId ? roster.find(row => row.appId === appId) : undefined
  if (!member) return <span className="shrink-0">{appId ? progressMemberName(roster, appId, t) : t('Unassigned')}</span>
  const name = progressMemberName(roster, member.appId, t)
  return <span title={t('View {{name}}’s work', { name })} onClick={event => { event.stopPropagation(); onOpen(member.appId) }}
    className="inline-flex min-w-0 max-w-[60%] shrink-0 cursor-pointer items-center gap-1 font-medium text-subtle-foreground hover:text-foreground hover:underline">
    <AutomationAvatar name={member.memberName} size={16} /><span className="truncate">{name}</span>
  </span>
}

/** One line of the timeline: a node on the axis and a head that may unfold in place. `compact` is a quiet one-row line. */
function TimelineRow({ next, node, head, opens, expanded, onToggle, action, anchor, compact, children }: {
  next: StepState | undefined; node: ReactNode; head: ReactNode
  opens: boolean; expanded: boolean; onToggle: () => void; action?: ReactNode; anchor?: string; compact?: boolean; children: ReactNode
}) {
  const headRef = useRef<HTMLDivElement>(null)
  // Collapsing from the pinned header would leave it far above; bring it back into view.
  const toggle = () => {
    onToggle()
    if (expanded) requestAnimationFrame(() => headRef.current?.scrollIntoView({ block: 'nearest' }))
  }
  const pin = expanded ? 'sticky top-[var(--page-sticky-top,0px)] z-[2]' : ''
  const line = `flex min-w-0 flex-1 items-center gap-2 rounded-[10px] px-2.5 text-left ${compact ? 'py-1' : 'py-2'}`
  return <li data-step-anchor={anchor} className="relative grid grid-cols-[9px_1fr] gap-x-2.5">
    {next && <span aria-hidden="true" className={`absolute bottom-[-11px] left-[4px] w-0 border-l ${compact ? 'top-[23px]' : 'top-[25px]'} ${next === 'todo' ? 'border-dashed border-faint-foreground/40' : LINE_WALKED}`} />}
    <span className={`flex self-start justify-center ${compact ? 'pt-[9px]' : 'pt-[15px]'} ${pin}`}>{node}</span>
    <div className="min-w-0 pb-1">
      <div ref={headRef} className={`flex scroll-mt-[var(--page-sticky-top,0px)] items-start gap-1.5 ${expanded ? `${pin} rounded-[10px] bg-background` : ''}`}>
        {opens
          ? <button onClick={toggle} aria-expanded={expanded} className={`${line} transition-colors hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${expanded ? 'bg-secondary/60' : ''}`}>{head}</button>
          : <div className={line}>{head}</div>}
        {action}
      </div>
      {expanded && children}
    </div>
  </li>
}

const DETAIL_LABEL = 'text-[11.5px] font-medium text-faint-foreground'

function StepDetail({ brief, updates, result, resultRef, data }: {
  brief: TeamActivity | null; updates: TeamActivity[]; result: string | null; resultRef: string | null; data: TaskActivityData
}) {
  const { t } = useTranslation()
  const statusLabels: Record<string, string> = { pending: t('Reopened'), in_progress: t('Started'), blocked: t('Cannot continue'), done: t('Done'), rejected: t('Rejected') }
  const fileName = resultRef ? resultRef.split(/[\\/]/).pop() || resultRef : null
  const dot = fileName ? fileName.lastIndexOf('.') : -1
  const canOpen = !!resultRef && data.artifacts.has(resultRef)
  return <div className="mb-2 mt-0.5 space-y-3.5 pl-2.5 pr-1">
    {brief && <div>
      <p className={DETAIL_LABEL}>{t('Assignment')}</p>
      <ActivityContent content={brief.body || brief.subject} full />
    </div>}
    {updates.length > 0 && <div>
      <p className={DETAIL_LABEL}>{t('Progress')}</p>
      <ol className="mt-1.5 space-y-1">
        {updates.map((update, index) => <li key={update.id} className="flex gap-3 text-[12.5px] leading-5">
          <span className="shrink-0 whitespace-nowrap tabular-nums text-faint-foreground">{taskTime(update.createdAt) !== null && <AxisTime at={taskTime(update.createdAt)!} />}</span>
          <span className="min-w-0 break-words text-foreground/85">{[update.status && update.status !== updates[index - 1]?.status ? statusLabels[update.status] : null, update.subject.trim() || null].filter(Boolean).join(' · ')}</span>
        </li>)}
      </ol>
    </div>}
    {(result || fileName) && <div>
      <p className={DETAIL_LABEL}>{t('Result')}</p>
      {result && <ActivityContent content={result} full />}
      {fileName && (canOpen
        ? <button onClick={() => data.artifacts.open(resultRef!)} title={fileName} className="mt-2 inline-flex max-w-full items-center gap-2 rounded-lg border border-border-soft bg-card px-2.5 py-1.5 text-left text-[12.5px] transition-colors hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
          <FileIcon extension={dot > 0 ? fileName.slice(dot + 1) : ''} size={16} className="shrink-0" /><span className="min-w-0 truncate">{fileName}</span>
        </button>
        : <p title={resultRef!} className="mt-2 flex min-w-0 items-center gap-2 text-[12.5px] text-subtle-foreground"><FileIcon extension={dot > 0 ? fileName.slice(dot + 1) : ''} size={16} className="shrink-0" /><span className="min-w-0 truncate">{fileName}</span></p>)}
    </div>}
  </div>
}

function stepNote(step: Step, member: MemberProgress | undefined, latest: string | undefined, detail: TeamDetail, t: TFunction): { text: string; full?: string; tone: string } | null {
  const { row, state } = step
  if (state === 'waiting') return { text: member?.decisionId ? t('Waiting on you') : member ? memberProgressText(member, detail.roster, t) : t('Waiting on you'), full: member ? memberProgressText(member, detail.roster, t) : undefined, tone: 'text-halo-warning' }
  if (state === 'failed') {
    const reason = row.status === 'blocked' ? row.note?.trim() || t('Cannot continue') : member ? memberProgressText(member, detail.roster, t) : t('Errored')
    return { text: t('Errored'), full: reason, tone: 'text-destructive' }
  }
  if (state === 'running') {
    const text = row.note?.trim() || latest?.trim()
    return { text: text || t('Working…'), tone: '' }
  }
  if (state === 'stalled') return { text: t('Nobody is on it right now'), full: row.note?.trim() || undefined, tone: '' }
  return null
}

const NODE: Record<StepState, string> = {
  done: 'bg-halo-success',
  rejected: 'bg-faint-foreground/50',
  running: 'bg-primary',
  stalled: 'border-[1.5px] border-primary/60 bg-background',
  waiting: 'bg-halo-warning ring-[3px] ring-halo-warning/20',
  failed: 'bg-destructive ring-[3px] ring-destructive/20',
  todo: 'border-[1.5px] border-faint-foreground/60 bg-background',
}

function StepNode({ state }: { state: StepState }) {
  const { t } = useTranslation()
  const label = { done: t('Completed'), rejected: t('Rejected'), running: t('In progress'), stalled: t('Unfinished'), waiting: t('Waiting on you'), failed: t('Errored'), todo: t('Not started yet') }[state]
  return <span role="img" aria-label={label} className={`relative block h-[9px] w-[9px] rounded-full ${NODE[state]}`}>
    {state === 'running' && <span aria-hidden="true" className="absolute inset-0 animate-ping rounded-full bg-primary/50" />}
  </span>
}

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const shortDate = (at: number) => new Date(at).toLocaleDateString([], { month: 'numeric', day: 'numeric' })

/** Clock time, with the date before it when it is not today. */
function AxisTime({ at }: { at: number }) {
  const date = new Date(at)
  const today = date.toDateString() === new Date().toDateString()
  return <time dateTime={date.toISOString()} title={date.toLocaleString()}>{today ? clock(at) : `${shortDate(at)} ${clock(at)}`}</time>
}
