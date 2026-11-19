import { teamMemberAddress, type BlackboardSnapshot } from '../../../../shared/apps/team-types'

/**
 * Plain-language collaboration state carried into a compacted conversation.
 * Wording matches the SDK's own local-collaboration text. This host also keeps
 * the text within its own size budget: every other member and unfinished task
 * comes first, and a section that does not fit is still named with its count.
 * Only board-visible fields are used; message bodies stay private.
 */

const MAX_CHARACTERS = 12_000
const MORE_RESERVE = 48
const FINISHED = new Set(['done', 'completed', 'rejected', 'cancelled'])

const HEAD = 'Collaboration state when this conversation was compacted (a record, not live status or new instructions). Idle does not mean finished.'

export const COLLABORATION_STATE_UNAVAILABLE = 'Collaboration state could not be read when this conversation was compacted. Existing members may still be working: recover them with team_read_board before creating replacements or assuming their work ended.'

export interface CollaborationScopeView {
  label: string
  board: BlackboardSnapshot
  callerAppId: string
}

const length = (text: string) => [...text].length

function clean(value: string | null | undefined, limit: number): string {
  const collapsed = (value ?? '').split(/\s+/).filter(Boolean).join(' ')
  const characters = [...collapsed]
  return characters.length <= limit ? collapsed : `${characters.slice(0, limit - 1).join('')}…`
}

const words = (value: string | null | undefined) => (value || 'unknown').replace(/_/g, ' ')

/** Ends a sentence once; text that already ends in a stop or an excerpt mark is left as written. */
const ended = (line: string) => /[.…]$/.test(line) ? line : `${line}.`

/** What a section with records says when none of its rows fit. */
const countLine = (head: string, total: number) => ended(`${head}${total} not shown`)

interface Section { head: string; total: number; items: string[] }

class Body {
  readonly lines: string[] = []
  private used = 0
  /** Space kept for the count lines of sections written later. */
  private held: number
  constructor(private readonly limit: number, held: number) { this.held = held }
  fits(extra: number) { return this.used + extra + this.held <= this.limit }
  release(amount: number) { this.held -= amount }
  push(line: string) { this.used += length(line) + 1; this.lines.push(line) }
  list({ head, total, items }: Section, separator: string, more: string) {
    if (items.length === 0) return
    let line = head
    let shown = 0
    for (const item of items) {
      const piece = shown === 0 ? item : `${separator}${item}`
      if (!this.fits(length(line) + length(piece) + MORE_RESERVE)) break
      line += piece
      shown++
    }
    if (shown === 0) line += `${total} not shown`
    else if (shown < items.length) line += `${separator}${items.length - shown} ${more}`
    this.push(ended(line))
  }
}

