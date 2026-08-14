/**
 * Board digest: the short "here is what you missed" a member reads at the top of
 * its turn.
 *
 * It exists because the board does not push. A member only ever learns what
 * teammates did by calling `team_read_board` — a full model round-trip it has to
 * remember to make, and mostly does not. The digest instead rides the turn's
 * input, which is read by construction, and stays silent when there is nothing
 * to say so that its appearing means something.
 *
 * Two halves, and they answer different questions:
 *   - what CHANGED since this member last looked (a delta, per-member watermark);
 *   - what has NOT changed but should have — its own tasks sitting still, its own
 *     messages with no answer. A pure delta can never surface these: "nothing
 *     happened" is not an event, and it is exactly the failure this module is
 *     here to catch.
 *
 * The delta half is ranked, not truncated by recency: its budget belongs to the
 * facts that reach the member nowhere else.
 *
 * What it must never do is turn absence into a verdict. It reports the two facts
 * side by side ("they answered you; that task is still open") and leaves the
 * inference to the reader — the record can prove something WAS recorded, never
 * that something did not happen.
 */

import {
  answeredCorrelationIds,
  isAwaitingReply,
  type TeamActivity,
  type TeamMemberRuntimeStatus,
} from '../../../../shared/apps/team-types'
import type { TeamStore } from '../../team'

const LOG_TAG = '[BoardDigest]'

/** A task or a message untouched for this long is worth mentioning. */
const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1000

/**
 * Cap on lines per section. The digest is a pointer to the board, not a copy of
 * it: past a handful of lines it stops being scanned and starts being skipped.
 */
const MAX_LINES_PER_SECTION = 6

const TERMINAL_TASK_STATUS = new Set(['done', 'rejected'])

export interface BoardDigestDeps {
  store: TeamStore
  /**
   * Live status of a member. A task whose assignee is mid-turn is being worked
   * on, not stalled — reporting it would train the reader to ignore the section.
   * Absent → nobody is treated as working.
   */
  getMemberStatus?: (appId: string) => TeamMemberRuntimeStatus
  now?: () => number
  staleAfterMs?: number
}

export interface BoardDigest {
  /**
   * Build this member's digest and advance its watermark (having been shown the
   * lines, it has now seen them). Null when there is nothing worth saying.
   */
  render(params: { teamId: string; epochId: string; viewerAppId: string }): string | null
  /** Drop an epoch's watermarks when it is sealed. */
  clearEpoch(epochId: string): void
}

