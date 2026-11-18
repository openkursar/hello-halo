import { useMemo, useEffect, useRef, useState } from 'react'
import { AlertTriangle, ArrowRight, ArrowUp, Bell, Check, ChevronDown, ChevronUp, FileText, Funnel } from 'lucide-react'
import type { TeamActivity, TeamDetail } from '../../../../shared/apps/team-types'
import { parseSpaceCoordinatorAppId } from '../../../../shared/apps/team-types'
import { useTranslation } from '../../../i18n'
import { AutomationAvatar } from '../../apps/AutomationAvatar'
import { markdownPreview } from '../../../utils/markdown-preview'
import { MarkdownRenderer } from '../../chat/MarkdownRenderer'
import { TaskTimestamp } from './TaskTimestamp'
import { taskTime } from './time'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/Popover'
import { activityLevel, filterTaskActivityRows, taskActivityRows, undeliveredParties, type TaskActivityKind, type TaskActivityRow, type TaskMemberReport } from './model'
import { UndeliveredNote } from './UndeliveredNote'

function recordIds(rows: TaskActivityRow[]): string[] {
  return rows.flatMap(row => row.activities ? row.activities.map(item => `activity:${item.id}`) : [row.id])
}

const CONTENT_TEXT = 'text-[13px] leading-relaxed text-foreground/85 [overflow-wrap:anywhere]'

/**
 * A record's text: short text in full; longer text as its first lines, opening in place
 * into the rendered whole, which is only rendered once opened. `full` always shows it whole.
 */
export function ActivityContent({ content, attention = false, full = false }: { content: string; attention?: boolean; full?: boolean }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const details = useRef<HTMLDetailsElement>(null)
  if (attention) return <div className="mt-3 break-words text-sm"><MarkdownRenderer content={content} /></div>
  const text = content.trim()
  const preview = markdownPreview(text)
  if (full || (preview.length <= 160 && preview.split('\n').length <= 3)) {
    return preview === text ? <p className={`mt-2 whitespace-pre-line ${CONTENT_TEXT}`}>{text}</p>
      : <div className={`mt-2 ${CONTENT_TEXT}`}><MarkdownRenderer content={text} /></div>
  }
  const collapse = () => {
    const element = details.current
    if (!element) return
    element.open = false
    element.scrollIntoView({ block: 'nearest' })
  }
  return <details ref={details} className="group/content mt-2" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary className="cursor-pointer list-none rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary group-open/content:hidden">
      <span className={`line-clamp-3 whitespace-pre-line ${CONTENT_TEXT}`}>{preview}</span>
      <span className="mt-1 inline-flex items-center gap-1 text-xs text-primary">{t('Read details')}<ChevronDown size={12} aria-hidden="true" /></span>
    </summary>
    {expanded && <>
      <div className={`max-h-[28rem] overflow-auto overscroll-contain ${CONTENT_TEXT}`}><MarkdownRenderer content={text} /></div>
      <button type="button" onClick={collapse} className="mt-1 inline-flex items-center gap-1 rounded-md text-xs text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
        {t('Collapse')}<ChevronUp size={12} aria-hidden="true" />
      </button>
    </>}
  </details>
}

/** `bare` reads as text, for a toolbar beside tabs. */
export function KindFilter({ value, onChange, bare = false }: { value: TaskActivityKind | null; onChange: (kind: TaskActivityKind | null) => void; bare?: boolean }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const options: [TaskActivityKind | null, string][] = [[null, t('All types')], ['output', t('Outputs')], ['decision', t('Decision')], ['failed', t('Failed')]]
  const label = options.find(([kind]) => kind === value)?.[1]
  return <Popover open={open} onOpenChange={setOpen}>
    {bare ? <PopoverTrigger ariaLabel={t('Filter by type')} className={`min-h-8 items-center gap-1 rounded-md px-1.5 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary ${value ? 'text-primary' : 'text-subtle-foreground hover:text-foreground'}`}>
      <span className="truncate">{label}</span><ChevronDown size={13} className="shrink-0 opacity-70" aria-hidden="true" />
    </PopoverTrigger> : <PopoverTrigger ariaLabel={t('Filter by type')} className={`min-h-8 w-32 items-center gap-1.5 rounded-lg border px-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${value ? 'border-primary/30 bg-primary/5 text-primary' : 'border-border text-muted-foreground hover:bg-secondary hover:text-foreground'}`}>
      <Funnel size={13} className="shrink-0" aria-hidden="true" /><span className="min-w-0 flex-1 truncate text-left">{label}</span><ChevronDown size={12} className="shrink-0 opacity-60" aria-hidden="true" />
    </PopoverTrigger>}
    <PopoverContent align="end" className="w-32 py-1">
      {options.map(([kind, label]) => <button key={kind ?? 'all'} type="button" onClick={() => { onChange(kind); setOpen(false) }} className="flex min-h-8 w-full items-center gap-2 px-3 text-left text-xs hover:bg-secondary/80">
        <span className="flex-1">{label}</span>{kind === value && <Check size={13} className="text-primary" aria-hidden="true" />}
      </button>)}
    </PopoverContent>
  </Popover>
}

