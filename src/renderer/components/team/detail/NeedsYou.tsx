import { useState } from 'react'
import type { TFunction } from 'i18next'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { RosterMember, TeamConversation, TeamDetail, TeamPendingEscalation } from '../../../../shared/apps/team-types'
import { useTranslation } from '../../../i18n'
import { openPersonModelSettings } from '../../../utils/people-navigation'
import type { FailureCause } from '../workbench/progress'
import { toneSurface } from '../workbench/task-brief'
import { DecisionCard, useHeldDecisions } from './DecisionCard'
import { settingsFailure, taskState, type TaskStateKey } from './status'
import { factText, PILL_ON_TINT, PILL_PRIMARY, SectionHeading, StateIcon, taskTitle } from './task-ui'

/** Tasks stopped on the same model setting, fixed together. */
interface StoppedGroup { cause: FailureCause; tasks: { task: TeamConversation; member: RosterMember }[]; members: RosterMember[] }

type Unit =
  | { kind: 'stopped'; group: StoppedGroup }
  | { kind: 'decision'; decision: TeamPendingEscalation }
  | { kind: 'task'; task: TeamConversation }

function unitKey(unit: Unit) {
  if (unit.kind === 'stopped') return `stopped:${unit.group.cause}`
  return unit.kind === 'decision' ? unit.decision.entryId : unit.task.epochId
}

/**
 * Several tasks stopped on one setting become a single fix and lead the board; the one being
 * answered stays in front while it is open. Everything else keeps its order.
 */
function arrange(detail: TeamDetail, decisions: readonly TeamPendingEscalation[], attention: readonly TeamConversation[], answeringId: string | null): Unit[] {
  const byCause = new Map<FailureCause, StoppedGroup>()
  for (const task of attention) {
    const hit = settingsFailure(detail, task)
    if (!hit) continue
    const group = byCause.get(hit.cause) ?? { cause: hit.cause, tasks: [], members: [] }
    group.tasks.push({ task, member: hit.member })
    if (!group.members.includes(hit.member)) group.members.push(hit.member)
    byCause.set(hit.cause, group)
  }
  const groups = [...byCause.values()].filter(group => group.tasks.length > 1)
  const grouped = new Set(groups.flatMap(group => group.tasks.map(item => item.task.epochId)))
  const rest: Unit[] = [
    ...decisions.map(decision => ({ kind: 'decision' as const, decision })),
    ...attention.filter(task => !grouped.has(task.epochId)).map(task => ({ kind: 'task' as const, task })),
  ]
  const answering = rest.find(unit => unit.kind === 'decision' && unit.decision.entryId === answeringId)
  return [
    ...(answering ? [answering] : []),
    ...groups.map(group => ({ kind: 'stopped' as const, group })),
    ...rest.filter(unit => unit !== answering),
  ]
}

function stoppedTitle(group: StoppedGroup, t: TFunction) {
  const count = group.tasks.length
  if (group.cause === 'account') return t('{{count}} tasks stopped: model account rejected', { count })
  if (group.cause === 'quota') return t('{{count}} tasks stopped: model quota or rate limit hit', { count })
  return t('{{count}} tasks stopped: model no longer available', { count })
}

function subtaskText(task: TeamConversation, t: TFunction) {
  const { subtasks } = task
  return subtasks && subtasks.done + subtasks.open ? t('{{done}}/{{total}} subtasks', { done: subtasks.done, total: subtasks.done + subtasks.open }) : null
}

function taskMeta(detail: TeamDetail, task: TeamConversation, t: TFunction) {
  return [taskTitle(detail, task, t), subtaskText(task, t)].filter(Boolean).join(' · ')
}

