/**
 * The AI review card of "Overview & review". Shows only what it is given (the
 * card state and the actions), so each state can be rendered on its own.
 * Reviews are started by the user here; each runs as a conversation of the
 * space, and its last reply is the report.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Loader2,
  MessageSquare,
  Plus,
  RotateCcw,
  Sparkles,
  Square,
  Users,
  X,
  Zap,
} from 'lucide-react'
import type { CodeReviewAvailability } from '../../../../../../shared/types/code-review'
import { useTranslation } from '../../../../../i18n'
import { useViewerResources } from '../../../viewer-resources'
import { Menu, MenuItem } from '../shared/Menu'
import { formatCompact, formatDuration, formatTime } from '../shared/format'
import type { ReviewCardState, ReviewVariant } from './review-state'

type RunningState = Extract<ReviewCardState, { kind: 'running' }>
type DoneState = Extract<ReviewCardState, { kind: 'done' }>
type Translate = ReturnType<typeof useTranslation>['t']

export interface ReviewCardProps {
  state: ReviewCardState
  /** Whether a team review can run; null while not known yet. */
  team: CodeReviewAvailability['team'] | null
  /** The compare scope has no changes, so there is nothing to review. */
  nothingToReview: boolean
  starting: ReviewVariant | null
  /** The last start failed: which review, and why. */
  startError: { variant: ReviewVariant; message: string } | null
  onStart: (variant: ReviewVariant) => void
  onStop: () => void
  onOpenConversation: () => void
  onAddReport: () => void
  renderReport: (state: DoneState) => ReactNode
}

const BUTTON = 'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-[12.5px] text-foreground transition-colors hover:bg-secondary disabled:cursor-default disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60'

export function ReviewCard(props: ReviewCardProps) {
  const { t } = useTranslation()
  const { state } = props
  return (
    <section className="min-w-0 rounded-lg border border-border bg-card p-3" aria-label={t('AI review')}>
      <p className="sr-only" aria-live="polite">{announcement(state, t)}</p>
      {state.kind === 'idle' && <IdleBody {...props} deleted={state.deleted} />}
      {state.kind === 'loading' && (
        <>
          <Header title={variantName(state.variant, t)} />
          <p className="flex items-center gap-2 text-[12.5px] text-subtle-foreground">
            <Loader2 size={13} className="animate-spin" aria-hidden />{t('Loading…')}
          </p>
        </>
      )}
      {state.kind === 'running' && <RunningBody {...props} state={state} />}
      {state.kind === 'stopped' && (
        <Header title={t('Review stopped')} actions={<><ConversationButton {...props} /><ReviewAgain {...props} variant={state.variant} /></>} />
      )}
      {state.kind === 'failed' && (
        <>
          <Header title={t('The review ended without a report')} actions={<><ConversationButton {...props} /><ReviewAgain {...props} variant={state.variant} /></>} />
          {state.error && <p className="break-words text-[12.5px] text-muted-foreground">{state.error}</p>}
        </>
      )}
      {state.kind === 'done' && <DoneBody {...props} state={state} />}
      <StartError {...props} />
    </section>
  )
}

function announcement(state: ReviewCardState, t: Translate): string {
  switch (state.kind) {
    case 'running': return state.variant === 'team' ? t('Team review in progress') : t('Quick review in progress')
    case 'done': return state.variant === 'team' ? t('Team review report') : t('Quick review report')
    case 'stopped': return t('Review stopped')
    case 'failed': return t('The review ended without a report')
    default: return ''
  }
}

function variantName(variant: ReviewVariant, t: Translate): string {
  return variant === 'team' ? t('Team review') : t('Quick review')
}

function Header({ title, meta, actions }: { title: string; meta?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
      <h3 className="flex min-w-0 items-center gap-1.5 text-[13px] font-semibold text-foreground">
        <Sparkles size={14} className="shrink-0 text-primary" aria-hidden />
        <span className="min-w-0">{title}</span>
      </h3>
      {meta && <span className="text-[12px] text-subtle-foreground">{meta}</span>}
      {actions && <span className="ml-auto flex flex-wrap items-center gap-1.5">{actions}</span>}
    </div>
  )
}

