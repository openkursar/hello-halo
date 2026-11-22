import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, ChevronDown, ChevronUp, ListChecks, Lock, MessageCircle } from 'lucide-react'
import type { RosterMember } from '../../../../shared/apps/team-types'
import { useTranslation } from '../../../i18n'
import { AutomationAvatar } from '../../apps/AutomationAvatar'
import { orderTaskMembers, railFit, railMembers, rememberRecent } from './member-rail'
import { progressSummary, type TaskProgress } from './progress'
import { memberProgressText, progressSummaryText } from './progress-labels'
import { TaskMemberPanel } from './TaskMemberPanel'
import { TaskProgressBar } from './TaskProgressBar'

const EMPTY: ReadonlySet<string> = new Set()
const SLIDE_MS = 380
const ENTER_MS = 420
const GAP = 8

type Rect = { x: number; y: number; w: number; h: number }

export interface ConversationProgress {
  progress: TaskProgress
  leadAppId: string | null
  outputCount: number
  onAnswer: (decisionId: string) => void
}

/**
 * The conversation bar of a homepage team conversation: its members as an avatar rail
 * ending in the all-members toggle, then its status, which opens the team progress.
 * `waitingAppIds` / `workingAppIds` describe this conversation only, never a member-wide flag.
 */
export function TaskMemberSelector({ roster, selectedAppId, ownedAppIds, waitingAppIds = EMPTY, workingAppIds = EMPTY, progress, onActivity, onSelect, onAnswer, temporary = false, insideProgress = false }: {
  roster: readonly RosterMember[]
  selectedAppId: string | null
  ownedAppIds: readonly string[]
  waitingAppIds?: ReadonlySet<string>
  workingAppIds?: ReadonlySet<string>
  progress?: ConversationProgress | null
  onActivity?: (activityId?: string) => void
  onSelect: (member: RosterMember) => void
  /** Opens the decision a waiting member asked the user here. */
  onAnswer?: (appId: string) => void
  /**
   * A temporary team led by the ordinary conversation it sits in: its members are
   * watched, not talked to, and none is current while that conversation is shown.
   */
  temporary?: boolean
  /** Shown inside the task's progress, where the status leads back to it rather than opening it. */
  insideProgress?: boolean
}) {
  const { t } = useTranslation()
  const root = useRef<HTMLDivElement>(null)
  const track = useRef<HTMLDivElement>(null)
  const thumb = useRef<HTMLSpanElement>(null)
  const moreButton = useRef<HTMLButtonElement>(null)
  const statusSegment = useRef<HTMLSpanElement>(null)
  const statusBar = useRef<HTMLSpanElement>(null)
  const tag = useRef<HTMLSpanElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const painted = useRef<Rect | null>(null)
  const seen = useRef<Map<string, number> | null>(null)
  const [width, setWidth] = useState(0)
  const [statusWidth, setStatusWidth] = useState(0)
  const [recent, setRecent] = useState<string[]>([])
  const [panelOpen, setPanelOpen] = useState(false)

  useEffect(() => {
    const element = root.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => { if (selectedAppId) setRecent(previous => previous[0] === selectedAppId ? previous : rememberRecent(previous, selectedAppId)) }, [selectedAppId])
  // Measured without the bar, which railFit decides on; the tag beside the bar takes its share too.
  useLayoutEffect(() => {
    const segment = statusSegment.current
    const bar = statusBar.current?.offsetWidth ?? 0
    const status = segment ? segment.offsetWidth - (bar ? bar + 8 : 0) : 0
    setStatusWidth(status + (tag.current ? tag.current.offsetWidth + GAP : 0))
  })

  const owned = new Set(ownedAppIds)
  const ordered = orderTaskMembers(roster, ownedAppIds)
  const waiting = new Set([...waitingAppIds].filter(id => owned.has(id)))
  const progressOf = new Map(progress?.progress.members.map(row => [row.appId, row]) ?? [])
  const failed = new Set([...progressOf.values()].filter(row => row.state === 'failed').map(row => row.appId))
  const fit = width ? railFit(width, statusWidth, ordered.length) : { capacity: 8, bar: true }
  const { shown, hidden } = railMembers(ordered, {
    selectedAppId, ownedAppIds, waiting, working: workingAppIds, recent, capacity: fit.capacity,
  })
  const shownKey = shown.map(member => member.appId).join(',')

  const now = performance.now()
  if (!seen.current) seen.current = new Map(shown.map(member => [member.appId, 0]))
  for (const member of shown) if (!seen.current.has(member.appId)) seen.current.set(member.appId, now)
  for (const id of [...seen.current.keys()]) if (!shown.some(member => member.appId === id)) seen.current.delete(id)
  const entering = (appId: string) => now - (seen.current?.get(appId) ?? 0) < ENTER_MS

  // The thumb follows the selected item's live box while its name unfolds.
  useLayoutEffect(() => {
    const element = thumb.current
    const target = track.current?.querySelector<HTMLElement>('[data-rail-item][aria-pressed="true"]')
    if (!element) return
    if (!target) { element.style.opacity = '0'; painted.current = null; return }
    const from = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? null : painted.current
    const start = performance.now()
    let frame = 0
    const step = (time: number) => {
      const progress = Math.min(1, (time - start) / SLIDE_MS)
      const eased = 1 - (1 - progress) ** 3
      const to = { x: target.offsetLeft, y: target.offsetTop, w: target.offsetWidth, h: target.offsetHeight }
      const rect = from ? {
        x: from.x + (to.x - from.x) * eased, y: from.y + (to.y - from.y) * eased,
        w: from.w + (to.w - from.w) * eased, h: from.h + (to.h - from.h) * eased,
      } : to
      element.style.opacity = '1'
      element.style.transform = `translate(${rect.x}px, ${rect.y}px)`
      element.style.width = `${rect.w}px`
      element.style.height = `${rect.h}px`
      painted.current = rect
      if (progress < 1) frame = requestAnimationFrame(step)
    }
    step(start)
    return () => cancelAnimationFrame(frame)
  }, [selectedAppId, shownKey, width])

  if (!ordered.length) return null
  const cardOf = (member: RosterMember) => {
    const row = progressOf.get(member.appId)
    // A lead's role is often "Team Lead" itself, in English or any casing; show it once.
    const role = member.role?.trim() ?? ''
    const leadRole = member.isLead && [t('Team lead'), 'Team lead'].some(name => name.toLowerCase() === role.toLowerCase())
    const kind = [member.isLead ? t('Team lead') : '', leadRole ? '' : role].filter(Boolean).join(' · ')
    const state: { text: string; tone: string } | null = row?.state === 'waiting' ? { text: memberProgressText(row, roster, t), tone: 'bg-halo-warning' }
      : waiting.has(member.appId) ? { text: t('Waiting for you'), tone: 'bg-halo-warning' }
        : row?.state === 'failed' ? { text: memberProgressText(row, roster, t), tone: 'bg-destructive' }
          : row?.state === 'working' ? { text: memberProgressText(row, roster, t), tone: 'bg-primary' }
            : workingAppIds.has(member.appId) ? { text: t('Working…'), tone: 'bg-primary' }
              : null
    const readOnly = !owned.has(member.appId)
    const access = !readOnly ? (temporary ? '' : t('You can message it'))
      : member.owner ? t('{{owner}}’s digital human · Read-only', { owner: member.owner }) : t('Read-only')
    const offline = readOnly && member.presence === 'offline' ? (member.owner ? t('{{owner}} is offline', { owner: member.owner }) : t('Its owner is offline')) : ''
    return { kind, duty: member.duty?.trim() ?? '', state, readOnly, access, offline, label: [member.memberName, kind, state?.text, access, offline].filter(Boolean).join(' · ') }
  }
  const hiddenWaiting = hidden.filter(member => waiting.has(member.appId)).length
  const pick = (member: RosterMember) => {
    if (onAnswer && waiting.has(member.appId)) onAnswer(member.appId)
    else if (member.appId !== selectedAppId) onSelect(member)
  }
  const toggle = (from: HTMLElement | null) => { opener.current = from; setPanelOpen(open => !open) }
  const close = (refocus = true) => { setPanelOpen(false); if (refocus) opener.current?.focus() }

  const summary = progress ? progressSummary(progress.progress, progress.leadAppId) : null
  // With nothing to report yet, the segment stays as a quiet way into the team progress.
  const label = progress && summary ? progressSummaryText(summary, progress.outputCount, t) : onActivity ? t('Team progress') : null
  const { counts, total } = progress?.progress ?? { counts: null, total: 0 }
  const attention = summary?.kind === 'waiting' || summary?.kind === 'failed' || summary?.kind === 'decision'
  const tone = summary?.kind === 'failed' ? 'text-destructive' : attention ? 'text-halo-warning' : 'text-subtle-foreground'
  const icon = !summary ? <ListChecks size={14} className="text-faint-foreground" />
    : attention ? <AlertCircle size={14} />
      : summary.kind === 'working' ? <span className="flex h-3.5 w-3.5 items-center justify-center"><i className="h-2 w-2 rounded-full bg-primary" /></span>
        : summary.kind === 'done' ? <CheckCircle2 size={14} className="text-halo-success" />
          : <ListChecks size={14} className="text-faint-foreground" />
  const Chevron = panelOpen ? ChevronDown : ChevronUp
  const allMembers = t('All {{count}} members', { count: ordered.length })
  const statusBody = label && <>
    {icon && <span aria-hidden="true" className="shrink-0">{icon}</span>}
    <span>{label}</span>
    {total > 0 && counts && <>
      <span className="text-xs tabular-nums text-subtle-foreground">{counts.done}/{total}</span>
      {fit.bar && <span ref={statusBar} className="hidden sm:flex"><TaskProgressBar counts={counts} className="flex w-11" /></span>}
    </>}
  </>
  const statusLabel = [label, ...(total && counts ? [t('{{done}}/{{total}} tasks done', { done: counts.done, total })] : [])].join(' · ')
  const statusTip = !insideProgress ? t('View team progress')
    : summary?.kind === 'failed' ? t('Back to task details to see what went wrong') : t('Back to task details')

  return <div ref={root} className="flex min-w-0 items-center gap-2">
    {temporary && <span ref={tag} className="shrink-0 whitespace-nowrap rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">{t('Temporary team')}</span>}
    <div ref={track} role="group" aria-label={t('Team members')}
      className="member-rail relative flex max-w-full items-center gap-0.5 rounded-full p-1">
      <span ref={thumb} aria-hidden="true" className="member-rail-thumb" />
      {shown.map(member => {
        const selected = member.appId === selectedAppId
        const card = cardOf(member)
        const state = waiting.has(member.appId) ? 'waiting' : failed.has(member.appId) ? 'failed' : workingAppIds.has(member.appId) ? 'working' : undefined
        const readOnly = !owned.has(member.appId)
        return <button key={member.appId} type="button" data-rail-item="" data-state={state} data-readonly={readOnly ? '' : undefined}
          aria-pressed={selected} aria-label={card.label}
          onClick={() => pick(member)}
          className={`member-rail-item z-[1] flex h-[34px] shrink-0 items-center rounded-full p-[5px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${entering(member.appId) ? 'animate-member-rail-enter' : ''}`}>
          <span className="member-rail-avatar relative flex shrink-0 rounded-full">
            <AutomationAvatar name={member.memberName} size={24} />
            {readOnly && <i aria-hidden="true" className="avatar-lock-badge"><Lock strokeWidth={3} /></i>}
            {state && <i aria-hidden="true" data-tone={state} className="avatar-status-dot" />}
            {onAnswer && state === 'waiting' && !selected && <span aria-hidden="true" className="member-rail-ask">{t('Needs your answer')}</span>}
          </span>
          <span className="member-rail-name truncate text-[13px] font-semibold text-foreground">{member.memberName}</span>
          {!selected && <span aria-hidden="true" className="member-rail-tip" data-card="">
            <span className="flex items-center gap-2.5">
              <span className="flex shrink-0"><AutomationAvatar name={member.memberName} size={36} /></span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-foreground">{member.memberName}</span>
                {card.kind && <span className="mt-0.5 block truncate text-xs text-subtle-foreground">{card.kind}</span>}
              </span>
            </span>
            {card.duty && <span className="mt-3 line-clamp-3 text-[12.5px] leading-[1.55] text-muted-foreground">{card.duty}</span>}
            {card.state && <span className="mt-3 flex items-start gap-2 rounded-lg bg-secondary/70 px-2.5 py-2 text-xs text-foreground">
              <i className={`mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full ${card.state.tone}`} />
              <span className="line-clamp-2">{card.state.text}</span>
            </span>}
            {(card.access || card.offline) && <span className="mt-3 flex flex-col gap-1 border-t border-border-faint pt-2.5 text-xs text-subtle-foreground">
              {card.access && <span className="flex items-center gap-1.5">
                {card.readOnly ? <Lock size={12} aria-hidden="true" className="shrink-0 text-faint-foreground" /> : <MessageCircle size={12} aria-hidden="true" className="shrink-0 text-primary" />}
                <span className="truncate">{card.access}</span>
              </span>}
              {card.offline && <span className="flex items-center gap-1.5 text-faint-foreground">
                <i className="mx-[3px] h-1.5 w-1.5 shrink-0 rounded-full bg-faint-foreground" />
                <span className="truncate">{card.offline}</span>
              </span>}
            </span>}
          </span>}
        </button>
      })}
      <button ref={moreButton} type="button" aria-haspopup="dialog" aria-expanded={panelOpen}
        aria-label={hiddenWaiting ? `${allMembers} · ${t('{{count}} more waiting for you', { count: hiddenWaiting })}` : allMembers}
        onClick={() => toggle(moreButton.current)}
        className={`member-rail-more relative z-[1] flex h-[34px] min-w-[30px] shrink-0 items-center justify-center gap-0.5 rounded-full px-2 text-xs font-medium tabular-nums transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${panelOpen ? 'bg-foreground/[0.07] text-foreground' : 'text-muted-foreground hover:bg-foreground/[0.07] hover:text-foreground'}`}>
        {hidden.length > 0 && <span>+{hidden.length}</span>}
        <Chevron size={14} aria-hidden="true" className="shrink-0" />
        {hiddenWaiting > 0 && <span aria-hidden="true" className="absolute right-[5px] top-1.5 h-1.5 w-1.5 rounded-full bg-halo-warning [box-shadow:0_0_0_2px_var(--member-rail-bg)]" />}
        {!panelOpen && <span aria-hidden="true" className="member-rail-tip">{allMembers}{hiddenWaiting > 0 && <span className="ml-1.5 opacity-65">{t('{{count}} more waiting for you', { count: hiddenWaiting })}</span>}</span>}
      </button>
      {statusBody && <span ref={statusSegment} className="flex shrink-0 items-center">
        <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border" />
        {onActivity
          ? <button type="button" aria-label={summary ? `${statusLabel} · ${statusTip}` : statusTip} onClick={() => onActivity()}
            className={`member-rail-status relative z-[1] flex h-[34px] items-center gap-2 whitespace-nowrap rounded-full pl-2 pr-3 text-[12.5px] transition-colors duration-100 hover:bg-foreground/[0.07] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${tone} ${attention ? '' : 'hover:text-foreground'}`}>
            {statusBody}
            <span aria-hidden="true" className="member-rail-tip">{statusTip}</span>
          </button>
          : <span aria-label={statusLabel} className={`flex h-[34px] items-center gap-2 whitespace-nowrap pl-2 pr-3 text-[12.5px] ${tone}`}>{statusBody}</span>}
      </span>}
    </div>
    {panelOpen && <TaskMemberPanel members={ordered} selectedAppId={selectedAppId} owned={owned} waiting={waiting} working={workingAppIds}
      progress={progress ?? null} onActivity={onActivity} temporary={temporary} anchor={track} triggers={[moreButton]}
      onPick={member => { setPanelOpen(false); pick(member) }} onClose={close} />}
  </div>
}
