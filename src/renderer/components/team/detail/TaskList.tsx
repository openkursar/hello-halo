import { useCallback, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import { CalendarClock, Check, ChevronDown, Loader2, Search, X } from 'lucide-react'
import type { TeamActivity, TeamConversation, TeamDetail } from '../../../../shared/apps/team-types'
import { useTranslation } from '../../../i18n'
import { useTeamStore } from '../../../stores/team.store'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/Popover'
import { useRecentTalk } from './crew-ui'
import { NeedsYou } from './NeedsYou'
import { isMoving, isTeamWork, needsUser, sortByState, taskStates } from './status'
import { matchesSource, MoreToggle, sourceLabel, StateIcon, TaskRow, taskTitle, type TaskSource } from './task-ui'

export interface TaskFilters { query: string; source: TaskSource | 'all' }

export const NO_TASK_FILTERS: TaskFilters = { query: '', source: 'all' }

/** Who started the work and which channel it came through are separate questions, so each gets its own group. */
const SOURCE_GROUPS: (TaskSource | 'all')[][] = [['all'], ['mine', 'involved', 'others'], ['scheduled', 'im']]
const PREVIEW = 10
/** Each "more" click mounts at most this many rows, so a long history never lands in one frame. */
const STEP = 20

type Fold = 'yours' | 'moving' | 'others' | 'stopped' | 'done' | 'chats'
const OPEN_BY_DEFAULT: Record<Fold, boolean> = { yours: true, moving: true, others: true, stopped: true, done: true, chats: false }
/** Sections the user folded, kept per team for this session. */
const folds = new Map<string, Record<Fold, boolean>>()
const NO_TALK: readonly TeamActivity[] = []

/**
 * Recent exchanges split by task. A task whose own exchanges did not change keeps
 * the same array, so its row is not redrawn by talk in another task.
 */
function useTalkByTask(recent: readonly TeamActivity[]): ReadonlyMap<string, readonly TeamActivity[]> {
  const previous = useRef<ReadonlyMap<string, readonly TeamActivity[]>>(new Map())
  return useMemo(() => {
    const next = new Map<string, TeamActivity[]>()
    for (const activity of recent) {
      const list = next.get(activity.epochId)
      if (list) list.push(activity)
      else next.set(activity.epochId, [activity])
    }
    const kept = new Map<string, readonly TeamActivity[]>()
    for (const [epochId, list] of next) {
      const old = previous.current.get(epochId)
      kept.set(epochId, old && old.length === list.length && old.every((row, index) => row === list[index]) ? old : list)
    }
    previous.current = kept
    return kept
  }, [recent])
}

function useFolds(teamId: string) {
  const [, refresh] = useReducer((count: number) => count + 1, 0)
  const open = folds.get(teamId) ?? OPEN_BY_DEFAULT
  const toggle = (fold: Fold) => { folds.set(teamId, { ...open, [fold]: !open[fold] }); refresh() }
  return { open, toggle }
}

export function TaskList({ wide, detail, tasks, taskSpaceId, filters, onFilters, selectedId, loading, error, onOpenTask, onOpenSettings, onOpenMembers, focused = false }: {
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
  onOpenMembers: () => void
}) {
  const { t } = useTranslation()
  const { open, toggle } = useFolds(detail.team.id)
  const [sourceOpen, setSourceOpen] = useState(false)
  const query = filters.query.trim().toLocaleLowerCase()
  const pending = useMemo(() => [...(detail.pendingEscalations ?? [])].sort((a, b) => (a.entry?.ts ?? 0) - (b.entry?.ts ?? 0)), [detail.pendingEscalations])
  // Each task's state is read for the attention board, the sort and the grouping; work it out once.
  const states = useMemo(() => taskStates(detail, tasks), [detail, tasks])
  const attention = useMemo(() => tasks.filter(task => {
    const key = states.get(task.epochId)!.key
    if (key === 'waiting_user') return !pending.some(item => item.epochId === task.epochId)
    return key === 'error' && (task.createdByMe || task.involvedMe)
  }), [pending, states, tasks])
  const filtered = useMemo(() => tasks.filter(task => matchesSource(task, filters.source)
    && (!query || [taskTitle(detail, task, t), task.label, task.workItemId, task.epochId].some(value => value?.toLocaleLowerCase().includes(query)))
  ), [detail, filters.source, query, tasks, t])
  const groups = useMemo(() => {
    const sorted = sortByState(detail, filtered, states)
    const yours: TeamConversation[] = []
    const moving: TeamConversation[] = []
    const others: TeamConversation[] = []
    const stopped: TeamConversation[] = []
    const done: TeamConversation[] = []
    const chats: TeamConversation[] = []
    let chatRunning = false
    for (const task of sorted) {
      const key = states.get(task.epochId)!.key
      if (!isTeamWork(task) && !needsUser(key)) {
        chats.push(task)
        chatRunning ||= isMoving(key)
      } else if (key === 'waiting_user') yours.push(task)
      else if (key === 'running') moving.push(task)
      else if (key === 'waiting_member') others.push(task)
      else if (key === 'done') done.push(task)
      else stopped.push(task)
    }
    done.sort((a, b) => (b.finishedAt ?? b.lastActivityAt) - (a.finishedAt ?? a.lastActivityAt))
    return { sorted, yours, moving, others, stopped, done, chats, chatRunning }
  }, [detail, filtered, states])
  const searching = query !== ''
  const filtering = searching || filters.source !== 'all'
  const talk = useTalkByTask(useRecentTalk(detail.activities))
  const cap = wide ? 4 : 3
  const size = wide ? 24 : 22
  // One opener for every row, so a memoised row is not redrawn for a new closure.
  const latestOpen = useRef(onOpenTask)
  latestOpen.current = onOpenTask
  const openTask = useCallback((epochId: string) => latestOpen.current(epochId), [])
  const rows = (items: TeamConversation[]) => items.map(task => <TaskRow key={task.epochId} detail={detail} task={task} selected={selectedId === task.epochId}
    crew={{ recent: talk.get(task.epochId) ?? NO_TALK, cap, size }} onOpen={openTask} />)

  if (!tasks.length && !loading && !error) return <EmptyTeam onOpenSettings={onOpenSettings} />

  // Rows here are separated by spacing alone; the shared hairline stays for other lists.
  return <div className="[&_.task-row]:before:hidden">
    {!focused && <NeedsYou detail={detail} tasks={tasks} pending={pending} attention={attention} taskSpaceId={taskSpaceId} onOpenTask={onOpenTask} onOpenMembers={onOpenMembers} />}
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
        <PopoverContent align="end" sideOffset={6} className="w-44 space-y-2 p-1">
          {SOURCE_GROUPS.map(group => <div key={group[0]}>
            {group.map(value => <button key={value} onClick={() => { onFilters({ ...filters, source: value }); setSourceOpen(false) }} className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
              <span className="min-w-0 flex-1 truncate">{sourceLabel(value, t)}</span>
              {filters.source === value && <Check size={13} className="shrink-0 text-primary" aria-hidden="true" />}
            </button>)}
          </div>)}
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
      {groups.yours.length > 0 && <section>
        <GroupToggle title={t('Awaiting your confirmation')} count={groups.yours.length} open={open.yours} onToggle={() => toggle('yours')} />
        {open.yours && rows(groups.yours)}
      </section>}
      {groups.moving.length > 0 && <section>
        <GroupToggle title={t('In progress')} count={groups.moving.length} open={open.moving} onToggle={() => toggle('moving')} />
        {open.moving && rows(groups.moving)}
      </section>}
      {groups.others.length > 0 && <section>
        <GroupToggle title={t('Waiting on others')} count={groups.others.length} open={open.others} onToggle={() => toggle('others')} />
        {open.others && rows(groups.others)}
      </section>}
      {/* Quiet work with nothing left open shares this group, so its heading claims no more than that nothing runs; each row says why it stopped. */}
      {groups.stopped.length > 0 && <SteppedGroup teamId={detail.team.id} title={t('Not in progress')} items={groups.stopped} open={open.stopped} onToggle={() => toggle('stopped')} rows={rows}
        moreLabel={count => t('View {{count}} more', { count })} />}
      {/* A whole column of finished work stays quieter than the live groups above it. */}
      {groups.done.length > 0 && <SteppedGroup teamId={detail.team.id} title={t('Completed')} items={groups.done} open={open.done} onToggle={() => toggle('done')} rows={rows}
        moreLabel={count => t('View {{count}} earlier', { count })} className="[&_[data-done]]:opacity-[.55]" />}
      {groups.chats.length > 0 && <section>
        <GroupToggle title={t('Q&A')} count={groups.chats.length} open={open.chats} onToggle={() => toggle('chats')}>
          {groups.chatRunning && !open.chats && <StateIcon state="running" className="self-center" />}
        </GroupToggle>
        {open.chats && rows(groups.chats)}
      </section>}
    </div>}
  </div>
}