export function createBoardDigest(deps: BoardDigestDeps): BoardDigest {
  const { store } = deps
  const now = deps.now ?? (() => Date.now())
  const staleAfterMs = deps.staleAfterMs ?? DEFAULT_STALE_AFTER_MS

  /**
   * Per (epoch, member) high-water mark of what has been shown. In memory and
   * never replicated: losing it costs one repeated digest, which is why it needs
   * no schema, no migration and no convergence story.
   *
   * It deliberately does NOT stand in for the member's memory. A compacted
   * context can forget what the watermark says was seen, which is why the prompt
   * keeps pointing at `team_read_board` as the way to recover facts — the digest
   * pushes, the full read pulls, and neither replaces the other.
   */
  const watermarks = new Map<string, number>()

  const key = (epochId: string, appId: string): string => `${epochId}:${appId}`

  function memberNames(teamId: string): Map<string, string> {
    const names = new Map<string, string>()
    for (const m of store.listMembersByTeam(teamId)) names.set(m.appId, m.memberName)
    return names
  }

  function describeAct(act: TeamActivity, viewerAppId: string, names: Map<string, string>): string | null {
    const actor = names.get(act.actorAppId) ?? act.actorAppId
    const target = act.targetAppId ? names.get(act.targetAppId) ?? act.targetAppId : null
    const toYou = act.targetAppId === viewerAppId
    const quoted = act.subject ? ` "${act.subject}"` : ''

    switch (act.kind) {
      case 'message':
        if (act.status === 'undelivered') return `${actor} tried to reach ${target ?? 'someone'} and it did not arrive`
        return `${actor} → ${target}:${quoted}`
      case 'reply':
        return toYou ? `${actor} answered you:${quoted}` : `${actor} answered ${target}`
      case 'task_post':
        return `${actor} assigned${quoted} to ${target ?? 'someone'}`
      case 'task_update': {
        const title = act.refId ? store.getTaskById(act.refId)?.title : null
        return `${actor} set ${title ? `"${title}"` : 'a task'} to ${act.status ?? 'a new status'}`
      }
      case 'finding':
        return `${actor} shared${quoted}`
      case 'check_set':
        return `${actor} set a recurring check on ${target ?? 'someone'}:${quoted}`
      case 'check_stop':
        return `${actor} stopped a recurring check on ${target ?? 'someone'}`
      case 'run_end':
        return `${actor} ended the run:${quoted}`
      default:
        return null
    }
  }

  /**
   * What happened that this member has no other way of knowing.
   *
   * Dropped before ranking, as already read: the member's own acts, and messages
   * to it accepted for delivery (each arrived as the input of a turn it took).
   * The rest competes for the budget by how else it could be learned — a task
   * moving or a message that never arrived exist nowhere but here, a finding is
   * also a file on the board, traffic between two others is worth only a count.
   */
  function changesFor(
    acts: readonly TeamActivity[],
    viewerAppId: string,
    since: number,
    names: Map<string, string>
  ): string[] {
    const fresh = acts.filter(
      (a) => a.createdAt > since && a.actorAppId !== viewerAppId && !deliveredToViewer(a, viewerAppId)
    )
    const chatter = fresh.filter((a) => isSideChatter(a, viewerAppId))
    const direct = fresh.filter((a) => !isSideChatter(a, viewerAppId))

    const lines: string[] = []
    const roomLeft = (): number => MAX_LINES_PER_SECTION - lines.length
    // Rendered before the cap so an act that renders to nothing cannot spend a
    // line another would have filled; the tail is what the member has least
    // accounted for.
    const pushRecent = (tier: readonly TeamActivity[]): void => {
      const room = roomLeft()
      if (room <= 0) return
      const rendered = tier
        .map((a) => describeAct(a, viewerAppId, names))
        .filter((line): line is string => line !== null)
      lines.push(...rendered.slice(-room))
    }

    pushRecent(direct.filter((a) => a.kind !== 'finding'))
    pushRecent(direct.filter((a) => a.kind === 'finding'))
    const room = roomLeft()
    if (room > 0) lines.push(...foldChatter(chatter, names).slice(0, room))
    return lines
  }

  /**
   * This member's tasks that nothing has moved. Excludes tasks whose assignee is
   * mid-turn: work in flight is not work stalled.
   */
  function stalledTasks(teamId: string, epochId: string, viewerAppId: string): string[] {
    if (deps.getMemberStatus?.(viewerAppId) === 'working') return []
    const cutoff = now() - staleAfterMs
    return store
      .listTasksByEpoch(teamId, epochId)
      .filter(
        (t) =>
          t.assigneeAppId === viewerAppId && !TERMINAL_TASK_STATUS.has(t.status) && t.updatedAt < cutoff
      )
      .slice(0, MAX_LINES_PER_SECTION)
      .map((t) => `"${t.title}" is still ${t.status} — untouched for ${describeAge(now() - t.updatedAt)}`)
  }

  /** Messages this member sent that nothing has answered yet. */
  function unansweredSends(acts: readonly TeamActivity[], viewerAppId: string, names: Map<string, string>): string[] {
    const cutoff = now() - staleAfterMs
    const answered = answeredCorrelationIds(acts)
    return acts
      .filter((a) => a.kind === 'message' && a.actorAppId === viewerAppId)
      .filter((a) => a.createdAt < cutoff && isAwaitingReply(a, answered))
      .slice(0, MAX_LINES_PER_SECTION)
      .map((a) => {
        const to = a.targetAppId ? names.get(a.targetAppId) ?? a.targetAppId : 'a teammate'
        return `you asked ${to} "${a.subject}" ${describeAge(now() - a.createdAt)} ago and nothing has come back`
      })
  }

  function render(params: { teamId: string; epochId: string; viewerAppId: string }): string | null {
    const { teamId, epochId, viewerAppId } = params
    try {
      const names = memberNames(teamId)
      const acts = store.listActivityByEpoch(teamId, epochId)
      const since = watermarks.get(key(epochId, viewerAppId)) ?? 0
      const changes = changesFor(acts, viewerAppId, since, names)
      const stalled = stalledTasks(teamId, epochId, viewerAppId)
      const waiting = unansweredSends(acts, viewerAppId, names)
      // Advance to the newest act actually accounted for, NOT to wall-clock: two
      // acts can share a millisecond, and a clock-based mark would silently skip
      // the second one forever. Acts deliberately not shown (the member's own)
      // still count as accounted for.
      const newest = acts.reduce((max, a) => Math.max(max, a.createdAt), since)
      watermarks.set(key(epochId, viewerAppId), newest)

      if (changes.length === 0 && stalled.length === 0 && waiting.length === 0) return null

      const lines = ['---', 'Board — recorded since you last looked:']
      for (const line of [...changes, ...stalled, ...waiting]) lines.push(`- ${line}`)
      lines.push(
        'This is what has been WRITTEN DOWN, not everything that happened — someone may ' +
          'have done the work and not recorded it. Call team_read_board() for the full board.'
      )
      return lines.join('\n')
    } catch (err) {
      // A digest is an aid; a failure here must never cost the member its turn.
      console.error(`${LOG_TAG} render failed:`, err)
      return null
    }
  }

  function clearEpoch(epochId: string): void {
    for (const k of [...watermarks.keys()]) {
      if (k.startsWith(`${epochId}:`)) watermarks.delete(k)
    }
  }

  return { render, clearEpoch }
}

