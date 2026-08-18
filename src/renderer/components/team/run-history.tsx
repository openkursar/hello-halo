/**
 * run-history — shared formatting + grouping for a team's past work.
 *
 * Two kinds of thing appear in that list and they are presented differently:
 * a RUN is an event, identified by time · trigger · outcome and never a title;
 * a CONVERSATION is a named thing you go back to. These pure helpers are
 * the single source of truth for both presentations, reused by the Live board
 * banner and the event sidebar — so the outcome classes, the trigger wording,
 * and the conversation fallbacks never drift between surfaces.
 */

import { Sparkles, AlertTriangle, MinusCircle, Clock, Play } from 'lucide-react'
import type {
  TeamEpochSummary,
  EpochOutcome,
  TeamRunTriggerType,
  TeamConversation,
  TeamMember,
  RosterMember,
} from '../../../shared/apps/team-types'

type LucideIcon = typeof Sparkles

/**
 * Display name for a conversation entry: a proper-noun label from main always
 * wins; otherwise a neutral per-kind category (the only place this fallback
 * lives, so the session list, event sidebar and live board never diverge).
 */
export function conversationLabel(c: TeamConversation, t: (k: string) => string): string {
  if (c.label && c.label.trim()) return c.label
  if (c.kind === 'native') return t('New session')
  if (c.kind === 'im') return t('Chat')
  return t('Direct message')
}

/** Effective outcome for a run row: an in-flight run is 'running', else its stamped class. */
export function runOutcome(e: TeamEpochSummary): EpochOutcome | 'running' {
  if (e.endedAt == null) return 'running'
  return e.outcome ?? (e.endReason === 'error' || e.endReason === 'timeout' ? 'failed' : 'no_action')
}

/** Icon + tint + plain-language label per run outcome (the §P0-4 four classes + running). */
export function outcomeMeta(
  outcome: EpochOutcome | 'running',
  e: TeamEpochSummary | null,
  t: (k: string, o?: Record<string, unknown>) => string
): { Icon: LucideIcon; cls: string; label: string } {
  switch (outcome) {
    case 'running':
      return { Icon: Play, cls: 'text-emerald-500', label: t('Running') }
    case 'output':
      return {
        Icon: Sparkles, cls: 'text-emerald-500',
        label: e?.artifactCount && e.artifactCount > 0
          ? t('Produced {{count}} files', { count: e.artifactCount })
          : t('Produced results'),
      }
    case 'escalation':
      return { Icon: AlertTriangle, cls: 'text-amber-500', label: t('Waiting on your decision') }
    case 'failed':
      return {
        Icon: e?.endReason === 'timeout' ? Clock : AlertTriangle,
        cls: 'text-red-500',
        label: e?.endReason === 'timeout' ? t('Timed out') : t('Interrupted'),
      }
    case 'no_action':
    default:
      return { Icon: MinusCircle, cls: 'text-muted-foreground', label: t('No action needed') }
  }
}

/**
 * The roster a REPLAYED run renders: who took part, drawn at rest — a past run
 * has no live pulse, and showing today's working state on yesterday's shape
 * would claim work happened there that did not.
 *
 * One state is carried forward from the live roster, because it is not a fact
 * about the past run at all: a decision still unanswered is a person's open
 * question, true right now. Resting it too made "who is waiting on whom"
 * disappear the moment a past run was focused — the exact moment someone is
 * looking for what stalled. A member no longer on the team simply rests.
 */
export function replayRoster(members: TeamMember[], liveRoster: RosterMember[]): RosterMember[] {
  return members.map(m => {
    const live = liveRoster.find(r => r.appId === m.appId)
    const stillWaiting = live?.status === 'waiting_user'
    return {
      appId: m.appId,
      memberName: m.memberName,
      role: m.role,
      isLead: m.isLead,
      spaceId: null,
      status: stillWaiting ? 'waiting_user' : 'idle',
      // Who the question belongs to travels with it: without these the statement
      // cannot tell the reader from a teammate, and defaults to addressing them.
      ...(stillWaiting ? { owner: live?.owner ?? null, sameMachine: live?.sameMachine } : {}),
    }
  })
}

