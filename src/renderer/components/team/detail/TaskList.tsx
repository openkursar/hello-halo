import { useMemo, useReducer, useState, type ReactNode } from 'react'
import { CalendarClock, Check, ChevronDown, Loader2, Search, X } from 'lucide-react'
import type { TeamConversation, TeamDetail, TeamPendingEscalation } from '../../../../shared/apps/team-types'
import { useTranslation } from '../../../i18n'
import { useTeamStore } from '../../../stores/team.store'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/Popover'
import { toneSurface } from '../workbench/task-brief'
import { useRecentTalk } from './crew-ui'
import { DecisionCard, useHeldDecisions } from './DecisionCard'
import { isMoving, isTeamWork, needsUser, sortByState, taskState } from './status'
import { factText, matchesSource, PILL_ON_TINT, SectionHeading, sourceLabel, StateIcon, TaskRow, taskTitle, type TaskSource } from './task-ui'

export interface TaskFilters { query: string; source: TaskSource | 'all' }

export const NO_TASK_FILTERS: TaskFilters = { query: '', source: 'all' }

const SOURCES: (TaskSource | 'all')[] = ['all', 'mine', 'involved', 'scheduled', 'im', 'others']
const DONE_PREVIEW = 10

type Fold = 'moving' | 'stopped' | 'done' | 'chats'
const OPEN_BY_DEFAULT: Record<Fold, boolean> = { moving: true, stopped: true, done: true, chats: false }
/** Sections the user folded, kept per team for this session. */
const folds = new Map<string, Record<Fold, boolean>>()

function useFolds(teamId: string) {
  const [, refresh] = useReducer((count: number) => count + 1, 0)
  const open = folds.get(teamId) ?? OPEN_BY_DEFAULT
  const toggle = (fold: Fold) => { folds.set(teamId, { ...open, [fold]: !open[fold] }); refresh() }
  return { open, toggle }
}

