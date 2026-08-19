/**
 * The board as the AGENT reads it.
 *
 * The snapshot used to go out as `JSON.stringify(...)`, which spends most of its
 * budget on things the reader cannot use: every field name repeated once per row,
 * the team and epoch ids it already asked with, and the opaque app ids behind
 * names the tools actually take. Tables state each column once, so the same board
 * costs a fraction of the tokens and reads as what it is — a status page.
 *
 * Two rules keep the compression honest:
 *
 * - **Nothing is truncated.** Long text is reflowed onto one line (a table cell
 *   cannot hold a newline) and never cut. What the JSON carried, this carries.
 * - **Only unusable identifiers are dropped.** A task id stays, because updating
 *   a task needs it verbatim. Activity/finding row ids and app ids go: no tool
 *   takes them, members are addressed by NAME everywhere, and a reader given an
 *   app id has no way to turn it into one.
 *
 * A section that has nothing in it still prints, with "None." An absent heading
 * reads as "not included in this view", which is a different claim from "there
 * is none" — and this file must never blur the two.
 */

import { describeSchedule } from './checks'
import type {
  BlackboardFinding,
  BlackboardSnapshot,
  BlackboardTask,
  RosterMember,
  TeamActivity,
  TeamCheckView,
} from '../../../../shared/apps/team-types'

/**
 * What the read is NOT showing. `total` is every act the epoch holds; `path` is
 * the exported copy of all of them, or null when the export could not be written
 * — in which case the count still gets stated, because "there are 240 earlier
 * entries I cannot show you" is information the reader can act on and silence is
 * not.
 */
export interface BoardHistoryNotice {
  total: number
  path: string | null
}

export interface RenderBoardOptions {
  now: number
  history?: BoardHistoryNotice | null
}

export function renderBoardMarkdown(snapshot: BlackboardSnapshot, options: RenderBoardOptions): string {
  const names = new Map(snapshot.roster.map((m) => [m.appId, m.memberName]))
  const nameOf = (appId: string | null | undefined): string =>
    !appId ? '—' : names.get(appId) ?? appId

  return [
    renderRoster(snapshot.roster),
    renderTasks(snapshot.tasks, nameOf, options.now),
    renderFindings(snapshot.findings, nameOf, options.now),
    renderChecks(snapshot.checks, options.now),
    renderActivity(snapshot.activities, nameOf, options),
  ].join('\n\n')
}

// ── Sections ────────────────────────────────────────

function renderRoster(roster: readonly RosterMember[]): string {
  if (roster.length === 0) return '## Members\nNone.'

  const hasDuty = roster.some((m) => m.duty)
  const hasBusy = roster.some((m) => m.busy && m.busy.length > 0)
  const header = ['member', 'role', ...(hasDuty ? ['duty'] : []), 'status', 'presence', 'machine']
  if (hasBusy) header.push('serving')

  const rows = roster.map((m) => {
    const row = [
      m.isLead ? `${m.memberName} (lead)` : m.memberName,
      m.role,
      ...(hasDuty ? [m.duty ?? ''] : []),
      m.currentTaskTitle ? `${m.status} — ${m.currentTaskTitle}` : m.status,
      // Absent presence means "no reachability signal", which the contract reads
      // as online — a member shown offline gets skipped for work, so the default
      // must never be the pessimistic one.
      m.presence ?? 'online',
      // "whose machine" is what decides whether a raw path from them is readable
      // here, so it is spelled out rather than left as a boolean. An unknown
      // origin reads as remote: sending a bare path to a teammate who cannot open
      // it fails silently, while an unnecessary artifact read merely costs a call.
      m.sameMachine ? 'yours' : m.owner ? `${m.owner}'s` : "a teammate's",
    ]
    if (hasBusy) row.push((m.busy ?? []).map((b) => b.label).join('; '))
    return row
  })

  return `## Members (${roster.length})\n${table(header, rows)}`
}

function renderTasks(
  tasks: readonly BlackboardTask[],
  nameOf: (appId: string | null | undefined) => string,
  now: number
): string {
  if (tasks.length === 0) return '## Tasks\nNone.'

  const hasResult = tasks.some((t) => t.resultRef)
  const hasNote = tasks.some((t) => t.note)
  const hasParent = tasks.some((t) => t.parentId)
  const header = [
    'id',
    'title',
    'assignee',
    'status',
    'by',
    'updated',
    ...(hasResult ? ['result file'] : []),
    ...(hasNote ? ['note'] : []),
    ...(hasParent ? ['parent'] : []),
  ]

  const rows = tasks.map((t) => [
    t.id,
    t.title,
    nameOf(t.assigneeAppId),
    t.status,
    nameOf(t.createdByAppId),
    ago(now, t.updatedAt),
    ...(hasResult ? [t.resultRef ?? ''] : []),
    ...(hasNote ? [t.note ?? ''] : []),
    ...(hasParent ? [t.parentId ?? ''] : []),
  ])

  return `## Tasks (${tasks.length})\n${table(header, rows)}`
}

