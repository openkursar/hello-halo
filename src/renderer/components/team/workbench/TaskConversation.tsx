import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ArrowRight, CheckCircle2, ChevronDown, ChevronRight, Clock3 } from 'lucide-react'
import type { TeamActivity, TeamDetail } from '../../../../shared/apps/team-types'
import type { Message } from '../../../types'
import type { ActivityEntry } from '../../../../shared/apps/app-types'
import { EscalationCard } from '../../apps/EscalationCard'
import { useTranslation } from '../../../i18n'
import { AutomationAvatar } from '../../apps/AutomationAvatar'
import { MessageRow } from '../../chat/MessageRow'
import { TaskTimestamp } from './TaskTimestamp'
import { taskTime } from './time'
import { activityLevel, conversationMessages, decisionMessageId, COLLABORATION_PREVIEW_LIMIT, taskConversationRows, type SharedTaskDecision } from './model'

export function TaskConversation({ messages, activities, epochId, appId, detail, showEmpty, onActivity, decisions = [], onAnswered, focusDecision, onDecisionFocused, emptyActions, onHumanConversation }: {
  messages: Message[]; activities: TeamActivity[]; epochId: string | null; appId?: string; detail: TeamDetail; showEmpty: boolean; onActivity: (id?: string) => void
  decisions?: ActivityEntry[]; onAnswered?: (entry: ActivityEntry) => void
  focusDecision?: string | null; onDecisionFocused?: () => void
  emptyActions?: ReactNode; onHumanConversation?: (appId: string) => void
}) {
  const { t } = useTranslation()
  const hasHumanConversation = conversationMessages(messages).some(message => message.role === 'user')
  useEffect(() => { if (hasHumanConversation && appId) onHumanConversation?.(appId) }, [hasHumanConversation, appId, onHumanConversation])
  const attached = useMemo(() => new Map(decisions.map(decision => [decision.id, decisionMessageId(decision, messages)])), [decisions, messages])
  const rows = useMemo(() => taskConversationRows(messages, activities, epochId, appId, decisions.filter(decision => !attached.get(decision.id))), [messages, activities, epochId, appId, decisions, attached])
  const [olderPage, setOlderPage] = useState(0)
  const end = Math.max(0, rows.length - olderPage * 50)
  const visibleRows = rows.slice(Math.max(0, end - 50), end)
  useEffect(() => { setOlderPage(0) }, [epochId, appId])
  useEffect(() => {
    if (!focusDecision) return
    const card = document.getElementById(`decision-${focusDecision}`)
    if (!card) {
      const index = rows.findIndex(row => row.decision?.id === focusDecision || row.message?.id === attached.get(focusDecision))
      if (index >= 0) setOlderPage(Math.floor((rows.length - 1 - index) / 50))
      return
    }
    const frame = requestAnimationFrame(() => {
      card.scrollIntoView({ block: 'center' })
      card.focus({ preventScroll: true })
      onDecisionFocused?.()
    })
    return () => cancelAnimationFrame(frame)
  }, [focusDecision, rows, attached, olderPage, onDecisionFocused])
  const name = (id: string | null) => detail.roster.find(member => member.appId === id)?.memberName ?? t('Former member')
  const time = (timestamp: number) => {
    const at = taskTime(timestamp)
    if (at === null) return t('Time unknown')
    const date = new Date(at)
    return date.toLocaleString([], {
      ...(date.toDateString() !== new Date().toDateString() ? { month: 'short' as const, day: 'numeric' as const } : {}),
      hour: '2-digit', minute: '2-digit',
    })
  }
  const decisionCard = (decision: ActivityEntry) => <article key={decision.id} id={`decision-${decision.id}`} tabIndex={-1} className="scroll-m-4 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary">
        <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground"><AutomationAvatar name={name(decision.appId)} size={22} /><span>{name(decision.appId)}</span><TaskTimestamp value={decision.ts} recordId={decision.id} format="datetime" className="ml-auto text-[11px] tabular-nums" /></div>
        <EscalationCard compactResolved entry={decision} appId={decision.appId} onResolved={onAnswered} />
      </article>
  const sharedDecisionCard = (decision: SharedTaskDecision) => {
    const member = detail.roster.find(item => item.appId === decision.appId)
    const actorName = member?.memberName ?? t('Former member')
    const pendingLabel = member?.sameMachine === false
      ? member.owner ? t('Waiting for {{owner}}’s decision', { owner: member.owner }) : t('Waiting for its owner’s decision')
      : t('Waiting for your decision')
    const answeredLabel = member?.owner ? t('{{owner}} answered', { owner: member.owner }) : t('Decision answered')
    return <article key={decision.refId} className={`overflow-hidden rounded-xl border ${decision.answer ? 'border-border' : 'border-halo-warning/30 bg-halo-warning/5'}`}>
      <header className="flex items-center gap-2 border-b border-border/70 px-3 py-2.5 text-xs">
        <AutomationAvatar name={actorName} size={22} />
        <span className="font-medium">{actorName}</span>
        <span className={`ml-1 flex items-center gap-1 ${decision.answer ? 'text-halo-success' : 'text-halo-warning'}`}>{decision.answer ? <CheckCircle2 size={13} /> : <Clock3 size={13} />}{decision.answer ? answeredLabel : pendingLabel}</span>
        <TaskTimestamp value={decision.answeredAt ?? decision.requestedAt} recordId={decision.refId} format="datetime" className="ml-auto text-[11px] tabular-nums text-muted-foreground" />
      </header>
      <div className="space-y-3 px-4 py-3">
        <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">{decision.question}</p>
        {decision.answer && <div className="rounded-lg bg-secondary/60 px-3 py-2"><p className="text-[11px] text-muted-foreground">{t('Response')}</p><p className="mt-1 whitespace-pre-wrap break-words text-sm">{decision.answer}</p></div>}
        {!decision.answer && <p className="text-xs text-muted-foreground">{t('You can follow this decision here, but only the digital human’s owner can answer it.')}</p>}
      </div>
    </article>
  }
  return <div className="min-w-0 space-y-3">
    {showEmpty && !hasHumanConversation && <div className="rounded-xl border border-dashed border-border p-4"><p className="text-sm leading-6 text-muted-foreground">{t('You have not talked to this digital human in this task yet.')}</p>{emptyActions}</div>}
    {rows.length > 50 && <nav className="flex items-center justify-between text-xs text-primary"><button disabled={end <= 50} onClick={() => setOlderPage(value => value + 1)} className="min-h-9 disabled:opacity-40">{t('Older messages')}</button><button disabled={olderPage === 0} onClick={() => setOlderPage(value => Math.max(0, value - 1))} className="min-h-9 disabled:opacity-40">{t('Newer messages')}</button></nav>}
    {visibleRows.map(row => {
      if (row.decision) return decisionCard(row.decision)
      if (row.sharedDecision) return sharedDecisionCard(row.sharedDecision)
      if (row.message) {
        const messageId = row.message.id
        const requests = decisions.filter(decision => attached.get(decision.id) === messageId)
        return <MessageRow key={row.id} message={row.message} hideBrowserViewButton afterThoughts={requests.length ? requests.map(decisionCard) : undefined} />
      }
      const updates = row.activities
      const latest = updates[updates.length - 1]
      if (activityLevel(latest) === 'attention') return <article key={row.id} className="rounded-lg border border-halo-warning/30 bg-halo-warning/10 p-3 text-xs">
        <p className="font-medium text-halo-warning">{name(latest.actorAppId)} → {name(latest.targetAppId)}</p>
        <p className="mt-1 whitespace-pre-wrap break-words">{latest.subject || latest.body}</p>
        <button onClick={() => onActivity(latest.id)} className="mt-2 rounded px-1 py-1 text-primary hover:bg-secondary">{t('View more in task activity')}</button>
      </article>
      const preview = updates.slice(-COLLABORATION_PREVIEW_LIMIT)
      return <details key={row.id} className="group min-w-0 overflow-hidden rounded-xl border border-dashed border-border text-xs text-muted-foreground open:border-solid">
        <summary className="flex cursor-pointer list-none items-start gap-2.5 px-3 py-3 transition-colors hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary sm:px-4">
          <ChevronDown size={14} className="mt-0.5 shrink-0 transition-transform group-open:rotate-180" />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="font-medium text-foreground">{t('{{count}} collaboration messages', { count: updates.length })}</span>
              <span className="min-w-0 truncate">{name(latest.actorAppId)} → {name(latest.targetAppId)}</span>
            </span>
            <span className="mt-1 block truncate group-open:hidden">{(latest.subject || latest.body || '').replace(/\s+/g, ' ')}</span>
          </span>
          <TaskTimestamp value={latest.createdAt} recordId={latest.id} format="datetime" className="shrink-0 text-[11px] tabular-nums" />
        </summary>
        <div className="border-t border-border bg-secondary/20 px-3 pb-3 pt-3 sm:px-4 sm:pb-4">
          <p className="mb-3 text-[11px]">{t('Latest {{count}} messages in this segment', { count: preview.length })}</p>
          <ol className="space-y-2">{preview.map(activity => <li key={activity.id}>
            <button onClick={() => onActivity(activity.id)} aria-label={`${name(activity.actorAppId)} → ${name(activity.targetAppId)} · ${time(activity.createdAt)} · ${t('View more in task activity')}`} className="group/update block w-full rounded-lg border border-border bg-background p-3 text-left transition-colors hover:border-primary/40 hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
              <span className="flex items-start gap-2.5">
                <span className="mt-0.5 shrink-0"><AutomationAvatar name={name(activity.actorAppId)} size={24} /></span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 leading-5">
                    <span className="max-w-full truncate font-medium text-foreground">{name(activity.actorAppId)}</span>
                    <ArrowRight size={12} className="shrink-0 text-muted-foreground/60" aria-hidden="true" />
                    <span className="max-w-full truncate">{name(activity.targetAppId)}</span>
                  </span>
                  <TaskTimestamp value={activity.createdAt} recordId={activity.id} format="datetime" className="mt-0.5 block text-[11px] tabular-nums text-muted-foreground/80" />
                </span>
                <ChevronRight size={14} className="mt-1 shrink-0 text-muted-foreground/50 transition-colors group-hover/update:text-primary" aria-hidden="true" />
              </span>
              <span className="mt-2 line-clamp-3 break-words text-xs leading-5 text-foreground/80 sm:ml-[34px]">{(activity.body || activity.subject).replace(/\s+/g, ' ').trim()}</span>
            </button>
          </li>)}</ol>
          <button onClick={() => onActivity(latest.id)} className="mt-3 flex min-h-9 w-full items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-primary transition-colors hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('View more in task activity')}<ArrowRight size={13} aria-hidden="true" /></button>
        </div>
      </details>
    })}
  </div>
}
