import { useMemo, useEffect, useRef, useState } from 'react'
import { AlertTriangle, ArrowRight, ArrowUp, Bell, ChevronDown, FileText } from 'lucide-react'
import type { TeamActivity, TeamDetail } from '../../../../shared/apps/team-types'
import { useTranslation } from '../../../i18n'
import { AutomationAvatar } from '../../apps/AutomationAvatar'
import { MarkdownRenderer } from '../../chat/MarkdownRenderer'
import { TaskTimestamp } from './TaskTimestamp'
import { taskTime } from './time'
import { activityLevel, taskActivityRows, type TaskActivityRow, type TaskMemberReport } from './model'

function recordIds(rows: TaskActivityRow[]): string[] {
  return rows.flatMap(row => row.notifications ? row.notifications.map(item => `message:${item.appId}:${item.message.id}`)
    : row.activities ? row.activities.map(item => `activity:${item.id}`) : [row.id])
}

function ActivityContent({ content, attention = false }: { content: string; attention?: boolean }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  if (attention) return <div className="mt-3 break-words text-sm"><MarkdownRenderer content={content} /></div>
  const text = content.trim()
  const hasFormatting = /[\r\n]|!\[|\[[^\]]+\]\(|\*\*|__|`|^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>)/.test(text)
  if (text.length <= 160 && !hasFormatting) return <p className="mt-2 break-words text-xs leading-5 text-foreground/80">{text}</p>
  return <details className="group/content mt-2" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary className="cursor-pointer list-none rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
      <span className="block line-clamp-3 break-words text-xs leading-5 text-foreground/80 group-open/content:hidden">{content.replace(/\s+/g, ' ').trim()}</span>
      <span className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-primary"><span className="group-open/content:hidden">{t('Read details')}</span><span className="hidden group-open/content:inline">{t('Collapse')}</span><ChevronDown size={12} className="transition-transform group-open/content:rotate-180" /></span>
    </summary>
    <div className="mt-2 max-h-96 overflow-auto overscroll-contain rounded-lg bg-secondary/40 p-3 text-sm [overflow-wrap:anywhere]">{expanded && <MarkdownRenderer content={content} />}</div>
  </details>
}

export function TaskActivityTimeline({ messages, activities, detail, showEmpty = true, canOpenArtifact, openArtifact, focusActivityId }: {
  messages: TaskMemberReport[]; activities: TeamActivity[]; detail: TeamDetail; showEmpty?: boolean; focusActivityId?: string; canOpenArtifact?: (ref: string) => boolean; openArtifact: (ref: string) => void
}) {
  const { t } = useTranslation()
  const liveRows = useMemo(() => taskActivityRows(messages, activities), [messages, activities])
  const [readingRows, setReadingRows] = useState<TaskActivityRow[] | null>(null)
  const rows = readingRows ?? liveRows
  const [page, setPage] = useState(0)
  const pendingCount = useMemo(() => {
    if (!readingRows) return 0
    const visible = new Set(recordIds(readingRows))
    return recordIds(liveRows).filter(id => !visible.has(id)).length
  }, [liveRows, readingRows])
  const preserveReading = () => { if (rows.length) setReadingRows(current => current ?? rows) }
  const container = useRef<HTMLDivElement>(null)
  const focused = useRef<string | undefined>()
  useEffect(() => {
    if (!focusActivityId || focused.current === focusActivityId) return
    const target = Array.from(container.current?.querySelectorAll<HTMLElement>('[data-activity-id]') ?? []).find(node => node.dataset.activityId === focusActivityId)
    if (!target) {
      if (readingRows && liveRows.some(row => row.activities?.some(activity => activity.id === focusActivityId))) setReadingRows(liveRows)
      const index = rows.findIndex(row => row.activities?.some(activity => activity.id === focusActivityId))
      if (index >= 0) setPage(Math.floor(index / 50))
      return
    }
    setReadingRows(current => current ?? rows)
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
  }, [focusActivityId, rows, liveRows, readingRows, page])
  const members = useMemo(() => new Map(detail.roster.map(member => [member.appId, member])), [detail.roster])
  const names = useMemo(() => new Map(detail.roster.map(member => [member.appId, member.memberName])), [detail.roster])
  const name = (id: string) => names.get(id) ?? t('Former member')
  const kinds = { message: t('Message'), reply: t('Reply'), task_post: t('Task assigned'), task_update: t('Progress update'), finding: t('Output'), check_set: t('Follow-up scheduled'), check_stop: t('Follow-up stopped'), run_end: t('Task summary'), decision: t('Decision') }
  const header = (appId: string, at: number | null, label: string, recordId: string, targetId?: string | null) => <div className="flex items-start gap-2.5">
    <span className="mt-0.5 shrink-0"><AutomationAvatar name={name(appId)} size={26} /></span>
    <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs leading-5"><span className="max-w-full truncate font-medium text-foreground">{name(appId)}</span>{targetId && <><ArrowRight size={12} className="shrink-0 text-muted-foreground/60" aria-hidden="true" /><span className="max-w-full truncate text-muted-foreground">{name(targetId)}</span></>}</div><p className="text-[11px] text-muted-foreground">{label}</p></div>
    <TaskTimestamp value={at} recordId={recordId} className="shrink-0 text-[11px] tabular-nums text-muted-foreground" />
  </div>
  const activityCard = (act: TeamActivity) => {
    const attention = activityLevel(act) === 'attention'
    const actor = members.get(act.actorAppId)
    const attentionLabel = act.status === 'undelivered' ? t('Not delivered')
      : act.status === 'timeout' ? t('Timed out')
        : act.status === 'escalation' ? actor?.sameMachine === false
          ? actor.owner ? t('Waiting for {{owner}}’s decision', { owner: actor.owner }) : t('Waiting for its owner’s decision')
          : t('Needs your decision')
        : t('Failed')
    return <article key={act.id} data-activity-id={act.id} tabIndex={-1} className={`min-w-0 rounded-xl border p-3 transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-background ${attention ? 'border-halo-warning/40 bg-halo-warning/5' : 'border-border bg-background'}`}>
      {header(act.actorAppId, taskTime(act.createdAt), act.kind === 'decision' && act.status === 'escalation' ? t('Decision requested') : kinds[act.kind], act.id, act.targetAppId)}
      {attention && <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-halo-warning"><AlertTriangle size={13} />{attentionLabel}</p>}
      <ActivityContent content={act.body || act.subject} attention={attention} />
      {act.kind === 'finding' && act.refId && canOpenArtifact?.(act.refId) && <button onClick={() => openArtifact(act.refId!)} className="mt-2 inline-flex min-h-8 items-center gap-1.5 rounded-lg bg-primary/5 px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><FileText size={13} />{t('View output')}</button>}
    </article>
  }
  return <div ref={container} className="min-w-0 space-y-3" onPointerDownCapture={preserveReading} onKeyDownCapture={preserveReading} onWheelCapture={preserveReading}>
    <div className="sticky top-0 z-10 flex min-h-11 items-center bg-background/95 py-1 backdrop-blur-sm">
      {pendingCount > 0 ? <button onClick={() => {
        setReadingRows(liveRows)
        setPage(0)
        container.current?.scrollIntoView({ block: 'start' })
      }} className="flex min-h-9 w-full items-center justify-center gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs font-medium text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"><ArrowUp size={14} aria-hidden="true" /><span role="status">{t('Show {{count}} new updates', { count: pendingCount })}</span></button>
        : <span className="text-[11px] text-muted-foreground">{t('Newest first')}</span>}
    </div>
    {showEmpty && rows.length === 0 && <p className="py-10 text-center text-sm text-muted-foreground">{t('No activity yet')}</p>}
    {rows.slice(page * 50, (page + 1) * 50).map((row, index) => {
      const acts = row.activities
      const notifications = row.notifications
      const latestNotification = notifications?.[notifications.length - 1]
      const date = row.at === null ? t('Time unknown') : new Date(row.at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
      const day = row.at === null ? 'unknown' : new Date(row.at).toDateString()
      const previousAt = index > 0 ? rows[page * 50 + index - 1].at : null
      const previousDate = index > 0 ? previousAt === null ? 'unknown' : new Date(previousAt).toDateString() : null
      return <div key={row.id} className="min-w-0">
        {day !== previousDate && <div className="mb-3 flex items-center gap-3 pt-2 text-[11px] text-muted-foreground"><span className="h-px flex-1 bg-border" /><span>{date}</span><span className="h-px flex-1 bg-border" /></div>}
        {notifications?.length && latestNotification ? <details data-system-notification-id={row.id} className="group/notification overflow-hidden rounded-xl border border-border bg-secondary/20">
          <summary className="flex cursor-pointer list-none items-start gap-2.5 p-3 transition-colors hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary">
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground"><Bell size={14} aria-hidden="true" /></span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs leading-5"><span className="font-medium">{notifications.length === 1 ? t('System notification') : t('{{count}} system notifications', { count: notifications.length })}</span><ArrowRight size={12} className="shrink-0 text-muted-foreground/60" aria-hidden="true" /><span className="max-w-full truncate text-muted-foreground">{name(latestNotification.appId)}</span></span>
            </span>
            <TaskTimestamp value={taskTime(latestNotification.message.timestamp)} recordId={row.id} className="mt-0.5 shrink-0 text-[11px] tabular-nums text-muted-foreground" />
            <ChevronDown size={14} className="mt-0.5 shrink-0 text-muted-foreground transition-transform group-open/notification:rotate-180" aria-hidden="true" />
          </summary>
          <div className="max-h-[32rem] space-y-2 overflow-y-auto overscroll-contain border-t border-border p-2 sm:p-3">{notifications.map(notification => <article key={`${notification.appId}:${notification.message.id}`} data-message-id={notification.message.id} className="min-w-0 rounded-lg border border-border bg-background p-3">
            <div className="mb-2 flex items-start gap-2">
              <span className="min-w-0 flex-1 text-xs leading-5"><span className="font-medium">{t('System notification')}</span><ArrowRight size={12} className="mx-1.5 inline text-muted-foreground/60" aria-hidden="true" /><span className="break-words text-muted-foreground">{name(notification.appId)}</span></span>
              <TaskTimestamp value={taskTime(notification.message.timestamp)} recordId={`${notification.appId}:${notification.message.id}`} className="mt-0.5 shrink-0 text-[11px] tabular-nums text-muted-foreground" />
            </div>
            <p className="whitespace-pre-wrap text-xs leading-5 text-foreground/80 [overflow-wrap:anywhere]">{notification.message.content}</p>
          </article>)}</div>
        </details> : row.message ? <article className={`rounded-xl border p-3 ${row.message.error ? 'border-halo-warning/40 bg-halo-warning/5' : 'border-border bg-background'}`}>
          {header(row.appId ?? '', row.at, row.message.error ? t('Failed') : t('Member report'), row.id)}
          {row.message.content.trim() && <ActivityContent content={row.message.content} />}
          {row.message.error && <p role="alert" className="mt-3 whitespace-pre-wrap break-words text-xs leading-5 text-halo-warning">{row.message.error}</p>}
        </article> : acts && (acts.length > 1 && activityLevel(acts[0]) === 'process' ? <details className="group/activity overflow-hidden rounded-xl border border-border bg-secondary/20">
          <summary className="flex cursor-pointer list-none items-start gap-2.5 p-3 transition-colors hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"><ChevronDown size={14} className="mt-0.5 shrink-0 text-muted-foreground transition-transform group-open/activity:rotate-180" /><span className="min-w-0 flex-1"><span className="block text-xs font-medium">{t('{{count}} updates', { count: acts.length })} · {kinds[acts[0].kind]}</span><span className="mt-1 block truncate text-[11px] text-muted-foreground">{[...new Set(acts.map(act => name(act.actorAppId)))].join(', ')}</span></span><TaskTimestamp value={acts[acts.length - 1].createdAt} recordId={acts[acts.length - 1].id} className="shrink-0 text-[11px] tabular-nums text-muted-foreground" /></summary>
          <div className="max-h-[32rem] space-y-2 overflow-y-auto overscroll-contain border-t border-border p-2 sm:p-3">{acts.map(activityCard)}</div>
        </details> : acts.map(activityCard))}
      </div>
    })}
    {rows.length > 50 && <nav className="flex justify-between text-xs text-primary"><button disabled={page === 0} onClick={() => setPage(value => Math.max(0, value - 1))} className="min-h-9 disabled:opacity-40">{t('Newer updates')}</button><button disabled={(page + 1) * 50 >= rows.length} onClick={() => setPage(value => value + 1)} className="min-h-9 disabled:opacity-40">{t('Older updates')}</button></nav>}
  </div>
}