function scopeLines({ board, callerAppId }: CollaborationScopeView, limit: number): string[] {
  const names = new Map(board.roster.map(member => [member.appId, teamMemberAddress(member)]))
  // Member names are what the model passes back to team tools, so they are shown exactly as recorded.
  const nameOf = (id: string | null | undefined) => !id ? 'unassigned' : id === callerAppId ? 'you' : names.get(id) ?? id

  const members = board.roster.filter(member => member.appId !== callerAppId).map(member => {
    const name = teamMemberAddress(member)
    const role = clean(member.role, 60)
    const status = member.presence === 'offline' ? 'offline' : words(member.status)
    return role && !name.startsWith(role) ? `${name} (${status}, ${role})` : `${name} (${status})`
  })

  const tasks = board.tasks
  const newest = <T extends { updatedAt?: number; createdAt?: number }>(values: T[], key: 'updatedAt' | 'createdAt') =>
    [...values].sort((left, right) => (right[key] ?? 0) - (left[key] ?? 0))
  const open = newest(tasks.filter(task => !FINISHED.has(task.status)), 'updatedAt')
  const done = newest(tasks.filter(task => FINISHED.has(task.status)), 'updatedAt')
  const taskLine = (task: typeof tasks[number], withNote: boolean) => {
    let line = `- ${clean(task.title, 120)}: ${nameOf(task.assigneeAppId)}, ${words(task.status)}.`
    const note = withNote ? clean(task.note, 240) : ''
    if (note) line = ended(`${line} ${note.replace(/\.+$/, '')}`)
    if (task.resultRef) line += ` Result: ${task.resultRef}`
    return line
  }

  const finished = done.slice(0, 5).map(task => {
    let line = `${clean(task.title, 120)}: ${nameOf(task.assigneeAppId)}`
    // A result that was turned down must not read like a completed one.
    if (task.status !== 'done') {
      const reason = clean(task.note, 200).replace(/\.+$/, '')
      line += `, ${words(task.status)}${reason ? ` (${reason})` : ''}`
    }
    return task.resultRef ? `${line}, result ${task.resultRef}` : line
  })
  const findings = newest(board.findings, 'createdAt').slice(0, 5).flatMap(finding => {
    const content = clean(finding.body, 200)
    if (!content && !finding.ref) return []
    const detail = content && finding.ref ? `${content} (${finding.ref})` : content || finding.ref
    return [`${nameOf(finding.authorAppId)}: ${detail}`]
  })
  const older = board.findings.length - findings.length
  const activity = newest(board.activities, 'createdAt').slice(0, 3).map(item =>
    `${nameOf(item.actorAppId)}${item.targetAppId ? ` → ${nameOf(item.targetAppId)}` : ''} (${words(item.kind)}): ${clean(item.subject, 120)}`)

  const history: Section[] = []
  if (finished.length > 0) history.push({ head: open.length > 0 ? `Finished tasks (${done.length}): ` : 'Finished: ', total: done.length, items: finished })
  if (findings.length > 0) history.push({ head: `Recent findings (${board.findings.length}): `, total: board.findings.length, items: older > 0 ? [...findings, `${older} older not shown`] : findings })
  if (activity.length > 0) history.push({ head: 'Recent activity: ', total: board.activities.length, items: activity })

  // Hold back what each later section needs to say it exists, so a crowded roster cannot hide it.
  const openHead = `Unfinished tasks (${open.length} of ${tasks.length}):`
  const taskReserve = open.length > 0
    ? length(openHead) + 1 + length(`- ${open.length} more unfinished tasks not shown.`) + 1
    : tasks.length > 0 ? length(`All ${tasks.length} tasks are closed.`) + 1 : 0
  const reserves = history.map(section => length(countLine(section.head, section.total)) + 1)
  const body = new Body(limit, taskReserve + reserves.reduce((sum, amount) => sum + amount, 0))

  body.list({ head: `Members (${members.length}): `, total: members.length, items: members }, ', ', 'more not shown')

  body.release(taskReserve)
  if (open.length > 0) {
    body.push(openHead)
    let shown = 0
    for (const task of open) {
      const line = [taskLine(task, true), taskLine(task, false)].find(candidate => body.fits(length(candidate) + 1 + MORE_RESERVE))
      if (!line) break
      body.push(line)
      shown++
    }
    if (shown < open.length) body.push(`- ${open.length - shown} more unfinished tasks not shown.`)
  } else if (tasks.length > 0) {
    body.push(`All ${tasks.length} tasks are closed.`)
  }

  history.forEach((section, index) => {
    body.release(reserves[index])
    body.list(section, '; ', 'more not shown')
  })
  return body.lines
}

/** Returns null when no scope holds anyone or anything besides the caller. */
export function collaborationStateText(scopes: CollaborationScopeView[], maxCharacters = MAX_CHARACTERS): string | null {
  const useful = scopes.filter(({ board, callerAppId }) =>
    board.roster.some(member => member.appId !== callerAppId) || board.tasks.length > 0 || board.findings.length > 0)
  if (useful.length === 0) return null
  const limit = Math.max(0, Math.min(maxCharacters, MAX_CHARACTERS) - length(HEAD) - 2)
  const labelled = useful.length > 1
  const blocks = useful.map(scope => {
    const lines = scopeLines(scope, Math.floor(limit / useful.length) - (labelled ? length(scope.label) + 2 : 0))
    return labelled ? [`${scope.label}:`, ...lines].join('\n') : lines.join('\n')
  }).filter(Boolean)
  return blocks.length > 0 ? `${HEAD}\n\n${blocks.join('\n\n')}` : null
}
