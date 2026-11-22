import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, FolderOpen, Loader2, MoreHorizontal, Search, X } from 'lucide-react'
import type { TFunction } from 'i18next'
import type { TeamConversation, TeamDetail, TeamOutput, TeamOutputFilter } from '../../../../shared/apps/team-types'
import { parseSpaceCoordinatorAppId, TEAM_OUTPUT_TEXT_EPOCHS_MAX } from '../../../../shared/apps/team-types'
import { api } from '../../../api'
import { useDebouncedValue } from '../../../hooks/useDebouncedValue'
import { useTranslation } from '../../../i18n'
import { formatRunStart } from '../../../utils/format-time'
import { FileIcon } from '../../icons/ToolIcons'
import { ContextMenu } from '../../ui/ContextMenu'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/Popover'
import { useOpenTeamArtifact, useRevealTeamArtifact } from '../TeamArtifacts'
import { mergeOutputs, OUTPUT_RANGES, outputGroups, outputKey, rangeStart, type OutputPeriod, type OutputRange } from './outputs'
import { PanelBar } from './PanelBar'
import { SectionHeading, taskTitle } from './task-ui'

const PAGE_SIZE = 30

type Status = 'loading' | 'ready' | 'failed'

/** Every file the team produced, newest first, read a page at a time as the reader scrolls; narrowed by time and text on the server. */
export function OutputsPanel({ detail, tasks, docked, onOpenTask, onClose }: {
  detail: TeamDetail
  tasks: readonly TeamConversation[]
  docked: boolean
  onOpenTask: (epochId: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const teamId = detail.team.id
  const [outputs, setOutputs] = useState<TeamOutput[]>([])
  const [total, setTotal] = useState<number | null>(null)
  const [status, setStatus] = useState<Status>('loading')
  // The count belongs to the filter it was listed under; a newer filter hides it until its own arrives.
  const [counted, setCounted] = useState(false)
  const [query, setQuery] = useState('')
  const [range, setRange] = useState<OutputRange>('all')
  const [rangeOpen, setRangeOpen] = useState(false)
  const text = useDebouncedValue(query.trim(), 250)
  const offset = useRef(0)
  const busy = useRef(false)
  // A newer filter supersedes a listing still in flight.
  const generation = useRef(0)
  const filter = useRef<TeamOutputFilter>({})
  const stale = useRef(true)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const endRef = useRef<HTMLDivElement | null>(null)
  const open = useOpenTeamArtifact(teamId)
  const reveal = useRevealTeamArtifact(teamId)
  // Remote clients download on click and have no file manager to show.
  const desktop = !api.isRemoteMode()
  const titles = useRef({ detail, tasks, t })
  useEffect(() => { titles.current = { detail, tasks, t } })

  const load = useCallback(async (reset: boolean) => {
    if (!reset && busy.current) return
    const run = reset ? ++generation.current : generation.current
    const from = reset ? 0 : offset.current
    busy.current = true
    setStatus('loading')
    if (reset) setCounted(false)
    try {
      const res = await api.teamListOutputs(teamId, from, PAGE_SIZE, filter.current)
      if (run !== generation.current) return
      if (!res.success || !res.data) throw new Error(res.error ?? 'rejected')
      const page = res.data
      offset.current = from + page.outputs.length
      setOutputs(current => reset ? page.outputs : mergeOutputs(current, page.outputs))
      setTotal(page.total)
      setCounted(true)
      stale.current = false
      setStatus('ready')
    } catch (err) {
      if (run !== generation.current) return
      console.warn('[OutputsPanel] listing failed', { teamId, offset: from, err })
      setStatus('failed')
    } finally {
      if (run === generation.current) busy.current = false
    }
  }, [teamId])

  useEffect(() => {
    // Task titles live in the renderer, so title matches travel to the server as task ids.
    const { detail: currentDetail, tasks: currentTasks, t: translate } = titles.current
    const needle = text.toLocaleLowerCase()
    const textEpochIds = needle
      ? currentTasks.filter(task => taskTitle(currentDetail, task, translate).toLocaleLowerCase().includes(needle)).slice(0, TEAM_OUTPUT_TEXT_EPOCHS_MAX).map(task => task.epochId)
      : undefined
    filter.current = { since: rangeStart(range), text: text || undefined, textEpochIds }
    stale.current = true
    void load(true)
  }, [text, range, load])

  const more = status === 'ready' && total !== null && offset.current < total
  useEffect(() => {
    const end = endRef.current
    if (!more || !end) return
    const observer = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) void load(false) }, { root: scrollRef.current, rootMargin: '240px' })
    observer.observe(end)
    return () => observer.disconnect()
  }, [more, load, outputs.length])

  const byEpoch = useMemo(() => new Map(tasks.map(task => [task.epochId, task])), [tasks])
  const groups = useMemo(() => outputGroups(outputs), [outputs])
  const filtering = text !== '' || range !== 'all'
  const clearFilters = () => { setQuery(''); setRange('all') }

  return <div className="flex h-full min-h-0 flex-col">
    <PanelBar docked={docked} onBack={onClose} onClose={onClose} />
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
      <div className="px-5 pb-10 pt-3 sm:px-6">
        <h2 className="mb-3 flex items-baseline gap-2 text-[18px] font-semibold leading-7">
          {t('Outputs')}{counted && total !== null && total > 0 && <span className="text-[13px] font-normal tabular-nums text-faint-foreground">
            {filtering ? t('{{count}} found', { count: total }) : t('{{count}} in all', { count: total })}
          </span>}
        </h2>
        {(filtering || query !== '' || (total ?? 0) > 0) && <div className="mb-5 flex items-center gap-2">
          <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-full bg-secondary px-3.5 focus-within:ring-2 focus-within:ring-primary">
            <Search size={15} className="shrink-0 text-faint-foreground" aria-hidden="true" />
            <input value={query} onChange={event => setQuery(event.target.value)} type="search" placeholder={t('Search outputs')} aria-label={t('Search outputs')} className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-faint-foreground [&::-webkit-search-cancel-button]:hidden" />
            {query && <button onClick={() => setQuery('')} aria-label={t('Clear search')} className="rounded-full p-0.5 text-faint-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><X size={14} /></button>}
          </label>
          <div className="shrink-0">
            <Popover open={rangeOpen} onOpenChange={setRangeOpen}>
              <PopoverTrigger ariaLabel={t('Time range')} className={`h-7 items-center gap-1 rounded-full px-3 text-[12.5px] transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${range === 'all' ? 'text-subtle-foreground' : 'bg-secondary text-foreground'}`}>
                {rangeLabel(range, t)}<ChevronDown size={13} aria-hidden="true" />
              </PopoverTrigger>
              <PopoverContent align="end" sideOffset={6} className="w-36 p-1">
                {OUTPUT_RANGES.map(value => <button key={value} onClick={() => { setRange(value); setRangeOpen(false) }} className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                  <span className="min-w-0 flex-1 truncate">{rangeLabel(value, t)}</span>
                  {range === value && <Check size={13} className="shrink-0 text-primary" aria-hidden="true" />}
                </button>)}
              </PopoverContent>
            </Popover>
          </div>
        </div>}
        {total === 0 && status === 'ready' && (filtering ? <div className="py-10 text-center text-[13px] text-faint-foreground">
          <p>{t('No matching outputs.')}</p>
          <button onClick={clearFilters} className="mt-2 text-subtle-foreground underline hover:text-foreground">{t('Clear filters')}</button>
        </div> : <div className="py-10 text-center">
          <p className="text-[13.5px] font-medium text-foreground">{t('No delivered files yet')}</p>
          <p className="mx-auto mt-1 max-w-xs text-[12.5px] leading-5 text-faint-foreground">{t('When the team finishes tasks, the documents, sheets and images it produces appear here.')}</p>
        </div>)}
        <div className="space-y-6">
          {groups.map(group => <section key={group.key}>
            <SectionHeading title={periodLabel(group.period, t)} />
            <div className="-mx-2">
              {group.outputs.map(output => {
                const task = byEpoch.get(output.epochId)
                return <OutputRow key={outputKey(output)} output={output} taskLabel={task ? taskTitle(detail, task, t) : null}
                  onOpen={() => void open({ name: output.name, path: output.path, ref: output.ref, epochId: output.epochId })}
                  onOpenTask={() => onOpenTask(output.epochId)}
                  onReveal={desktop ? () => void reveal({ name: output.name, path: output.path, ref: output.ref, epochId: output.epochId }) : undefined} />
              })}
            </div>
          </section>)}
        </div>
        <div ref={endRef} />
        {status === 'loading' && <p role="status" className="mt-3 flex items-center gap-2 text-xs text-faint-foreground"><Loader2 size={14} className="animate-spin" />{t('Loading outputs…')}</p>}
        {status === 'failed' && <p role="alert" className="mt-3 text-xs text-destructive">{t('Could not load outputs.')} <button className="underline" onClick={() => void load(stale.current)}>{t('Retry')}</button></p>}
      </div>
    </div>
  </div>
}

