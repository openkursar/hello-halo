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
 * It reports one thing and nothing else: what CHANGED on the board since this
 * member last looked, as a delta against a per-member watermark. Every line is
 * an act somebody actually filed.
 *
 * It deliberately does NOT judge — no "that task looks stalled", no "nobody
 * answered you". Those are inferences drawn from absence, and absence is not
 * evidence here: the record can prove something WAS written down, never that
 * something did not happen. An inference that cannot be made reliably, repeated
 * every turn, teaches the reader to skip the whole block — taking the facts down
 * with it.
 *
 * The delta is ranked, not truncated by recency: its budget belongs to the facts
 * that reach the member nowhere else.
 */

import type { TeamActivity } from '../../../../shared/apps/team-types'
import type { TeamStore } from '../../team'

const LOG_TAG = '[BoardDigest]'

/**
 * Cap on lines. The digest is a pointer to the board, not a copy of it: past a
 * handful of lines it stops being scanned and starts being skipped.
 */
const MAX_LINES = 6

export interface BoardDigestDeps {
  store: TeamStore
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
    const roomLeft = (): number => MAX_LINES - lines.length
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

  function render(params: { teamId: string; epochId: string; viewerAppId: string }): string | null {
    const { teamId, epochId, viewerAppId } = params
    try {
      const names = memberNames(teamId)
      const acts = store.listActivityByEpoch(teamId, epochId)
      const since = watermarks.get(key(epochId, viewerAppId)) ?? 0
      const changes = changesFor(acts, viewerAppId, since, names)
      // Advance to the newest act actually accounted for, NOT to wall-clock: two
      // acts can share a millisecond, and a clock-based mark would silently skip
      // the second one forever. Acts deliberately not shown (the member's own)
      // still count as accounted for.
      const newest = acts.reduce((max, a) => Math.max(max, a.createdAt), since)
      watermarks.set(key(epochId, viewerAppId), newest)

      if (changes.length === 0) return null

      const lines = ['---', 'Board — recorded since you last looked:']
      for (const line of changes) lines.push(`- ${line}`)
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