/** Passing `kind` hides the built-in type filter: the caller places its own (with `onKindChange`) or fixes it. */
export function TaskActivityTimeline({ messages, activities, detail, showEmpty = true, canOpenArtifact, openArtifact, onOpenMember, focusActivityId, taskCompleted = false, kind: kindProp, onKindChange }: {
  messages: TaskMemberReport[]; activities: TeamActivity[]; detail: TeamDetail; showEmpty?: boolean; focusActivityId?: string; canOpenArtifact?: (ref: string) => boolean; openArtifact: (ref: string) => void; onOpenMember?: (appId: string) => void; taskCompleted?: boolean
  kind?: TaskActivityKind | null; onKindChange?: (kind: TaskActivityKind | null) => void
}) {
  const { t } = useTranslation()
  const liveRows = useMemo(() => taskActivityRows(messages, activities), [messages, activities])
  const [readingRows, setReadingRows] = useState<TaskActivityRow[] | null>(null)
  const [kindState, setKindState] = useState<TaskActivityKind | null>(null)
  const kind = kindProp !== undefined ? kindProp : kindState
  const setKind = onKindChange ?? setKindState
  const rows = useMemo(() => filterTaskActivityRows(readingRows ?? liveRows, kind), [readingRows, liveRows, kind])
  const pendingCount = useMemo(() => {
    if (!readingRows) return 0
    const visible = new Set(recordIds(readingRows))
    return recordIds(liveRows).filter(id => !visible.has(id)).length
  }, [liveRows, readingRows])
  const preserveReading = () => { if (liveRows.length) setReadingRows(current => current ?? liveRows) }
  const container = useRef<HTMLDivElement>(null)
  const focused = useRef<string | undefined>()
  useEffect(() => {
    if (!focusActivityId || focused.current === focusActivityId) return
    const target = Array.from(container.current?.querySelectorAll<HTMLElement>('[data-activity-id]') ?? []).find(node => node.dataset.activityId === focusActivityId)
    if (!target) {
      const holds = (list: TaskActivityRow[]) => list.some(row => row.activities?.some(activity => activity.id === focusActivityId))
      if (readingRows && holds(liveRows)) setReadingRows(liveRows)
      if (kind && !holds(rows) && holds(liveRows)) setKind(null)
      return
    }
    setReadingRows(current => current ?? liveRows)
    const frame = requestAnimationFrame(() => {
      let parent = target.parentElement
      while (parent && parent !== container.current) {
        if (parent instanceof HTMLDetailsElement) parent.open = true
        parent = parent.parentElement
      }
      const content = target.querySelector('details')
      if (content) content.open = true
      target.scrollIntoView({ block: 'center' })
      target.focus({ preventScroll: true })
      focused.current = focusActivityId
    })
    return () => cancelAnimationFrame(frame)
  }, [focusActivityId, rows, liveRows, readingRows, kind])
  const members = useMemo(() => new Map(detail.roster.map(member => [member.appId, member])), [detail.roster])
  const names = useMemo(() => new Map(detail.roster.map(member => [member.appId, member.memberName])), [detail.roster])
  const name = (id: string) => parseSpaceCoordinatorAppId(id) ? t('Main chat') : names.get(id) ?? t('Former member')
  const kinds = { message: t('Message'), reply: t('Reply'), task_post: t('Task assigned'), task_update: t('Progress update'), finding: t('Output'), check_set: t('Follow-up scheduled'), check_stop: t('Follow-up stopped'), run_end: t('Task summary'), decision: t('Decision') }
  const avatar = (appId: string) => {
    const face = <AutomationAvatar name={name(appId)} size={26} />
    return onOpenMember && members.has(appId)
      ? <button type="button" onClick={() => onOpenMember(appId)} title={t('Open {{name}}’s conversation', { name: name(appId) })} className="mt-0.5 shrink-0 rounded-full transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{face}</button>
      : <span className="mt-0.5 shrink-0">{face}</span>
  }
  const header = (appId: string, at: number | null, label: string, recordId: string, targetId?: string | null) => <div className="flex items-start gap-2.5">
    {avatar(appId)}
    <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs leading-5"><span className="max-w-full truncate font-medium text-foreground">{name(appId)}</span>{targetId && <><ArrowRight size={12} className="shrink-0 text-muted-foreground/60" aria-hidden="true" /><span className="max-w-full truncate text-muted-foreground">{name(targetId)}</span></>}</div><p className="text-[11px] text-muted-foreground">{label}</p></div>
    <TaskTimestamp value={at} recordId={recordId} className="shrink-0 text-[11px] tabular-nums text-muted-foreground" />
  </div>
  const activityCard = (act: TeamActivity) => {
    const attention = activityLevel(act) === 'attention'
    const actor = members.get(act.actorAppId)
    const undelivered = undeliveredParties(act)
    const attentionLabel = act.status === 'undelivered' ? t('Not delivered')
      : act.status === 'timeout' ? t('Timed out')
        : act.status === 'escalation' ? actor?.sameMachine === false
          ? actor.owner ? t('Waiting for {{owner}}’s decision', { owner: actor.owner }) : t('Waiting for its owner’s decision')
          : t('Needs your decision')
        : t('Failed')
    // A message that did not arrive reads as that message: sender to recipient.
    const from = undelivered?.senderAppId ?? act.actorAppId
    const to = undelivered ? (undelivered.senderAppId ? undelivered.recipientAppId : null) : act.targetAppId
    const label = undelivered ? kinds.message : act.kind === 'decision' && act.status === 'escalation' ? t('Decision requested') : kinds[act.kind]
    return <article key={act.id} data-activity-id={act.id} tabIndex={-1} className={`min-w-0 rounded-xl border p-3 transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-background ${attention ? 'border-halo-warning/40 bg-halo-warning/5' : 'border-border bg-background'}`}>
      {header(from, taskTime(act.createdAt), label, act.id, to)}
      {attention && <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-halo-warning"><AlertTriangle size={13} />{attentionLabel}</p>}
      {undelivered && <UndeliveredNote recipient={undelivered.recipientAppId ? members.get(undelivered.recipientAppId) : undefined} taskCompleted={taskCompleted} className="mt-1.5 break-words text-xs leading-5 text-foreground/80" />}
      {undelivered && act.kind === 'reply' && <details className="mt-2 break-words text-xs text-muted-foreground"><summary className="cursor-pointer">{t('Details')}</summary><p className="mt-1 whitespace-pre-wrap">{act.subject}</p></details>}
      {(!undelivered || act.kind === 'message') && <ActivityContent content={act.body || act.subject} attention={attention} />}
      {act.kind === 'finding' && act.refId && canOpenArtifact?.(act.refId) && <button onClick={() => openArtifact(act.refId!)} className="mt-2 inline-flex min-h-8 items-center gap-1.5 rounded-lg bg-primary/5 px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><FileText size={13} />{t('View output')}</button>}
    </article>
  }
  return <div ref={container} className="min-w-0 space-y-3" onPointerDownCapture={preserveReading} onKeyDownCapture={preserveReading} onWheelCapture={preserveReading}>
    {/* Floats over the records so its arrival never moves what is being read. */}
    {pendingCount > 0 && <div className="sticky top-[var(--page-sticky-top,0px)] z-10 -mb-3 h-0">
      <button onClick={() => {
        setReadingRows(liveRows)
        container.current?.scrollIntoView({ block: 'start' })
      }} className="absolute left-1/2 top-1 flex min-h-9 -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full border border-primary/20 bg-background px-4 py-2 text-xs font-medium text-primary shadow-md hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><ArrowUp size={14} aria-hidden="true" /><span role="status">{t('Show {{count}} new updates', { count: pendingCount })}</span></button>
    </div>}
    {kindProp === undefined && liveRows.length > 0 && <div className="flex justify-end"><KindFilter value={kind} onChange={setKind} /></div>}
    {rows.length === 0 && kind && liveRows.length > 0
      ? <p className="py-10 text-center text-sm text-muted-foreground">{t('No matching records')} <button type="button" onClick={() => setKind(null)} className="text-primary hover:underline">{t('Clear filters')}</button></p>
      : showEmpty && rows.length === 0 && <p className="py-10 text-center text-sm text-muted-foreground">{t('No activity yet')}</p>}
    {rows.map((row, index) => {
      const acts = row.activities
      const date = row.at === null ? t('Time unknown') : new Date(row.at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
      const day = row.at === null ? 'unknown' : new Date(row.at).toDateString()
      const previousAt = index > 0 ? rows[index - 1].at : null
      const previousDate = index > 0 ? previousAt === null ? 'unknown' : new Date(previousAt).toDateString() : null
      return <div key={row.id} className="min-w-0">
        {day !== previousDate && <div className="mb-3 pt-2 text-center text-[11px] text-muted-foreground">{date}</div>}
        {row.message && row.notice ? <article data-message-id={row.message.id} className="min-w-0 rounded-xl border border-border bg-secondary/20 p-3">
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5 flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground"><Bell size={14} aria-hidden="true" /></span>
            <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs leading-5"><span className="font-medium text-foreground">{t('System notification')}</span><ArrowRight size={12} className="shrink-0 text-muted-foreground/60" aria-hidden="true" /><span className="max-w-full truncate text-muted-foreground">{name(row.appId ?? '')}</span></div></div>
            <TaskTimestamp value={row.at} recordId={row.id} className="shrink-0 text-[11px] tabular-nums text-muted-foreground" />
          </div>
          <ActivityContent content={row.message.content} />
        </article> : row.message ? <article className={`rounded-xl border p-3 ${row.message.error ? 'border-halo-warning/40 bg-halo-warning/5' : 'border-border bg-background'}`}>
          {header(row.appId ?? '', row.at, row.message.error ? t('Failed') : t('Member report'), row.id)}
          {row.message.content.trim() && <ActivityContent content={row.message.content} />}
          {row.message.error && <p role="alert" className="mt-3 whitespace-pre-wrap break-words text-xs leading-5 text-halo-warning">{row.message.error}</p>}
        </article> : acts?.map(activityCard)}
      </div>
    })}
  </div>
}