function StartError({ startError, starting, onStart }: ReviewCardProps) {
  const { t } = useTranslation()
  if (!startError || starting !== null) return null
  return (
    <div role="alert" className="mt-2 flex flex-wrap items-start gap-x-2 gap-y-1 text-[12.5px] text-foreground">
      <AlertTriangle size={13} className="mt-0.5 shrink-0 text-destructive" aria-hidden />
      <span className="min-w-0 flex-1 break-words">{t('Couldn\'t start the review: {{reason}}', { reason: startError.message })}</span>
      <button type="button" onClick={() => onStart(startError.variant)} className="shrink-0 font-medium text-primary hover:underline">
        {t('Try again')}
      </button>
    </div>
  )
}

// ── Not reviewed yet ──

function IdleBody({ team, nothingToReview, starting, onStart, deleted }: ReviewCardProps & { deleted: boolean }) {
  const { t } = useTranslation()
  const teamUnavailable = team !== null && !team.available
  const busy = starting !== null
  return (
    <>
      <Header title={t('AI review')} meta={t('Starts a new review conversation in this space')} />
      {deleted && <p className="mb-2 text-[12.5px] text-subtle-foreground">{t('The review conversation was deleted')}</p>}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-2">
        <Choice
          icon={<Zap size={14} className="text-primary" aria-hidden />}
          title={t('Quick review')}
          description={t('One agent reads the changes and the code around them, then writes a report.')}
          meta={t('Usually 1–3 min · follows your project\'s rules (AGENTS.md, CLAUDE.md…)')}
          disabled={busy || nothingToReview}
          busy={starting === 'quick'}
          onClick={() => onStart('quick')}
        />
        <Choice
          icon={<Users size={14} className="text-primary" aria-hidden />}
          title={t('Team review')}
          description={t('Three agents review architecture, regressions, and performance & prompts separately, then challenge each other\'s findings.')}
          meta={t('Usually 5–15 min · follows your project\'s rules')}
          note={teamUnavailable ? t('Team review isn\'t available right now') : undefined}
          warning={teamUnavailable ? undefined : t('Starts 3 sub-agents · uses about 4–6× the tokens')}
          disabled={busy || nothingToReview || teamUnavailable}
          busy={starting === 'team'}
          onClick={() => onStart('team')}
        />
      </div>
      {nothingToReview && <p className="mt-2 text-[12.5px] text-subtle-foreground">{t('No changes to review')}</p>}
    </>
  )
}

function Choice({ icon, title, description, meta, note, warning, disabled, busy, onClick }: {
  icon: ReactNode
  title: string
  description: string
  meta: string
  note?: string
  warning?: string
  disabled: boolean
  busy: boolean
  onClick: () => void
}) {
  const id = useId()
  // Named by its title; the rest is its description, why it cannot run first.
  const described = [note && `${id}-note`, warning && `${id}-warning`, `${id}-description`, `${id}-meta`].filter(Boolean).join(' ')
  return (
    <button
      type="button"
      // A choice that cannot run stays focusable, so its reason can be read.
      onClick={disabled ? undefined : onClick}
      aria-disabled={disabled || undefined}
      aria-busy={busy || undefined}
      aria-labelledby={`${id}-title`}
      aria-describedby={described}
      className={`flex min-w-0 flex-col gap-1.5 rounded-lg border border-border bg-background p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 ${
        disabled && !busy ? 'cursor-default opacity-60' : busy ? 'cursor-default border-primary/60' : 'hover:border-primary/60'
      }`}
    >
      <span id={`${id}-title`} className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
        {busy ? <Loader2 size={14} className="animate-spin text-primary" aria-hidden /> : icon}
        {title}
      </span>
      <span id={`${id}-description`} className="text-[12.5px] text-muted-foreground">{description}</span>
      <span id={`${id}-meta`} className="text-[11.5px] text-subtle-foreground">{meta}</span>
      {note && <span id={`${id}-note`} className="text-[12px] text-foreground">{note}</span>}
      {warning && (
        <span id={`${id}-warning`} className="flex items-start gap-1.5 text-[12px] text-foreground">
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-halo-warning" aria-hidden />
          {warning}
        </span>
      )}
    </button>
  )
}

