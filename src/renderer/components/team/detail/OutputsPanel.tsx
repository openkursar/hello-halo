import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { TFunction } from 'i18next'
import type { TeamConversation, TeamDetail, TeamOutput } from '../../../../shared/apps/team-types'
import { parseSpaceCoordinatorAppId } from '../../../../shared/apps/team-types'
import { api } from '../../../api'
import { useTranslation } from '../../../i18n'
import { formatRunStart } from '../../../utils/format-time'
import { FileIcon } from '../../icons/ToolIcons'
import { useOpenTeamArtifact } from '../TeamArtifacts'
import { mergeOutputs, outputGroups, outputKey, type OutputPeriod } from './outputs'
import { PanelBar } from './PanelBar'
import { SectionHeading, taskTitle } from './task-ui'

const PAGE_SIZE = 30

type Status = 'loading' | 'ready' | 'failed'

/** Every file the team produced, newest first, read a page at a time as the reader scrolls. */
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
  const offset = useRef(0)
  const busy = useRef(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const endRef = useRef<HTMLDivElement | null>(null)
  const open = useOpenTeamArtifact(teamId)

  const load = useCallback(async () => {
    if (busy.current) return
    busy.current = true
    setStatus('loading')
    try {
      const res = await api.teamListOutputs(teamId, offset.current, PAGE_SIZE)
      if (!res.success || !res.data) throw new Error(res.error ?? 'rejected')
      const page = res.data
      offset.current += page.outputs.length
      setOutputs(current => mergeOutputs(current, page.outputs))
      setTotal(page.total)
      setStatus('ready')
    } catch (err) {
      console.warn('[OutputsPanel] listing failed', { teamId, offset: offset.current, err })
      setStatus('failed')
    } finally {
      busy.current = false
    }
  }, [teamId])

  useEffect(() => { void load() }, [load])

  const more = status === 'ready' && total !== null && offset.current < total
  useEffect(() => {
    const end = endRef.current
    if (!more || !end) return
    const observer = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) void load() }, { root: scrollRef.current, rootMargin: '240px' })
    observer.observe(end)
    return () => observer.disconnect()
  }, [more, load, outputs.length])

  const byEpoch = useMemo(() => new Map(tasks.map(task => [task.epochId, task])), [tasks])
  const groups = useMemo(() => outputGroups(outputs), [outputs])

  return <div className="flex h-full min-h-0 flex-col">
    <PanelBar docked={docked} onBack={onClose} onClose={onClose} />
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
      <div className="px-5 pb-10 pt-3 sm:px-6">
        <h2 className="mb-3 flex items-baseline gap-2 text-[18px] font-semibold leading-7">
          {t('Outputs')}{total !== null && total > 0 && <span className="text-[13px] font-normal tabular-nums text-faint-foreground">{t('{{count}} in all', { count: total })}</span>}
        </h2>
        {total === 0 && <div className="py-10 text-center">
          <p className="text-[13.5px] font-medium text-foreground">{t('No delivered files yet')}</p>
          <p className="mx-auto mt-1 max-w-xs text-[12.5px] leading-5 text-faint-foreground">{t('When the team finishes tasks, the documents, sheets and images it produces appear here.')}</p>
        </div>}
        <div className="space-y-6">
          {groups.map(group => <section key={group.key}>
            <SectionHeading title={periodLabel(group.period, t)} />
            <div className="-mx-2">
              {group.outputs.map(output => {
                const task = byEpoch.get(output.epochId)
                return <OutputRow key={outputKey(output)} output={output} taskLabel={task ? taskTitle(detail, task, t) : null}
                  onOpen={() => void open({ name: output.name, path: output.path, ref: output.ref, epochId: output.epochId })}
                  onOpenTask={() => onOpenTask(output.epochId)} />
              })}
            </div>
          </section>)}
        </div>
        <div ref={endRef} />
        {status === 'loading' && <p role="status" className="mt-3 flex items-center gap-2 text-xs text-faint-foreground"><Loader2 size={14} className="animate-spin" />{t('Loading outputs…')}</p>}
        {status === 'failed' && <p role="alert" className="mt-3 text-xs text-destructive">{t('Could not load outputs.')} <button className="underline" onClick={() => void load()}>{t('Retry')}</button></p>}
      </div>
    </div>
  </div>
}

function periodLabel(period: OutputPeriod, t: TFunction): string {
  if (period.kind !== 'past') {
    return period.kind === 'today' ? t('Today') : period.kind === 'yesterday' ? t('Yesterday') : period.kind === 'week' ? t('Earlier this week') : t('Earlier this month')
  }
  const date = new Date(period.year, period.month, 1)
  return date.toLocaleDateString(undefined, period.year === new Date().getFullYear() ? { month: 'long' } : { year: 'numeric', month: 'long' })
}

/** The row opens the file; the task it came from is its own link inside it. */
function OutputRow({ output, taskLabel, onOpen, onOpenTask }: {
  output: TeamOutput; taskLabel: string | null; onOpen: () => void; onOpenTask: () => void
}) {
  const { t } = useTranslation()
  const by = parseSpaceCoordinatorAppId(output.appId) ? t('Main chat') : output.memberName
  const dot = output.name.lastIndexOf('.')
  return <div className="relative flex min-w-0 items-center gap-2.5 rounded-lg p-2 transition-colors hover:bg-secondary/70">
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
  </div>
}
