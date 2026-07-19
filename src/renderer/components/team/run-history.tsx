/**
 * run-history — shared formatting + grouping for a team's run history.
 *
 * A run is an event, not a named object: it is identified by time · trigger ·
 * outcome (§P0-4), never a title. These pure helpers are the single source of
 * truth for that presentation, reused by the Live board banner, the event
 * sidebar list, and any run row — so the four outcome classes and the trigger
 * wording never drift between surfaces.
 */

import { Sparkles, AlertTriangle, MinusCircle, Clock, Play } from 'lucide-react'
import type { TeamEpochSummary, EpochOutcome, TeamRunTriggerType, TeamConversation } from '../../../shared/apps/team-types'

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
  | { kind: 'group'; key: string; count: number; epochs: TeamEpochSummary[]; triggerType?: TeamRunTriggerType }

/**
 * Split a team's epochs into the run rows (grouping consecutive "no action" runs
 * so a busy scheduler doesn't flood the list) and the archived conversations.
 * Product / escalation / failed / running rows never fold — they always show.
 */
export function groupHistory(epochs: TeamEpochSummary[]): { rows: HistoryRow[]; archived: TeamEpochSummary[] } {
  const archived: TeamEpochSummary[] = []
  const runs: TeamEpochSummary[] = []
  for (const e of epochs) {
    if (e.lifecycle === 'conversation') {
      if (e.endedAt != null) archived.push(e) // open conversations live in the Conversation tab
      continue
    }
    runs.push(e)
  }

  const rows: HistoryRow[] = []
  let bucket: TeamEpochSummary[] = []
  const flush = () => {
    if (bucket.length === 0) return
    if (bucket.length === 1) rows.push({ kind: 'run', epoch: bucket[0] })
    else rows.push({ kind: 'group', key: bucket[0].id, count: bucket.length, epochs: bucket.slice(), triggerType: bucket[0].triggerType })
    bucket = []
  }
  for (const e of runs) {
    if (runOutcome(e) === 'no_action') bucket.push(e)
    else { flush(); rows.push({ kind: 'run', epoch: e }) }
  }
  flush()
  return { rows, archived }
}