// ── Running ──

/** Re-renders every `ms` while `active`, for a clock on screen. */
function useNow(active: boolean, ms: number): number {
  const resources = useViewerResources()
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!active) return
    const scope = resources.scope()
    setNow(Date.now())
    scope.add(clearing(setInterval(() => setNow(Date.now()), ms)))
    return () => scope.dispose()
  }, [active, ms, resources])
  return now
}

function clearing(timer: ReturnType<typeof setInterval>): () => void {
  return () => clearInterval(timer)
}

function RunningBody(props: ReviewCardProps & { state: RunningState }) {
  const { t, i18n } = useTranslation()
  const { state, onStop } = props
  const now = useNow(true, 1_000)
  const todos = state.todos ?? []
  return (
    <>
      <Header
        title={state.variant === 'team' ? t('Team review in progress') : t('Quick review in progress')}
        meta={formatDuration(now - state.startedAt, i18n.language)}
        actions={(
          <>
            <ConversationButton {...props} />
            <button type="button" onClick={onStop} className={BUTTON}>
              <Square size={12} aria-hidden />{t('Stop')}
            </button>
          </>
        )}
      />
      {state.members ? (
        <ul className="flex flex-col">
          {state.members.map((member) => <MemberRow key={member.name} member={member} />)}
        </ul>
      ) : todos.length > 0 ? (
        <ul className="flex flex-col">
          {todos.map((todo, index) => <TodoRow key={`${index}:${todo.content}`} todo={todo} />)}
        </ul>
      ) : (
        <p className="flex items-center gap-2 py-1 text-[12.5px] text-muted-foreground">
          <PulseDot />{t('Getting started…')}
        </p>
      )}
      {state.activity && (
        <p className="mt-2 flex min-w-0 items-center gap-2 rounded-md bg-secondary px-2.5 py-1.5 text-[12.5px] text-muted-foreground">
          <Loader2 size={12} className="shrink-0 animate-spin" aria-hidden />
          <span className="min-w-0 truncate">{t(state.activity.key, state.activity.params)}</span>
        </p>
      )}
      <p className="mt-2 text-[11.5px] text-subtle-foreground">{t('You can leave this page')}</p>
    </>
  )
}

function PulseDot() {
  return <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-primary" aria-hidden />
}

function TodoRow({ todo }: { todo: NonNullable<RunningState['todos']>[number] }) {
  const done = todo.status === 'completed'
  const active = todo.status === 'in_progress'
  return (
    <li className="flex items-start gap-2 border-t border-border py-1.5 text-[12.5px] first:border-t-0">
      <span className="flex h-[18px] w-3.5 shrink-0 items-center justify-center">
        {done ? <Check size={13} className="text-diff-add" aria-hidden />
          : active ? <PulseDot />
            : <span className="h-2 w-2 rounded-full border border-subtle-foreground" aria-hidden />}
      </span>
      <span className={`min-w-0 break-words ${done ? 'text-muted-foreground' : 'text-foreground'}`}>
        {active ? todo.activeForm ?? todo.content : todo.content}
      </span>
    </li>
  )
}