/** Human name for what started a run (§8.3). */
export function triggerLabel(type: TeamRunTriggerType | undefined, t: (k: string) => string): string {
  switch (type) {
    case 'schedule': return t('Scheduled')
    case 'http': return t('Webhook')
    case 'event': return t('Event')
    case 'manual':
    default: return t('Manual')
  }
}

/**
 * A run's stable identity — `time · trigger` — used from the moment it starts,
 * live or sealed. A run is an event, not a named object; "in progress" is a
 * STATUS (shown as a pulse/banner), never the title. Absent epoch (a run that
 * just started before its row loaded) → a brief neutral fallback.
 */
export function runEventTitle(epoch: TeamEpochSummary | undefined, t: (k: string) => string): string {
  if (!epoch) return t('Just now')
  return `${formatRunTime(epoch.startedAt)} · ${triggerLabel(epoch.triggerType, t)}`
}

/**
 * Which piece of work an epoch is, each kind named the way that kind is named
 * everywhere else. For lists that show something belonging to a run or a
 * conversation from OUTSIDE it, where the row cannot otherwise say where it
 * came from.
 */
export function epochWorkLabel(
  epochId: string,
  conversations: TeamConversation[],
  epochs: TeamEpochSummary[],
  t: (k: string) => string
): string {
  const conversation = conversations.find(c => c.epochId === epochId)
  if (conversation) return conversationLabel(conversation, t)
  return runEventTitle(epochs.find(e => e.id === epochId), t)
}

/** Compact absolute time for a run row (a run is placed by WHEN it ran). */
export function formatRunTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch { return '' }
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

// ── Grouping (§6.5): consecutive "no action" runs collapse; the rest stand alone ──

export type HistoryRow =
  | { kind: 'run'; epoch: TeamEpochSummary }
  | { kind: 'conversation'; epoch: TeamEpochSummary }
  | { kind: 'group'; key: string; count: number; epochs: TeamEpochSummary[]; triggerType?: TeamRunTriggerType }

/**
 * One time-ordered list of everything the team has worked on — runs AND
 * conversations — newest activity first.
 *
 * A conversation is not a run, but it IS a unit of work with a board of its own,
 * so leaving it out made the tasks it produced unreachable the moment nobody was
 * actively typing in it. Ordering is by LAST ACTIVITY, never creation: a thread
 * opened last week and used ten minutes ago belongs at the top.
 *
 * Consecutive "no action" RUNS still fold into one row so a busy scheduler
 * cannot flood the list; a conversation breaks the fold (it is a named thing the
 * user is looking for by name, never a footnote).
 */
export function groupHistory(epochs: TeamEpochSummary[]): { rows: HistoryRow[] } {
  const ordered = [...epochs].sort((a, b) => lastActivityOf(b) - lastActivityOf(a))

  const rows: HistoryRow[] = []
  let bucket: TeamEpochSummary[] = []
  const flush = () => {
    if (bucket.length === 0) return
    if (bucket.length === 1) rows.push({ kind: 'run', epoch: bucket[0] })
    else rows.push({ kind: 'group', key: bucket[0].id, count: bucket.length, epochs: bucket.slice(), triggerType: bucket[0].triggerType })
    bucket = []
  }
  for (const e of ordered) {
    if (e.lifecycle === 'conversation') { flush(); rows.push({ kind: 'conversation', epoch: e }); continue }
    if (runOutcome(e) === 'no_action') bucket.push(e)
    else { flush(); rows.push({ kind: 'run', epoch: e }) }
  }
  flush()
  return { rows }
}

/** When this unit of work last moved (falls back to its start for legacy rows). */
export function lastActivityOf(e: TeamEpochSummary): number {
  return e.lastActivityAt || e.startedAt
}

/**
 * Display name for an epoch row: a conversation is a named thing, a run is an
 * event placed by when it ran. Mirrors {@link conversationLabel}'s fallbacks for
 * a conversation whose label never resolved.
 */
export function epochLabel(e: TeamEpochSummary, t: (k: string) => string): string {
  if (e.lifecycle !== 'conversation') return runEventTitle(e, t)
  return e.label?.trim() || t('New session')
}
