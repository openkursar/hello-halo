import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { TFunction } from 'i18next'
import { ArrowUpRight, Check, ChevronDown, Minus, X } from 'lucide-react'
import type { BlackboardTask, RosterMember, TeamActivity, TeamConversation } from '../../../../shared/apps/team-types'
import { useTranslation } from '../../../i18n'
import { markdownDigest, markdownPreview } from '../../../utils/markdown-preview'
import { AutomationAvatar } from '../../apps/AutomationAvatar'
import { MarkdownRenderer } from '../../chat/MarkdownRenderer'
import { openPersonModelSettings } from '../../../utils/people-navigation'
import type { MemberProgress } from './progress'
import { failureFix, memberProgressText, progressMemberName } from './progress-labels'
import { decisionWaitTotal } from './subtasks'
import { formatSpan } from './time'

/** Stands in for a name inside a translated sentence, so the name can be drawn bold. */
export const NAME = '\u0001'

export type BriefTone = 'attention' | 'error' | 'calm' | 'done'

const TONE: Record<BriefTone, { title: string; border: string; fill: string; dot?: string }> = {
  attention: { title: 'text-halo-warning', border: 'border-halo-warning/30', fill: 'bg-halo-warning/[0.06]', dot: 'bg-halo-warning' },
  error: { title: 'text-destructive', border: 'border-halo-error/25', fill: 'bg-halo-error/[0.05]', dot: 'bg-halo-error' },
  calm: { title: 'text-faint-foreground', border: 'border-border-soft', fill: '' },
  done: { title: 'text-faint-foreground', border: 'border-border-soft', fill: '' },
}

/** The border and fill a card in this tone wears, so every card asking for the user reads alike. */
export function toneSurface(tone: BriefTone): string {
  return `${TONE[tone].border} ${TONE[tone].fill}`
}

const FOCUS ='focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary'

/**
 * Where the task stands, one bordered card in every state: the heading says what kind
 * of news it is, the footer whose work it is.
 */
