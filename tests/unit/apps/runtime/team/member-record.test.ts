/**
 * The lead's read of a member's record: numbered, newest-first pages under a
 * character budget, the same way for a member on this machine and one on
 * another — and only for the lead.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../../../src/main/services/agent/resolved-sdk', () => ({
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({ name, description, inputSchema, handler }),
  createSdkMcpServer: (options: { tools: Array<{ name: string }> }) => options,
}))

import {
  createTeamMemberRecordReader,
  renderMemberRecord,
  type RemoteRecordRow,
} from '../../../../../src/main/apps/runtime/team/member-record'
import { buildCoordinationTools, createTeamMcpServer } from '../../../../../src/main/apps/runtime/team/team-tools'
import type { TeamMcpContext } from '../../../../../src/main/apps/runtime/team/team-tools'
import type { MessageBus } from '../../../../../src/main/apps/runtime/team/message-bus'
import type { Blackboard } from '../../../../../src/main/apps/runtime/team/blackboard'
import { TEAM_TOOL_NAMES } from '../../../../../src/shared/apps/team-types'
import type { TranscriptMessage } from '../../../../../src/shared/types/transcript'

const localMsg = (i: number, content = `message ${i}`): TranscriptMessage => ({
  id: `session-msg-${i * 2}`,
  role: i % 2 === 1 ? 'user' : 'assistant',
  content,
  timestamp: `2026-09-29T10:${String(i).padStart(2, '0')}:00.000Z`,
})

const members = {
  'app-local': { appId: 'app-local', memberName: 'writer', origin: 'local' as const },
  'app-remote': { appId: 'app-remote', memberName: 'analyst', origin: 'remote' as const, ownerNodeId: 'node-b', ownerDisplayName: 'Bea' },
}
const store = { getMember: (_team: string, appId: string) => (members as Record<string, unknown>)[appId] ?? null } as never

const rows = (n: number): RemoteRecordRow[] =>
  Array.from({ length: n }, (_, i) => ({ seq: i + 1, role: i % 2 === 0 ? 'user' : 'assistant', content: `remote ${i + 1}`, ts: Date.UTC(2026, 8, 29, 10, i) }))

function reader(overrides: Partial<Parameters<typeof createTeamMemberRecordReader>[0]> = {}) {
  const transcript = Array.from({ length: 10 }, (_, i) => localMsg(i + 1))
  return createTeamMemberRecordReader({ store, readLocal: () => transcript, ...overrides })
}

const request = (extra: Record<string, unknown> = {}) => ({ teamId: 't', epochId: 'e', memberAppId: 'app-local', ...extra })

describe('member record reader', () => {
  it('pages a local member newest-first with ordinal seqs and a continuation cursor', async () => {
    const read = reader()
    const first = await read(request({ charBudget: 25 }))
    if (!first.ok) throw new Error('expected ok')
    // "message N" is 9-10 chars: two fit in 25, the third does not.
    expect(first.lines.map((l) => l.seq)).toEqual([9, 10])
    expect(first).toMatchObject({ total: 10, hiddenBefore: 8, nextBefore: 9, remote: false, stale: false })

    const second = await read(request({ charBudget: 25, before: first.nextBefore }))
    if (!second.ok) throw new Error('expected ok')
    expect(second.lines.map((l) => l.seq)).toEqual([7, 8])
  })

  it('walks the whole record backwards without gaps or repeats', async () => {
    const read = reader()
    const seen: number[] = []
    let before: number | undefined
    for (let guard = 0; guard < 20; guard++) {
      const page = await read(request({ charBudget: 30, ...(before ? { before } : {}) }))
      if (!page.ok) throw new Error('expected ok')
      seen.unshift(...page.lines.map((l) => l.seq))
      if (!page.nextBefore) break
      before = page.nextBefore
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('uses the 8000-character budget by default and always returns at least one message', async () => {
    const big = [localMsg(1, 'x'.repeat(20_000))]
    const res = await reader({ readLocal: () => big })(request())
    if (!res.ok) throw new Error('expected ok')
    expect(res.lines).toHaveLength(1)
    expect(res.lines[0].content.length).toBeLessThan(8100)
    expect(res.lines[0].content).toContain('12000 more characters cut')

    const many = Array.from({ length: 100 }, (_, i) => localMsg(i + 1, 'y'.repeat(500)))
    const page = await reader({ readLocal: () => many })(request())
    if (!page.ok) throw new Error('expected ok')
    expect(page.lines.reduce((n, l) => n + l.content.length, 0)).toBeLessThanOrEqual(8000)
    expect(page.lines.length).toBeGreaterThan(10)
  })

  it('shows step counts, never the thought process', async () => {
    const withThoughts: TranscriptMessage = {
      ...localMsg(2, 'done'),
      thoughts: null,
      thoughtsSummary: { count: 3, types: { tool_use: 3 } },
    }
    const res = await reader({ readLocal: () => [localMsg(1), withThoughts] })(request())
    if (!res.ok) throw new Error('expected ok')
    expect(res.lines[1].steps).toBe(3)
    const text = renderMemberRecord(res)
    expect(text).toContain('3 thinking/tool steps not shown')
    expect(text).toContain('(This is the start of the record.)')
  })

  it('reads a remote member through the history plane, same numbering', async () => {
    const fetchRemote = vi.fn().mockResolvedValue({ messages: rows(6), stale: false })
    const res = await reader({ fetchRemote })({ ...request({ memberAppId: 'app-remote' }), charBudget: 20 })
    expect(fetchRemote).toHaveBeenCalledWith({ teamId: 't', epochId: 'e', appId: 'app-remote', ownerNodeId: 'node-b' })
    if (!res.ok) throw new Error('expected ok')
    expect(res.remote).toBe(true)
    expect(res.lines.map((l) => l.seq)).toEqual([5, 6])
    expect(res.lines[1].role).toBe('assistant')
    expect(res.lines[1].timestamp).toBe('2026-09-29T10:05:00.000Z')
    expect(res.nextBefore).toBe(5)
  })

  it('flags a replica served while the owner is unreachable', async () => {
    const fetchRemote = vi.fn().mockResolvedValue({ messages: rows(2), stale: true })
    const res = await reader({ fetchRemote })(request({ memberAppId: 'app-remote' }))
    if (!res.ok) throw new Error('expected ok')
    expect(res.stale).toBe(true)
    expect(renderMemberRecord(res)).toContain('owner is unreachable')
  })

  it('answers clearly when the owner cannot be reached or cross-machine reads are off', async () => {
    const unreachable = await reader({ fetchRemote: vi.fn().mockRejectedValue(new Error('history-owner-unreachable')) })(request({ memberAppId: 'app-remote' }))
    expect(unreachable).toMatchObject({ ok: false, reason: 'unavailable' })
    if (unreachable.ok) return
    expect(unreachable.message).toContain('Bea')
    expect(unreachable.message).not.toContain('history-owner-unreachable')

    const off = await reader()(request({ memberAppId: 'app-remote' }))
    expect(off).toMatchObject({ ok: false, reason: 'unavailable' })
  })

  it('refuses a non-member and a bad cursor', async () => {
    expect(await reader()(request({ memberAppId: 'app-ghost' }))).toMatchObject({ ok: false, reason: 'not-a-member' })
    expect(await reader()(request({ before: 0 }))).toMatchObject({ ok: false, reason: 'invalid-cursor' })
    expect(await reader()(request({ before: 1.5 }))).toMatchObject({ ok: false, reason: 'invalid-cursor' })
    expect(await reader()(request({ before: 99 }))).toMatchObject({ ok: false, reason: 'invalid-cursor' })
  })

  it('says so when a member has no messages yet', async () => {
    const res = await reader({ readLocal: () => [] })(request())
    if (!res.ok) throw new Error('expected ok')
    expect(renderMemberRecord(res)).toBe('writer has no messages in this run yet.')
  })
})

type ToolReply = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }
type Tool = { name: string; handler: (input: Record<string, unknown>) => Promise<ToolReply> }

function serverFor(overrides: Partial<TeamMcpContext>) {
  const readMemberRecord = vi.fn(async () => ({ ok: true as const, memberName: 'writer', remote: false, stale: false, lines: [{ seq: 1, role: 'user' as const, content: 'hi' }], total: 1, hiddenBefore: 0 }))
  const bus = {
    resolveMemberAppId: (_team: string, name: string) => {
      if (name === 'ghost') throw Object.assign(new Error(`No member named "ghost"`), { name: 'TeamBusError' })
      return name === 'lead' ? 'app-lead' : 'app-local'
    },
  } as unknown as MessageBus
  const ctx: TeamMcpContext = {
    teamId: 't',
    epochId: 'e',
    callerAppId: 'app-lead',
    collabMode: 'free',
    selfIsLead: true,
    bus,
    blackboard: {} as Blackboard,
    callerWorkDir: '/tmp',
    requestComplete: () => {},
    readMemberRecord,
    ...overrides,
  }
  const tools = (createTeamMcpServer(ctx) as unknown as { tools: Tool[] }).tools
  return { readMemberRecord, tool: tools.find((t) => t.name === TEAM_TOOL_NAMES.readMember), tools }
}

describe('team_read_member tool', () => {
  it('is offered to the lead and not to a member', () => {
    expect(serverFor({}).tool).toBeDefined()
    expect(serverFor({ selfIsLead: false }).tool).toBeUndefined()
  })

  it('is part of the space coordinator toolset', () => {
    const names = buildCoordinationTools(() => null).map((t) => (t as unknown as Tool).name)
    expect(names).toContain(TEAM_TOOL_NAMES.readMember)
  })

  it('reads the named member for this run and passes the cursor through', async () => {
    const { tool, readMemberRecord } = serverFor({})
    const res = await tool!.handler({ member: 'writer', before: 31 })
    expect(res.isError).toBeUndefined()
    expect(res.content[0].text).toContain('Record of writer')
    expect(readMemberRecord).toHaveBeenCalledWith({ teamId: 't', epochId: 'e', memberAppId: 'app-local', before: 31 })
  })

  it('does not read the record of a run started from another machine', async () => {
    const { tool, readMemberRecord } = serverFor({ external: true })
    const res = await tool!.handler({ member: 'writer' })
    expect(res.isError).toBe(true)
    expect(readMemberRecord).not.toHaveBeenCalled()
  })

  it('refuses a caller that is not the lead even when the tool is reachable', async () => {
    const readMemberRecord = vi.fn()
    const memberCtx = {
      teamId: 't',
      epochId: 'e',
      callerAppId: 'app-w',
      collabMode: 'free',
      selfIsLead: false,
      bus: { resolveMemberAppId: () => 'app-local' },
      blackboard: {},
      callerWorkDir: '/tmp',
      requestComplete: () => {},
      readMemberRecord,
    } as unknown as TeamMcpContext
    const tool = (buildCoordinationTools(() => memberCtx) as unknown as Tool[]).find((t) => t.name === TEAM_TOOL_NAMES.readMember)!
    const res = await tool.handler({ member: 'writer' })
    expect(res.isError).toBe(true)
    expect(readMemberRecord).not.toHaveBeenCalled()
  })

  it('refuses to read its own record, an unknown member, and an unwired runtime', async () => {
    const own = await serverFor({}).tool!.handler({ member: 'lead' })
    expect(own.isError).toBe(true)

    const unknown = await serverFor({}).tool!.handler({ member: 'ghost' })
    expect(unknown.isError).toBe(true)

    const unwired = await serverFor({ readMemberRecord: undefined }).tool!.handler({ member: 'writer' })
    expect(unwired).toMatchObject({ isError: true })
    expect(unwired.content[0].text).toContain('not available')
  })

  it('surfaces a reader failure message as an error', async () => {
    const readMemberRecord = vi.fn(async () => ({ ok: false as const, reason: 'unavailable' as const, message: 'owner unreachable' }))
    const res = await serverFor({ readMemberRecord }).tool!.handler({ member: 'writer' })
    expect(res).toEqual({ content: [{ type: 'text', text: 'owner unreachable' }], isError: true })
  })
})