export function TaskList({ wide, detail, tasks, taskSpaceId, filters, onFilters, selectedId, loading, error, onOpenTask, onOpenSettings, focused = false }: {
  wide: boolean
  /** A task or member panel is open, so the "Needs you" board steps aside; every task keeps its own group either way. */
  focused?: boolean
  detail: TeamDetail
  tasks: readonly TeamConversation[]
  taskSpaceId: string | null
  filters: TaskFilters
  onFilters: (filters: TaskFilters) => void
  selectedId: string | null
  loading: boolean
  error: string | null
  onOpenTask: (epochId: string) => void
  onOpenSettings: () => void
}) {
  const { t } = useTranslation()
  const { open, toggle } = useFolds(detail.team.id)
  const [allDone, setAllDone] = useState(false)
  const [sourceOpen, setSourceOpen] = useState(false)
  const query = filters.query.trim().toLocaleLowerCase()
  const pending = useMemo(() => [...(detail.pendingEscalations ?? [])].sort((a, b) => (a.entry?.ts ?? 0) - (b.entry?.ts ?? 0)), [detail.pendingEscalations])
  const attention = useMemo(() => tasks.filter(task => {
    const key = taskState(detail, task).key
    if (key === 'waiting_user') return !pending.some(item => item.epochId === task.epochId)
    return key === 'error' && (task.createdByMe || task.involvedMe)
  }), [pending, detail, tasks])
  const filtered = useMemo(() => tasks.filter(task => matchesSource(task, filters.source)
    && (!query || [taskTitle(detail, task, t), task.label, task.workItemId, task.epochId].some(value => value?.toLocaleLowerCase().includes(query)))
  ), [detail, filters.source, query, tasks, t])
  const groups = useMemo(() => {
    const sorted = sortByState(detail, filtered)
    const moving: TeamConversation[] = []
    const stopped: TeamConversation[] = []
    const done: TeamConversation[] = []
    const chats: TeamConversation[] = []
    let chatRunning = false
    for (const task of sorted) {
      const key = taskState(detail, task).key
      if (!isTeamWork(task) && !needsUser(key)) {
        chats.push(task)
        chatRunning ||= isMoving(key)
      } else if (isMoving(key)) moving.push(task)
      else if (key === 'done') done.push(task)
      else stopped.push(task)
    }
    done.sort((a, b) => (b.finishedAt ?? b.lastActivityAt) - (a.finishedAt ?? a.lastActivityAt))
    return { sorted, moving, stopped, done, chats, chatRunning }
  }, [detail, filtered])
  const searching = query !== ''
  const filtering = searching || filters.source !== 'all'
  const shownDone = allDone ? groups.done : groups.done.slice(0, DONE_PREVIEW)
  const recent = useRecentTalk(detail.activities)
  const crew = useMemo(() => ({ recent, cap: wide ? 4 : 3, size: wide ? 24 : 22 }), [recent, wide])
  const rows = (items: TeamConversation[]) => items.map(task => <TaskRow key={task.epochId} detail={detail} task={task} selected={selectedId === task.epochId} crew={crew} onOpen={() => onOpenTask(task.epochId)} />)

  if (!tasks.length && !loading && !error) return <EmptyTeam onOpenSettings={onOpenSettings} />

  // Rows here are separated by spacing alone; the shared hairline stays for other lists.
  return <div className="[&_.task-row]:before:hidden">
    {!focused && <NeedsYou detail={detail} tasks={tasks} pending={pending} attention={attention} taskSpaceId={taskSpaceId} onOpenTask={onOpenTask} />}
    <div className={`flex items-center ${wide ? 'gap-4' : 'gap-2'}`}>
    <label className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-full bg-secondary px-3.5 focus-within:ring-2 focus-within:ring-primary">
      <Search size={15} className="shrink-0 text-faint-foreground" aria-hidden="true" />
      <input value={filters.query} onChange={event => onFilters({ ...filters, query: event.target.value })} type="search" placeholder={t('Search tasks')} aria-label={t('Search tasks')} className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-faint-foreground [&::-webkit-search-cancel-button]:hidden" />
      {filters.query && <button onClick={() => onFilters({ ...filters, query: '' })} aria-label={t('Clear search')} className="rounded-full p-0.5 text-faint-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><X size={14} /></button>}
    </label>
    <div className="shrink-0">
      <Popover open={sourceOpen} onOpenChange={setSourceOpen}>
        <PopoverTrigger ariaLabel={t('Task source')} className={`h-7 items-center gap-1 rounded-full px-3 text-[12.5px] transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${filters.source === 'all' ? 'text-subtle-foreground' : 'bg-secondary text-foreground'}`}>
          {sourceLabel(filters.source, t)}<ChevronDown size={13} aria-hidden="true" />
        </PopoverTrigger>
        <PopoverContent align="end" sideOffset={6} className="w-44 p-1">
          {SOURCES.map(value => <button key={value} onClick={() => { onFilters({ ...filters, source: value }); setSourceOpen(false) }} className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
            <span className="min-w-0 flex-1 truncate">{sourceLabel(value, t)}</span>
            {filters.source === value && <Check size={13} className="shrink-0 text-primary" aria-hidden="true" />}
          </button>)}
        </PopoverContent>
      </Popover>
    </div>
    </div>

    {error && <p role="alert" className="mt-4 rounded-xl bg-destructive/10 px-3 py-2 text-[13px] text-destructive">{error} <button onClick={() => void useTeamStore.getState().loadConversations(detail.team.id)} className="underline">{t('Retry')}</button></p>}
    {loading && !tasks.length && <p role="status" className="flex items-center justify-center gap-2 py-10 text-[13px] text-faint-foreground"><Loader2 size={14} className="animate-spin" aria-hidden="true" />{t('Loading tasks…')}</p>}
    {!loading && !filtered.length && <div className="py-10 text-center text-[13px] text-faint-foreground">
      <p>{tasks.length ? t('No matching tasks.') : t('No tasks yet.')}</p>
      {filtering && <button onClick={() => onFilters(NO_TASK_FILTERS)} className="mt-2 text-subtle-foreground underline hover:text-foreground">{t('Clear filters')}</button>}
    </div>}

    {searching ? <div className="mt-6">{rows(groups.sorted)}</div> : <div className="mt-6 space-y-7">
      {groups.moving.length > 0 && <section>
        <GroupToggle title={t('In progress')} count={groups.moving.length} open={open.moving} onToggle={() => toggle('moving')} />
        {open.moving && rows(groups.moving)}
      </section>}
      {groups.stopped.length > 0 && <section>
        <GroupToggle title={t('Stopped partway')} count={groups.stopped.length} open={open.stopped} onToggle={() => toggle('stopped')} />
        {open.stopped && rows(groups.stopped)}
      </section>}
      {groups.done.length > 0 && <section>
        <GroupToggle title={t('Completed')} count={groups.done.length} open={open.done} onToggle={() => toggle('done')} />
        {open.done && rows(shownDone)}
        {open.done && groups.done.length > shownDone.length && <button onClick={() => setAllDone(true)} className="mt-1 h-8 rounded px-0.5 text-[13px] text-subtle-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
          {t('View {{count}} earlier', { count: groups.done.length - shownDone.length })}
        </button>}
      </section>}
      {groups.chats.length > 0 && <section>
        <GroupToggle title={t('Q&A')} count={groups.chats.length} open={open.chats} onToggle={() => toggle('chats')}>
          {groups.chatRunning && !open.chats && <StateIcon state="running" className="self-center" />}
        </GroupToggle>
        {open.chats && rows(groups.chats)}
      </section>}
    </div>}
  </div>
}

/** What is waiting on the user across the team: questions answered in place, then tasks that stopped on something. */
function NeedsYou({ detail, tasks, pending, attention, taskSpaceId, onOpenTask }: {
  detail: TeamDetail; tasks: readonly TeamConversation[]; pending: TeamPendingEscalation[]; attention: TeamConversation[]
  taskSpaceId: string | null; onOpenTask: (epochId: string) => void
}) {
  const { t } = useTranslation()
  const { decisions, answeringId, setAnswering } = useHeldDecisions(pending)
  if (!decisions.length && !attention.length) return null
  return <section className="mb-7">
    <SectionHeading title={t('Needs you')} count={pending.length + attention.length} />
    <div className="space-y-2.5">
      {decisions.map(item => <DecisionCard key={item.entryId} detail={detail} decision={item} task={tasks.find(task => task.epochId === item.epochId)} taskSpaceId={taskSpaceId}
        open={answeringId === item.entryId} onOpen={open => setAnswering(open ? item : null)} onOpenTask={onOpenTask} />)}
      {attention.map(task => {
        const state = taskState(detail, task)
        const failed = state.key === 'error'
        const subtasks = task.subtasks ? task.subtasks.done + task.subtasks.open : 0
        const meta = [taskTitle(detail, task, t), subtasks ? t('{{done}}/{{total}} subtasks', { done: task.subtasks!.done, total: subtasks }) : null].filter(Boolean).join(' · ')
        return <div key={task.epochId} className={`flex items-start gap-2 rounded-[15px] border ${toneSurface(failed ? 'error' : 'attention')} px-3.5 py-3`}>
          <StateIcon state={state.key} className="mt-[3px]" />
          <div className="min-w-0 flex-1">
            <p className="line-clamp-3 break-words text-[14.5px] leading-6">{factText(state.key, state.fact, t)}</p>
            <p className="mt-0.5 truncate text-[12.5px] text-faint-foreground">{meta}</p>
            <button onClick={() => onOpenTask(task.epochId)} className={`mt-3 ${PILL_ON_TINT}`}>{t('View task')}</button>
          </div>
        </div>
      })}
    </div>
  </section>
}

function GroupToggle({ title, count, open, onToggle, children }: { title: string; count: number; open: boolean; onToggle: () => void; children?: ReactNode }) {
  return <button onClick={onToggle} aria-expanded={open} className="mb-1.5 ml-0.5 flex items-baseline gap-1.5 text-[13px] font-medium text-foreground/85 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
    {title}<span className="tabular-nums text-faint-foreground">{count}</span>
    {children}
    <ChevronDown size={13} aria-hidden="true" className={`self-center text-faint-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
  </button>
}

function EmptyTeam({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useTranslation()
  return <div className="flex flex-col items-center pt-10 text-center">
    <h2 className="text-[19px] font-semibold">{t('The team is ready, with no tasks yet')}</h2>
    <p className="mt-2 max-w-sm text-[13px] leading-6 text-subtle-foreground">{t('Use “Start task” at the top right to give it its first task.')}</p>
    <button onClick={onOpenSettings} className="mt-8 flex w-full max-w-sm items-start gap-3 rounded-2xl border border-border-soft bg-card p-4 text-left transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
      <CalendarClock size={18} className="mt-0.5 shrink-0 text-subtle-foreground" aria-hidden="true" />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{t('Scheduled check')}</span>
        <span className="mt-0.5 block text-[12.5px] text-faint-foreground">{t('Let the team run on a schedule, with no one starting it.')}</span>
      </span>
    </button>
  </div>
}
