/**
 * Location-transparent read of a teammate's record — what a member said and
 * was told in one run — for the team lead.
 *
 * The record is the member's team-channel transcript: this node's disk for a
 * member it owns, pulled from the owner node for a remote one. Both come back as
 * the same numbered lines, `seq` being the message's 1-based ordinal in the
 * append-only transcript — the very number the federation history plane uses,
 * so a page cursor means the same thing on either path.
 *
 * Pages run from the newest backwards under a character budget and never carry
 * the thinking/tool stream: the record is for reconciling what a member did with
 * what it reported, and the tool trace would swamp that. Each assistant line says
 * how many steps it took instead.
 *
 * Kernel-clean: transcript access is injected (bootstrap bridges the session
 * store and the federation manager).
 */

import type { TeamStore } from '../../team'
import { isRemoteMember } from '../../../../shared/apps/team-types'
import { tailStartWithinBudget } from '../../../../shared/transcript'
import type { TranscriptMessage } from '../../../../shared/types/transcript'

const LOG_TAG = '[TeamMemberRecord]'

export const MEMBER_RECORD_PAGE_CHARS = 8000

export interface MemberRecordLine {
  /** 1-based ordinal in the member's transcript for this run */
  seq: number
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp?: string
  /** How the line entered the conversation, e.g. 'cross-conversation' */
  source?: string
  /** Thinking / tool steps behind an assistant line (their content is not shown) */
  steps?: number
}

export interface ReadTeamMemberRecordRequest {
  teamId: string
  epochId: string
  memberAppId: string
  /** Continue with the messages before this seq (exclusive); absent = the newest page */
  before?: number
  charBudget?: number
}

export type TeamMemberRecordResult =
  | {
      ok: true
      memberName: string
      /** Owned by another machine of the office */
      remote: boolean
      /** Served from a replica because the owner cannot be reached; it may lack the latest messages */
      stale: boolean
      /** Oldest first */
      lines: MemberRecordLine[]
      total: number
      /** Messages older than this page; 0 = nothing withheld */
      hiddenBefore: number
      /** Pass as `before` to read the page before this one */
      nextBefore?: number
    }
  | {
      ok: false
      reason: 'not-a-member' | 'invalid-cursor' | 'unavailable'
      message: string
    }

export type ReadTeamMemberRecord = (request: ReadTeamMemberRecordRequest) => Promise<TeamMemberRecordResult>

/** What the federation history plane returns for one message. */
export interface RemoteRecordRow {
  seq: number
  role: string
  content: string
  ts?: number
  thoughtsSummary?: { count: number }
}

export interface TeamMemberRecordReaderDeps {
  store: Pick<TeamStore, 'getMember'>
  /** The member's full transcript for one run on this node (empty when there is none). */
  readLocal: (appId: string, teamId: string, epochId: string) => readonly TranscriptMessage[]
  /** Pull the transcript from the owner node; absent = cross-machine reads are unavailable. */
  fetchRemote?: (params: {
    teamId: string
    epochId: string
    appId: string
    ownerNodeId: string
  }) => Promise<{ messages: readonly RemoteRecordRow[]; stale: boolean }>
  charBudget?: number
}

function asRole(role: string): MemberRecordLine['role'] {
  return role === 'assistant' || role === 'system' ? role : 'user'
}

function fromLocal(messages: readonly TranscriptMessage[]): MemberRecordLine[] {
  return messages.map((m, i) => ({
    seq: i + 1,
    role: m.role,
    content: m.content,
    timestamp: m.timestamp,
    ...(m.source ? { source: m.source } : {}),
    ...(m.thoughtsSummary?.count ? { steps: m.thoughtsSummary.count } : {}),
  }))
}

function fromRemote(rows: readonly RemoteRecordRow[]): MemberRecordLine[] {
  return rows
    .map((r) => ({
      seq: r.seq,
      role: asRole(r.role),
      content: r.content,
      ...(r.ts ? { timestamp: new Date(r.ts).toISOString() } : {}),
      ...(r.thoughtsSummary?.count ? { steps: r.thoughtsSummary.count } : {}),
    }))
    .sort((a, b) => a.seq - b.seq)
}