export function BriefCard({ tone, title, footer, label, className = '', children }: {
  tone: BriefTone; title?: ReactNode; footer?: ReactNode; label?: string; className?: string; children: ReactNode
}) {
  const style = TONE[tone]
  return <section data-tone={tone} aria-label={label} className={`overflow-hidden rounded-2xl border ${toneSurface(tone)} [&_b]:font-semibold ${className}`}>
    <div className="px-4 pb-3.5 pt-3">
      {title && <div className={`mb-1 flex items-center gap-1.5 text-[12px] font-medium ${style.title}`}>
        {style.dot && <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${style.dot}`} />}
        {title}
      </div>}
      {children}
    </div>
    {footer && <div className={`flex items-center gap-2 border-t ${style.border} text-[12.5px]`}>{footer}</div>}
  </section>
}

/** One thing that needs the user, with the way to handle it at the line's end. */
export function BriefItem({ text, action }: { text: ReactNode; action?: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 [&:not(:first-child)]:mt-2">
    <p className="min-w-0 flex-1 basis-48 break-words">{text}</p>
    {action && <div className="flex shrink-0 gap-2">{action}</div>}
  </div>
}

/**
 * A failed member: what went wrong in plain words, then who has to fix it. The
 * engine's own error stays one hover away.
 */
export function FailedBriefItem({ row, roster, who }: {
  row: MemberProgress; roster: readonly RosterMember[]; who: (text: string, appId: string) => ReactNode
}) {
  const { t } = useTranslation()
  const fix = failureFix(row, roster, t)
  return <BriefItem text={<span title={row.reason}>
    {who(t('{{name}} ran into an error: {{reason}}', { name: NAME, reason: memberProgressText(row, roster, t) }), row.appId)}
    {fix.text && <span className="text-subtle-foreground"> · {fix.text}</span>}
    {fix.changeModel && <> <button onClick={() => openPersonModelSettings(row.appId)} className="ml-1.5 inline-flex items-center gap-0.5 rounded text-[12.5px] font-medium text-foreground/80 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t('Go handle it')}<ArrowUpRight size={11} aria-hidden="true" /></button></>}
  </span>} />
}

export function BriefButton({ primary, onClick, children }: { primary?: boolean; onClick: () => void; children: ReactNode }) {
  return <button onClick={onClick} className={`h-7 rounded-full px-3 text-[12.5px] transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ${primary ? 'bg-foreground text-background hover:opacity-90' : 'bg-background ring-1 ring-inset ring-border hover:bg-secondary'}`}>{children}</button>
}

/** The card's footer while work runs: who is on which subtask, opening their conversation. */
export function WorkingFooter({ working, roster, onOpenMember }: {
  working: readonly BlackboardTask[]; roster: readonly RosterMember[]; onOpenMember: (appId: string) => void
}) {
  const { t } = useTranslation()
  if (!working.length) return null
  const only = working.length === 1 ? working[0] : null
  if (!only) return <span className="py-2.5 pl-4 pr-4 text-subtle-foreground">{t('{{count}} subtasks are in progress.', { count: working.length })}</span>
  const appId = only.assigneeAppId
  const name = appId ? progressMemberName(roster, appId, t) : t('Unassigned')
  const text = <>
    <AutomationAvatar name={name} size={20} />
    <span className="min-w-0 truncate">{named(t('{{name}} is working on “{{task}}”.', { name: NAME, task: only.title }), name)}</span>
  </>
  const line = 'flex min-w-0 items-center gap-2 py-2.5 pl-4 pr-4 text-subtle-foreground [&_b]:text-foreground/85'
  return appId && roster.some(member => member.appId === appId)
    ? <button onClick={() => onOpenMember(appId)} className={`${line} text-left transition-colors hover:text-foreground ${FOCUS}`}>{text}</button>
    : <span className={line}>{text}</span>
}

/** Tone and heading for a running task's brief: anything failed or waiting on someone needs attention. */
export function activeBriefHead(failed: boolean, waiting: boolean, t: TFunction): { tone: BriefTone; title: string } {
  if (failed || waiting) return { tone: failed ? 'error' : 'attention', title: t('Needs attention') }
  return { tone: 'calm', title: t('Progress') }
}

/** The finished state's mark: a check, as on finished faces, never a dot that reads as "online". */
export function CompletedMark() {
  return <span aria-hidden="true" className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-halo-success text-accent-foreground"><Check size={9} strokeWidth={3.5} /></span>
}

/** A lead's last reply shorter than this is an acknowledgement, not a conclusion. */
const FALLBACK_MIN_CHARS = 16

/**
 * What a finished task ended with: the summary the lead closed it with, else, when it
 * was read off a settled board instead, the lead's last reply in it if that says more than an acknowledgement.
 */
export function finishedSummary(task: TeamConversation, lead: RosterMember | undefined, finals: ReadonlyMap<string, string>): string | undefined {
  const closing = task.completed || task.finishedAt !== undefined ? task.summary?.trim() : undefined
  if (closing) return closing
  const last = lead ? finals.get(lead.appId) : undefined
  return last && markdownPreview(last).length >= FALLBACK_MIN_CHARS ? last : undefined
}

const LEFTOVER_LIMIT = 3
const OUTLINE_LIMIT = 6
/** Past this many entries the outline fades out, saying there is more without listing it all. */
const OUTLINE_FADE_FROM = 4

/**
 * A finished task's result, or null when the status line already says it all: the
 * summary read at a glance, then the subtasks left undone.
 */
export function FinishedBrief({ summary, tasks, lead, onOpenLead, className = '' }: {
  summary: string | undefined; tasks: readonly BlackboardTask[]
  lead: RosterMember | undefined; onOpenLead: (appId: string) => void
  className?: string
}) {
  const { t } = useTranslation()
  const leftovers = tasks.filter(row => row.status !== 'done')
  if (!summary && !leftovers.length) return null
  const list = leftovers.length > 0 && <Leftovers rows={leftovers} />
  if (!summary) return <BriefCard tone="done" label={t('Result')} className={className}>{list}</BriefCard>
  return <SummaryCard summary={summary} lead={lead} onOpenLead={onOpenLead} className={className}>{list}</SummaryCard>
}

/**
 * The summary as a document card: what it opens with, what it covers, and whose it is,
 * the card opening in place into the rendered whole.
 */
function SummaryCard({ summary, lead, onOpenLead, className, children }: {
  summary: string; lead: RosterMember | undefined; onOpenLead: (appId: string) => void
  className: string; children: ReactNode
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [clamped, setClamped] = useState(false)
  const ref = useRef<HTMLParagraphElement>(null)
  const digest = useMemo(() => markdownDigest(summary), [summary])
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => setClamped(element.scrollHeight > element.clientHeight + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [digest, open])
  const more = open || clamped || !digest.whole
  const outline = digest.outline.slice(0, OUTLINE_LIMIT)
  const fade = digest.outline.length > OUTLINE_FADE_FROM
  const footer = <>
    {lead
      ? <button onClick={() => onOpenLead(lead.appId)} className={`flex min-w-0 items-center gap-2 py-2.5 pl-4 pr-2 font-medium text-foreground/85 transition-colors hover:text-foreground ${FOCUS}`}>
        <AutomationAvatar name={lead.memberName} size={20} />
        <span className="truncate">{t('{{name}}’s summary', { name: lead.memberName })}</span>
      </button>
      : <span className="py-2.5 pl-4 font-medium text-foreground/85">{t('Summary')}</span>}
    {more && <button onClick={() => setOpen(value => !value)} aria-expanded={open} className={`ml-auto inline-flex shrink-0 items-center gap-0.5 py-2.5 pl-2 pr-4 text-subtle-foreground transition-colors hover:text-foreground ${FOCUS}`}>
      {open ? t('Collapse') : t('Full text')}<ChevronDown size={13} aria-hidden="true" className={`transition-transform ${open ? 'rotate-180' : ''}`} />
    </button>}
  </>
  return <BriefCard tone="done" label={t('Result')} footer={footer} className={className}>
      {open
        ? <div className="[overflow-wrap:anywhere]"><MarkdownRenderer content={summary} /></div>
        : <>
          {digest.lead && <p ref={ref} className="line-clamp-3 [overflow-wrap:anywhere]">{digest.lead}</p>}
          {outline.length > 0 && <div className={`rounded-xl border border-border-soft px-3 py-2 ${digest.lead ? 'mt-3' : ''}`}>
            <p className="text-[11.5px] leading-5 text-faint-foreground">{t('In this summary')}</p>
            <ul className={`text-[13px] leading-6 text-subtle-foreground ${fade ? '[mask-image:linear-gradient(to_bottom,black_45%,transparent)]' : ''}`}>
              {outline.map((entry, index) => <li key={index} className="truncate">{entry}</li>)}
            </ul>
          </div>}
        </>}
      {children && <div className={digest.lead || outline.length || open ? 'mt-3' : ''}>{children}</div>}
  </BriefCard>
}

function Leftovers({ rows }: { rows: readonly BlackboardTask[] }) {
  const { t } = useTranslation()
  return <ul className="space-y-1 text-[13px]">
    {rows.slice(0, LEFTOVER_LIMIT).map(row => <li key={row.id} className="flex min-w-0 items-center gap-2">
      <span aria-hidden="true" className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground">
        {row.status === 'rejected' ? <X size={10} strokeWidth={3} /> : <Minus size={10} strokeWidth={3} />}
      </span>
      <span className="min-w-0 truncate">{row.title}</span>
      <span className="shrink-0 text-faint-foreground">{row.status === 'rejected' ? t('Rejected') : t('Unfinished')}</span>
    </li>)}
    {rows.length > LEFTOVER_LIMIT && <li className="pl-6 tabular-nums text-faint-foreground">+{rows.length - LEFTOVER_LIMIT}</li>}
  </ul>
}

/** Waits this short beside the task's time are left unsaid. */
const WAIT_MIN_MS = 60_000
const WAIT_MIN_SHARE = 0.1

/**
 * "Of that, waiting for you 4 h": how much of a task's `span` went on waiting for
 * answers, or null when there is no span or the waits hardly count beside it.
 */
export function useWaitText(roster: readonly RosterMember[], activities: readonly TeamActivity[], span: number | null): string | null {
  const { t } = useTranslation()
  return useMemo(() => {
    if (span === null) return null
    const { owners, ms } = decisionWaitTotal(activities, appId => answererOf(roster, appId))
    if (ms < WAIT_MIN_MS || ms < span * WAIT_MIN_SHARE) return null
    const waits = owners.length === 1 ? answererWaitText(roster, owners[0], ms, t) : t('waiting for {{count}} people {{time}}', { count: owners.length, time: formatSpan(ms, t) })
    return t('Of that, {{waits}}', { waits })
  }, [activities, roster, span, t])
}

/** "waiting for you 5 min": who had to answer a member's own question, and for how long. */
export function memberWaitText(roster: readonly RosterMember[], appId: string, ms: number, t: TFunction): string {
  return answererWaitText(roster, answererOf(roster, appId), ms, t)
}

/** "asked you" / "You replied": whom a member's answered question went to, and that it was answered. */
export function memberAnsweredText(roster: readonly RosterMember[], appId: string, t: TFunction): { asked: string; replied: string } {
  const answerer = answererOf(roster, appId)
  if (!answerer) return { asked: t('asked you'), replied: t('You replied') }
  if (answerer.startsWith('owner:')) {
    const owner = answerer.slice(6)
    return { asked: t('asked {{owner}}', { owner }), replied: t('{{owner}} replied', { owner }) }
  }
  return { asked: t('asked its owner'), replied: t('Replied') }
}

/** Who answers a member's questions: '' for you, else its owner or, unnamed, the member. */
function answererOf(roster: readonly RosterMember[], appId: string): string {
  const member = roster.find(row => row.appId === appId)
  if (!member) return `member:${appId}`
  if (member.owner == null && member.sameMachine !== false) return ''
  return member.owner ? `owner:${member.owner}` : `member:${appId}`
}

function answererWaitText(roster: readonly RosterMember[], answerer: string, ms: number, t: TFunction): string {
  const time = formatSpan(ms, t)
  if (!answerer) return t('waiting for you {{time}}', { time })
  if (answerer.startsWith('owner:')) return t('waiting for {{owner}} {{time}}', { owner: answerer.slice(6), time })
  return t('waiting for {{member}}’s owner {{time}}', { member: progressMemberName(roster, answerer.slice(7), t), time })
}

/** A translated sentence with its `NAME` marker drawn as the bold name. */
export function named(text: string, name: string): ReactNode {
  return text.split(NAME).flatMap((part, index) => (index ? [<b key={index}>{name}</b>, part] : [part]))
}

/** `named` with the member's face before the name, leading to their work in this team when they can be opened. */
export function namedMember(text: string, name: string, onOpen?: () => void): ReactNode {
  const who = <><AutomationAvatar name={name} size={18} /><b>{name}</b></>
  const face = 'inline-flex h-[1lh] items-center gap-1.5 align-top'
  return text.split(NAME).flatMap((part, index) => (index ? [onOpen
    ? <button key={index} onClick={onOpen} className={`${face} rounded-md decoration-foreground/30 underline-offset-[3px] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary`}>{who}</button>
    : <span key={index} className={face}>{who}</span>, part] : [part]))
}