function rangeLabel(range: OutputRange, t: TFunction): string {
  return range === 'today' ? t('Today') : range === 'week' ? t('Last 7 days') : range === 'month' ? t('Last 30 days') : t('All time')
}

function periodLabel(period: OutputPeriod, t: TFunction): string {
  if (period.kind !== 'past') {
    return period.kind === 'today' ? t('Today') : period.kind === 'yesterday' ? t('Yesterday') : period.kind === 'week' ? t('Earlier this week') : t('Earlier this month')
  }
  const date = new Date(period.year, period.month, 1)
  return date.toLocaleDateString(undefined, period.year === new Date().getFullYear() ? { month: 'long' } : { year: 'numeric', month: 'long' })
}

/** The row opens the file; the task it came from is its own link inside it. On desktop, "…" and right-click also offer its folder. */
function OutputRow({ output, taskLabel, onOpen, onOpenTask, onReveal }: {
  output: TeamOutput; taskLabel: string | null; onOpen: () => void; onOpenTask: () => void; onReveal?: () => void
}) {
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)
  const by = parseSpaceCoordinatorAppId(output.appId) ? t('Main chat') : output.memberName
  const dot = output.name.lastIndexOf('.')
  const row = <div className={`group/output relative flex min-w-0 items-center gap-2.5 rounded-lg p-2 transition-colors hover:bg-secondary/70 ${menuOpen ? 'bg-secondary/70' : ''}`}>
    <FileIcon extension={dot > 0 ? output.name.slice(dot + 1) : ''} size={20} className="shrink-0" />
    <span className="min-w-0 flex-1">
      <button onClick={onOpen} title={output.name} className="block max-w-full truncate rounded text-left text-[13px] font-medium text-foreground after:absolute after:inset-0 after:rounded-lg focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-primary">
        {output.name}
      </button>
      <span className="mt-px flex min-w-0 items-center gap-1 text-[11.5px] text-faint-foreground">
        {by && <span className="shrink-0">{by} ·</span>}
        {taskLabel && <>
          <button onClick={onOpenTask} title={taskLabel} className="relative z-10 min-w-0 truncate rounded hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{taskLabel}</button>
          <span aria-hidden="true">·</span>
        </>}
        <span className="shrink-0 tabular-nums">{formatRunStart(output.at)}</span>
      </span>
    </span>
    {onReveal && <div className="relative z-10 shrink-0">
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger ariaLabel={t('More')} title={t('More')} className={`h-7 w-7 cursor-pointer items-center justify-center rounded-full text-subtle-foreground transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary group-hover/output:opacity-100 ${menuOpen ? 'opacity-100' : 'opacity-0'}`}>
          <MoreHorizontal size={15} aria-hidden="true" />
        </PopoverTrigger>
        <PopoverContent align="end" sideOffset={4} className="w-44 p-1">
          <button onClick={() => { setMenuOpen(false); onReveal() }} className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
            <FolderOpen size={14} className="shrink-0 text-subtle-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{t('Show in Folder')}</span>
          </button>
        </PopoverContent>
      </Popover>
    </div>}
  </div>
  if (!onReveal) return row
  return <ContextMenu items={[{ label: t('Show in Folder'), icon: <FolderOpen className="h-4 w-4" />, onClick: onReveal }]}>{row}</ContextMenu>
}