export function createTeamMemberRecordReader(deps: TeamMemberRecordReaderDeps): ReadTeamMemberRecord {
  const defaultBudget = deps.charBudget ?? MEMBER_RECORD_PAGE_CHARS

  return async ({ teamId, epochId, memberAppId, before, charBudget }) => {
    const member = deps.store.getMember(teamId, memberAppId)
    if (!member) {
      return { ok: false, reason: 'not-a-member', message: 'That teammate is not a member of this team.' }
    }
    if (before !== undefined && (!Number.isInteger(before) || before < 1)) {
      return { ok: false, reason: 'invalid-cursor', message: '"before" must be a positive whole number taken from a previous page.' }
    }

    const remote = isRemoteMember(member)
    let lines: MemberRecordLine[]
    let stale = false
    if (!remote) {
      lines = fromLocal(deps.readLocal(memberAppId, teamId, epochId))
    } else if (!deps.fetchRemote) {
      return {
        ok: false,
        reason: 'unavailable',
        message:
          `${member.memberName} runs on ${member.ownerDisplayName ?? 'another'} machine and reading ` +
          'a record across machines is not available right now. Ask them to summarise it in a message.',
      }
    } else {
      try {
        const fetched = await deps.fetchRemote({ teamId, epochId, appId: memberAppId, ownerNodeId: member.ownerNodeId ?? '' })
        lines = fromRemote(fetched.messages)
        stale = fetched.stale
      } catch (err) {
        console.warn(`${LOG_TAG} remote record unavailable: team=${teamId} member=${memberAppId}`, err)
        return {
          ok: false,
          reason: 'unavailable',
          message:
            `${member.memberName}\u2019s record lives on ${member.ownerDisplayName ?? 'another'} machine, ` +
            'which cannot be reached right now. Retry later, or ask them to summarise it in a message.',
        }
      }
    }

    const total = lines.length ? lines[lines.length - 1].seq : 0
    if (before !== undefined && before > total + 1) {
      return { ok: false, reason: 'invalid-cursor', message: `"before" ${before} is past the end of this record (${total} messages).` }
    }

    const endExclusive = before === undefined ? lines.length : lines.filter((l) => l.seq < before).length
    const budget = charBudget ?? defaultBudget
    const start = tailStartWithinBudget(lines, endExclusive, budget, (l) => l.content.length)
    const page = lines.slice(start, endExclusive).map((l) =>
      l.content.length > budget ? { ...l, content: `${l.content.slice(0, budget)}\n[\u2026${l.content.length - budget} more characters cut]` } : l
    )

    return {
      ok: true,
      memberName: member.memberName,
      remote,
      stale,
      lines: page,
      total,
      hiddenBefore: start,
      ...(start > 0 ? { nextBefore: lines[start].seq } : {}),
    }
  }
}

const ROLE_LABEL: Record<MemberRecordLine['role'], string> = {
  user: 'received',
  assistant: 'said',
  system: 'system',
}

function stamp(iso?: string): string {
  return iso ? ` · ${iso.slice(0, 16).replace('T', ' ')}` : ''
}

/** The page as the lead reads it. */
export function renderMemberRecord(result: Extract<TeamMemberRecordResult, { ok: true }>): string {
  const { memberName, lines, total, hiddenBefore, nextBefore, stale } = result
  if (lines.length === 0) return `${memberName} has no messages in this run yet.`

  const head =
    `Record of ${memberName} — messages #${lines[0].seq}\u2013#${lines[lines.length - 1].seq} of ${total}, oldest first.` +
    (result.remote ? ` (Runs on another machine.)` : '') +
    (stale ? ' (Served from a copy: the owner is unreachable, so the latest messages may be missing.)' : '')

  const body = lines.map((l) => {
    const tags = [`#${l.seq}`, ROLE_LABEL[l.role]]
    if (l.source) tags.push(l.source)
    const steps = l.steps ? ` (${l.steps} thinking/tool step${l.steps === 1 ? '' : 's'} not shown)` : ''
    return `[${tags.join(' · ')}${stamp(l.timestamp)}]${steps}\n${l.content}`
  })

  const tail = nextBefore
    ? `\n\n${hiddenBefore} earlier message${hiddenBefore === 1 ? '' : 's'} not shown. ` +
      `Call team_read_member again with before=${nextBefore} to read the page before this one.`
    : '\n\n(This is the start of the record.)'

  return `${head}\n\n${body.join('\n\n')}${tail}`
}