/** What is waiting on the user across the team: the first thing in full, the rest one line each. */
export function NeedsYou({ detail, tasks, pending, attention, taskSpaceId, onOpenTask, onOpenMembers }: {
  detail: TeamDetail; tasks: readonly TeamConversation[]; pending: TeamPendingEscalation[]; attention: TeamConversation[]
  taskSpaceId: string | null; onOpenTask: (epochId: string) => void
  /** Several members' models need changing: the members page lists them first. */
  onOpenMembers: () => void
}) {
  const { t, i18n } = useTranslation()
  const { decisions, answeringId, setAnswering } = useHeldDecisions(pending)
  if (!decisions.length && !attention.length) return null

  const units = arrange(detail, decisions, attention, answeringId)
  const [first, ...rest] = units
  const changeModel = (members: RosterMember[]) => members.length === 1 ? openPersonModelSettings(members[0].appId) : onOpenMembers()
  const names = (members: RosterMember[]) => {
    const list = members.map(member => member.memberName)
    try {
      return new Intl.ListFormat(i18n.language, { style: 'long', type: 'conjunction' }).format(list)
    } catch {
      return list.join(', ')
    }
  }

  const full = (unit: Unit) => {
    if (unit.kind === 'stopped') return <StoppedCard detail={detail} group={unit.group} names={names(unit.group.members)} onChangeModel={() => changeModel(unit.group.members)} onOpenTask={onOpenTask} />
    if (unit.kind === 'decision') {
      const { decision } = unit
      return <DecisionCard flat detail={detail} decision={decision} task={tasks.find(task => task.epochId === decision.epochId)} taskSpaceId={taskSpaceId}
        open={answeringId === decision.entryId} onOpen={open => setAnswering(open ? decision : null)} onOpenTask={onOpenTask} />
    }
    const state = taskState(detail, unit.task)
    return <div className={`flex items-start gap-2 rounded-[15px] ${toneSurface(state.key === 'error' ? 'error' : 'attention')} px-3.5 py-3`}>
      <StateIcon state={state.key} className="mt-[3px]" />
      <div className="min-w-0 flex-1">
        <p className="line-clamp-3 break-words text-[14.5px] leading-6">{factText(state.key, state.fact, detail.roster, t)}</p>
        <p className="mt-0.5 truncate text-[12.5px] text-faint-foreground">{taskMeta(detail, unit.task, t)}</p>
        <button onClick={() => onOpenTask(unit.task.epochId)} className={`mt-3 ${PILL_ON_TINT}`}>{t('View task')}</button>
      </div>
    </div>
  }

  const line = (unit: Unit) => {
    if (unit.kind === 'stopped') {
      return <NeedsRow key={unitKey(unit)} state="error" title={stoppedTitle(unit.group, t)} meta={names(unit.group.members)}
        action={t('Change model')} onClick={() => changeModel(unit.group.members)} />
    }
    if (unit.kind === 'decision') {
      const { decision } = unit
      const task = tasks.find(item => item.epochId === decision.epochId)
      return <NeedsRow key={unitKey(unit)} state="waiting_user" title={decision.question} meta={[decision.memberName, task ? taskTitle(detail, task, t) : null].filter(Boolean).join(' · ')}
        action={t('Reply')} onClick={() => setAnswering(decision)} />
    }
    const state = taskState(detail, unit.task)
    return <NeedsRow key={unitKey(unit)} state={state.key} title={factText(state.key, state.fact, detail.roster, t)} meta={taskMeta(detail, unit.task, t)}
      action={t('View')} onClick={() => onOpenTask(unit.task.epochId)} />
  }

  return <section className="mb-7">
    <SectionHeading title={t('Needs you')} count={decisions.length + attention.length} />
    {full(first)}
    {rest.length > 0 && <div className="mt-2.5 rounded-[15px] bg-secondary/50 p-1">{rest.map(line)}</div>}
  </section>
}

function StoppedCard({ detail, group, names, onChangeModel, onOpenTask }: {
  detail: TeamDetail; group: StoppedGroup; names: string; onChangeModel: () => void; onOpenTask: (epochId: string) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return <div className={`flex items-start gap-2 rounded-[15px] ${toneSurface('error')} px-3.5 py-3`}>
    <StateIcon state="error" className="mt-[3px]" />
    <div className="min-w-0 flex-1">
      <p className="break-words text-[14.5px] leading-6">{stoppedTitle(group, t)}</p>
      <p className="mt-0.5 truncate text-[12.5px] text-faint-foreground">{t('Model used by {{names}}', { names })}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button onClick={onChangeModel} className={PILL_PRIMARY}>{t('Change model')}</button>
        <button onClick={() => setOpen(!open)} aria-expanded={open} className={`${PILL_ON_TINT} gap-1`}>
          {t('{{count}} tasks involved', { count: group.tasks.length })}
          <ChevronDown size={13} aria-hidden="true" className={`text-faint-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>
      {open && <div className="mt-2.5 rounded-[11px] bg-background/70 p-0.5">
        {group.tasks.map(({ task, member }) => <NeedsRow key={task.epochId} title={taskTitle(detail, task, t)} meta={[member.memberName, subtaskText(task, t)].filter(Boolean).join(' · ')}
          action={t('View')} onClick={() => onOpenTask(task.epochId)} hover="hover:bg-background" />)}
      </div>}
    </div>
  </div>
}

function NeedsRow({ state, title, meta, action, onClick, hover = 'hover:bg-secondary' }: {
  state?: TaskStateKey; title: string; meta?: string; action: string; onClick: () => void; hover?: string
}) {
  return <button onClick={onClick} className={`flex h-10 w-full min-w-0 items-center gap-2 rounded-[11px] px-2.5 text-left transition-colors ${hover} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary`}>
    {state && <StateIcon state={state} />}
    <span className="min-w-0 flex-1 truncate text-[13.5px] text-foreground sm:max-w-[60%] sm:flex-none">{title}</span>
    {meta && <span className="hidden min-w-0 flex-1 truncate text-[12.5px] text-faint-foreground sm:block">{meta}</span>}
    <span className="ml-auto inline-flex shrink-0 items-center text-[12.5px] text-subtle-foreground">{action}<ChevronRight size={13} aria-hidden="true" /></span>
  </button>
}