/** A long group shows its first rows and opens the rest a step at a time. */
function SteppedGroup({ teamId, title, items, open, onToggle, rows, moreLabel, className }: {
  teamId: string
  title: string
  items: TeamConversation[]
  open: boolean
  onToggle: () => void
  rows: (items: TeamConversation[]) => ReactNode
  moreLabel: (count: number) => string
  className?: string
}) {
  const { t } = useTranslation()
  const [shown, setShown] = useState({ teamId, limit: PREVIEW })
  const limit = shown.teamId === teamId ? shown.limit : PREVIEW
  const left = Math.max(0, items.length - limit)
  const ref = useRef<HTMLElement>(null)
  return <section ref={ref} className={className}>
    <GroupToggle title={title} count={items.length} open={open} onToggle={onToggle} />
    {open && rows(items.slice(0, limit))}
    {open && left > 0 && <MoreToggle onClick={() => setShown({ teamId, limit: limit + STEP })}>{moreLabel(Math.min(STEP, left))}</MoreToggle>}
    {open && left === 0 && items.length > PREVIEW && <MoreToggle up onClick={() => {
      setShown({ teamId, limit: PREVIEW })
      // Collapsing removes rows above the viewport; bring the group back instead of leaving the user far below it.
      requestAnimationFrame(() => ref.current?.scrollIntoView({ block: 'nearest' }))
    }}>{t('Show less')}</MoreToggle>}
  </section>
}

function GroupToggle({ title, count, open, onToggle, children }: { title: string; count: number; open: boolean; onToggle: () => void; children?: ReactNode }) {
  return <button onClick={onToggle} aria-expanded={open} className="mb-1.5 ml-0.5 flex items-baseline gap-1.5 text-[13px] font-medium text-foreground/85 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
    {title}<span className="tabular-nums text-faint-foreground">{count}</span>
    {children}
    <ChevronDown size={13} aria-hidden="true" className={`self-center text-faint-foreground transition-transform ${open ? '' : '-rotate-90'}`} />
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