function MemberRow({ member }: { member: NonNullable<RunningState['members']>[number] }) {
  const { t } = useTranslation()
  const status = member.state === 'working' ? t('Reviewing…')
    : member.state === 'done' ? t('Done')
      : member.state === 'failed' ? t('Failed')
        : t('Waiting')
  return (
    <li className="flex min-w-0 items-center gap-2 border-t border-border py-1.5 text-[12.5px] first:border-t-0">
      <span className="flex w-3.5 shrink-0 justify-center">
        {member.state === 'done' ? <Check size={13} className="text-diff-add" aria-hidden />
          : member.state === 'failed' ? <X size={13} className="text-diff-del" aria-hidden />
            : member.state === 'working' ? <PulseDot />
              : <span className="h-2 w-2 rounded-full border border-subtle-foreground" aria-hidden />}
      </span>
      <span className="shrink-0 font-medium text-foreground">{member.name}</span>
      {member.role && <span className="min-w-0 truncate text-subtle-foreground">{member.role}</span>}
      <span className="ml-auto shrink-0 text-muted-foreground">{status}</span>
    </li>
  )
}

// ── Done ──

function DoneBody(props: ReviewCardProps & { state: DoneState }) {
  const { t, i18n } = useTranslation()
  const { state, starting, nothingToReview, onStart, onAddReport, renderReport } = props
  const lang = i18n.language
  const when = formatTime(state.finishedAt, lang)
  const meta = [
    state.tookMs !== null ? t('{{time}} · took {{duration}}', { time: when, duration: formatDuration(state.tookMs, lang) }) : when,
    state.tokens !== null ? t('{{tokens}} tokens', { tokens: formatCompact(state.tokens, lang) }) : null,
  ].filter(Boolean).join(' · ')
  return (
    <>
      {state.changedSince > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-halo-warning/10 px-2.5 py-1.5 text-[12.5px] text-foreground">
          <AlertTriangle size={13} className="shrink-0 text-halo-warning" aria-hidden />
          <span className="min-w-0 flex-1">
            {t('Based on the changes at {{time}}. {{count}} files have changed since.', { time: formatTime(state.basedOn, lang), count: state.changedSince })}
          </span>
          <button type="button" disabled={starting !== null || nothingToReview} onClick={() => onStart(state.variant)} className={BUTTON}>
            {starting === state.variant ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <RotateCcw size={12} aria-hidden />}
            {t('Review again')}
          </button>
        </div>
      )}
      <Header
        title={state.variant === 'team' ? t('Team review report') : t('Quick review report')}
        meta={meta}
        actions={<><ConversationButton {...props} /><ReviewAgain {...props} variant={state.variant} /></>}
      />
      {renderReport(state)}
      <div className="mt-3 flex justify-end border-t border-border pt-2.5">
        <button
          type="button"
          onClick={onAddReport}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <Plus size={14} aria-hidden />{t('Add full report to chat')}
        </button>
      </div>
    </>
  )
}

// ── Shared actions ──

function ConversationButton({ onOpenConversation }: ReviewCardProps) {
  const { t } = useTranslation()
  return (
    <button type="button" onClick={onOpenConversation} className={BUTTON}>
      <MessageSquare size={12} aria-hidden />{t('Open conversation')}
    </button>
  )
}

function ReviewAgain({ team, starting, nothingToReview, onStart }: ReviewCardProps & { variant: ReviewVariant }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const teamUnavailable = team !== null && !team.available
  const pick = (variant: ReviewVariant) => {
    setOpen(false)
    onStart(variant)
  }
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={starting !== null || nothingToReview}
        title={nothingToReview ? t('No changes to review') : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        className={BUTTON}
      >
        {starting !== null ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <RotateCcw size={12} aria-hidden />}
        {t('Review again')}
        <ChevronDown size={12} aria-hidden />
      </button>
      <Menu open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} label={t('Review again')} align="end">
        <MenuItem icon={<Zap size={13} />} onSelect={() => pick('quick')}>{t('Quick review · one agent')}</MenuItem>
        <MenuItem
          icon={<Users size={13} />}
          disabled={teamUnavailable}
          description={teamUnavailable ? t('Team review isn\'t available right now') : undefined}
          onSelect={() => pick('team')}
        >
          {t('Team review · 3 sub-agents, more tokens')}
        </MenuItem>
      </Menu>
    </>
  )
}
