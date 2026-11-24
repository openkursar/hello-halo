import type { BlackboardTask, TeamActivity } from './team-types'

const PREFIX = 'delegation:'

export const isDelegatedTask = (task: BlackboardTask) => task.id.startsWith(PREFIX)

const FAILED = new Set(['undelivered', 'error', 'timeout'])

/** One coordinator's latest ask, whether it arrived, and this member's latest answer or failure after it. */
interface Ask { askedAt: number; delivered: boolean; answeredAt: number; failedAt: number }

interface Delegation {
  first: TeamActivity
  firstAt: number
  asks: Map<string, Ask>
  answer: TeamActivity | null
  answeredAt: number
}

function timeOf(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && !value.trim()) return null
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : null
}

/**
 * A lead may hand work out by message alone, leaving the board empty. Each member
 * a coordinator wrote to then reads as one subtask, done once the member has
 * answered every coordinator's latest message and is not at work. A board finding
 * counts as an answer. A member that has answered a coordinator before may leave a
 * later message unanswered (a closing "approved, no need to reply"): once that message
 * arrived and the member is idle with no failure after it, it is settled too. Until then it is
 * titled by the first message; once done, by the opening line of the member's
 * first report, which says what was actually done (later ones tend to be
 * acknowledgements). A report that opens with a bare file path keeps the first
 * message as title and carries the path as its result.
 *
 * Coordinators are the lead plus any member that wrote before anyone wrote to it:
 * in a standing team each person talks to their own digital human, which then
 * coordinates the others, so the one handing out work need not be the lead.
 *
 * Shared so the task list and the task panel settle a conversation the same way.
 */
export function delegatedTasks({ teamId, epochId, leadAppId, activities, busyAppIds }: {
  teamId: string; epochId: string; leadAppId: string | null; activities: readonly TeamActivity[]; busyAppIds: ReadonlySet<string>
}): BlackboardTask[] {
  const sent = activities
    .filter(activity => (activity.kind === 'message' || activity.kind === 'reply' || activity.kind === 'finding') && activity.epochId === epochId && timeOf(activity.createdAt) !== null)
    .sort((a, b) => timeOf(a.createdAt)! - timeOf(b.createdAt)!)
  const coordinators = new Set(leadAppId ? [leadAppId] : [])
  const addressed = new Set<string>()
  for (const activity of sent) {
    if (activity.kind === 'message' && !addressed.has(activity.actorAppId)) coordinators.add(activity.actorAppId)
    if (activity.targetAppId && activity.targetAppId !== activity.actorAppId) addressed.add(activity.targetAppId)
  }
  const byMember = new Map<string, Delegation>()
  for (const activity of sent) {
    const target = activity.targetAppId
    if (activity.kind !== 'message' || !coordinators.has(activity.actorAppId) || !target || coordinators.has(target)) continue
    const at = timeOf(activity.createdAt)!
    const delivered = !FAILED.has(activity.status ?? '')
    let row = byMember.get(target)
    if (!row) byMember.set(target, row = { first: activity, firstAt: at, asks: new Map(), answer: null, answeredAt: -1 })
    const ask = row.asks.get(activity.actorAppId)
    if (!ask) row.asks.set(activity.actorAppId, { askedAt: at, delivered, answeredAt: -1, failedAt: -1 })
    else if (at >= ask.askedAt) Object.assign(ask, { askedAt: at, delivered })
  }
  for (const activity of sent) {
    const row = byMember.get(activity.actorAppId)
    const at = timeOf(activity.createdAt)!
    if (!row || at < row.firstAt) continue
    const asks = activity.kind === 'finding' ? [...row.asks.values()] : [row.asks.get(activity.targetAppId ?? '')].filter((ask): ask is Ask => !!ask)
    if (!asks.length) continue
    if (FAILED.has(activity.status ?? '')) {
      for (const ask of asks) ask.failedAt = Math.max(ask.failedAt, at)
      continue
    }
    for (const ask of asks) ask.answeredAt = Math.max(ask.answeredAt, at)
    row.answer ??= activity
    row.answeredAt = Math.max(row.answeredAt, at)
  }
  const settled = (ask: Ask) => ask.answeredAt > ask.askedAt || (ask.answeredAt >= 0 && ask.delivered && ask.failedAt < ask.askedAt)
  return [...byMember].map(([appId, row]): BlackboardTask => {
    const asks = [...row.asks.values()]
    const done = asks.every(settled) && !busyAppIds.has(appId)
    const report = done && row.answer ? plainLine(row.answer) : ''
    const file = BARE_PATH.test(report) ? report : null
    return {
      id: `${PREFIX}${appId}`,
      teamId,
      epochId,
      title: (!file && report && shortenPaths(report)) || shortenPaths(plainLine(row.first)),
      assigneeAppId: appId,
      status: done ? 'done' : 'in_progress',
      resultRef: file,
      note: null,
      parentId: null,
      createdByAppId: row.first.actorAppId,
      createdAt: row.firstAt,
      updatedAt: Math.max(row.answeredAt, ...asks.map(ask => ask.askedAt)),
    }
  }).sort((a, b) => a.createdAt - b.createdAt)
}

/** A line that is only a path or file name, such as `reviews/notes.md`. */
const BARE_PATH = /^(?:\S*[\\/]\S+|\S+\.[A-Za-z][A-Za-z0-9]{0,7})$/

/** A message's opening line as plain text. */
function plainLine(activity: Pick<TeamActivity, 'subject' | 'body'>): string {
  const line = activity.body?.split('\n').map(text => text.trim()).find(Boolean) ?? activity.subject.trim()
  return line.replace(/[*`]+/g, '').replace(/^#+\s*/, '').trim()
}

/** Local paths named by their file. */
function shortenPaths(line: string): string {
  return line
    .replace(/(^|[\s:：(（"'“‘])(?:~|[A-Za-z]:)?[\\/](?:[^\s\\/"'”’()（）]+[\\/])+([^\s\\/"'”’()（）]+)/g, '$1$2')
    .trim()
}