/**
 * A list, not a table: a finding's body is prose that can run to paragraphs, and
 * folding it into a cell would make every other column unreadable beside it.
 */
function renderFindings(
  findings: readonly BlackboardFinding[],
  nameOf: (appId: string | null | undefined) => string,
  now: number
): string {
  if (findings.length === 0) return '## Findings\nNone.'

  const entries = findings.map((f) => {
    const head = [`${ago(now, f.createdAt)} · ${nameOf(f.authorAppId)}`, f.ref ? `file: ${f.ref}` : null]
      .filter(Boolean)
      .join(' · ')
    const body = f.body ? `\n  ${f.body.split('\n').join('\n  ')}` : ''
    return `- ${head}${body}`
  })

  return `## Findings (${findings.length})\n${entries.join('\n')}`
}

function renderChecks(checks: readonly TeamCheckView[], now: number): string {
  if (checks.length === 0) return '## Periodic checks\nNone.'

  const rows = checks.map((c) => [
    c.id,
    c.targetMemberName,
    describeSchedule(c.schedule),
    c.createdByMemberName,
    String(c.runCount),
    c.lastRunAt ? ago(now, c.lastRunAt) : 'never',
    c.reachable ? 'yes' : 'no (owner offline)',
    c.instruction,
  ])

  const header = ['id', 'target', 'schedule', 'set by', 'runs', 'last run', 'armed', 'instruction']
  return `## Periodic checks (${checks.length})\n${table(header, rows)}`
}

function renderActivity(
  activities: readonly TeamActivity[],
  nameOf: (appId: string | null | undefined) => string,
  options: RenderBoardOptions
): string {
  const { now, history } = options
  const withheld = history ? Math.max(0, history.total - activities.length) : 0

  const heading =
    withheld > 0
      ? `## Recent activity — the latest ${activities.length} of ${history!.total}`
      : `## Recent activity (${activities.length})`

  const body =
    activities.length === 0
      ? 'None.'
      : renderActivityTable(activities, nameOf, (at) => ago(now, at))

  if (withheld === 0) return `${heading}\n${body}`

  // Said in full every time it applies: a reader that does not know its view is
  // partial will reason from the gap as though it were evidence of absence.
  const tail = history!.path
    ? `\n\nThe ${withheld} earlier entries are NOT above. The complete record of this piece of work is at:\n` +
      `${history!.path}\n` +
      'Read it (or Grep it for a name or a phrase) before concluding that something was never done — ' +
      'this view alone cannot tell you that.'
    : `\n\nThere are ${withheld} earlier entries that are not shown here and could not be exported ` +
      'just now. Do not read their absence as evidence that nothing happened earlier.'

  return `${heading}\n${body}${tail}`
}

/**
 * One act per row, shared by the board's recent window and the exported full
 * record so the two cannot describe an act differently. Only the time format
 * differs between them — "5m ago" is what a live reader wants, an absolute
 * timestamp is what an archive read hours later needs.
 */
export function renderActivityTable(
  activities: readonly TeamActivity[],
  nameOf: (appId: string | null | undefined) => string,
  formatWhen: (createdAt: number) => string
): string {
  return table(
    ['when', 'actor', 'act', 'target', 'subject', 'status'],
    activities.map((a) => [
      formatWhen(a.createdAt),
      nameOf(a.actorAppId),
      a.kind,
      nameOf(a.targetAppId),
      a.subject,
      a.status ?? '',
    ])
  )
}

// ── Primitives ──────────────────────────────────────

function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`]
  for (const row of rows) lines.push(`| ${row.map(cell).join(' | ')} |`)
  return lines.join('\n')
}

/**
 * Reflow, never cut. Newlines and pipes are the only two characters a table cell
 * cannot hold, so those are the only two that change.
 */
function cell(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.replace(/\|/g, '\\|')
}

/**
 * Coarse on purpose. An agent reads this to judge "is this stale or fresh", and
 * a wall-clock timestamp costs more tokens to say the same thing less directly.
 */
function ago(now: number, then: number): string {
  const minutes = Math.floor(Math.max(0, now - then) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