/**
 * A message this member has already read: anything accepted for delivery arrives
 * as the input of a turn it takes. An undelivered one never did, so the record is
 * the only place it exists.
 */
function deliveredToViewer(act: TeamActivity, viewerAppId: string): boolean {
  return act.kind === 'message' && act.targetAppId === viewerAppId && act.status !== 'undelivered'
}

/**
 * Successful traffic between two OTHER members (the caller has already dropped
 * this member's own acts) — the one class safe to hand over as a count rather
 * than content, since `team_read_board` still has every line. Failures are never
 * folded away.
 */
function isSideChatter(act: TeamActivity, viewerAppId: string): boolean {
  return (
    act.kind === 'message' &&
    act.status === 'sent' &&
    act.targetAppId !== null &&
    act.targetAppId !== viewerAppId
  )
}

/** One line per pair, busiest first: who has been talking, never what about. */
function foldChatter(acts: readonly TeamActivity[], names: Map<string, string>): string[] {
  const pairs = new Map<string, { first: string; second: string; count: number }>()
  for (const act of acts) {
    if (!act.targetAppId) continue
    const [first, second] = [act.actorAppId, act.targetAppId].sort()
    const key = `${first}\u0000${second}`
    const pair = pairs.get(key) ?? { first, second, count: 0 }
    pair.count += 1
    pairs.set(key, pair)
  }
  return [...pairs.values()]
    .sort((a, b) => b.count - a.count)
    .map(({ first, second, count }) => {
      const one = names.get(first) ?? first
      const other = names.get(second) ?? second
      return `${one} and ${other} exchanged ${count} message${count === 1 ? '' : 's'}`
    })
}

/** Coarse, human age ("40 minutes", "2 hours") — precision here is noise. */
function describeAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${Math.max(1, minutes)} minutes`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'}`
}
