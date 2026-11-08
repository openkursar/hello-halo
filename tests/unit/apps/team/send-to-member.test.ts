/**
 * Unit tests for teamService.sendToMember (host-operator dispatch).
 *
 * In a federated office the target member may be owned by a remote node, but
 * dispatch always goes through bus.send and the reply flows back through the
 * same wait — so this service call is the single point where every outcome is
 * normalized for the renderer/IPC layer. Runs against a real in-memory
 * TeamStore with a stubbed runtime bus.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { broadcastToAll, sendToRenderer } = vi.hoisted(() => ({
  broadcastToAll: vi.fn(),
  sendToRenderer: vi.fn(),
}))
vi.mock('../../../../src/main/http/websocket', () => ({ broadcastToAll }))
vi.mock('../../../../src/main/foundation/window.service', () => ({ sendToRenderer }))

import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../src/main/platform/store/types'
import { TeamStore } from '../../../../src/main/apps/team/store'
import { MIGRATION_NAMESPACE, migrations } from '../../../../src/main/apps/team/migrations'
import { createTeamService } from '../../../../src/main/apps/team/service'
import type { TeamServiceDeps } from '../../../../src/main/apps/team/service'
import { spaceCollabChatKey, nativeConversationChatKey } from '../../../../src/shared/apps/team-types'

const SPACE = 'space-a'
const LEAD = 'app-lead'
const WORKER = 'app-worker'

interface SendInputSeen {
  teamId: string
  epochId: string
  fromAppId: string | null
  to: string
  message: string
  wait?: boolean
}

/** Build the service over a real store + a programmable bus.send stub. */
function build(busSend: (input: SendInputSeen) => unknown) {
  const dbManager = createDatabaseManager(':memory:')
  const db = dbManager.getAppDatabase()
  dbManager.runMigrations(db, MIGRATION_NAMESPACE, migrations)
  const store = new TeamStore(db)

  const sends: SendInputSeen[] = []
  const runtime = {
    // Ad-hoc 1:1 chat reactivates a sealed run epoch before sending so the reply
    // is not dropped on a sealed epoch; no-op in this stub (real impl reopens).
    noteEpochTurn: vi.fn(),
    // Never reached: a message opens no conversation for its caller.
    ensureConversationEpoch: vi.fn((_teamId: string, _chatKey: string) => ({ id: 'conv-epoch-1' })),
    bus: {
      send: vi.fn(async (input: SendInputSeen) => {
        sends.push(input)
        return busSend(input)
      }),
    },
  }

  const deps: TeamServiceDeps = {
    store,
    appManager: {} as never,
    getRuntime: () => runtime as never,
    spaces: {
      spaceExists: () => true,
      createMemberSpace: () => 'm',
      deleteMemberSpace: () => {},
    } as never,
    listArtifacts: vi.fn(async () => []),
    proposeMembersFromGoal: vi.fn(async () => []),
  }
  const service = createTeamService(deps)
  return { service, store, dbManager, sends, runtime }
}

/**
 * Seed a team with a lead + a worker and, unless a test brings its own, the
 * native conversation every dispatch names.
 */
function seedTeam(store: TeamStore, opts?: { leadAppId?: string | null; ephemeral?: boolean; withEpoch?: boolean }) {
  const now = Date.now()
  const teamId = 'team-e1'
  const epochId = 'epoch-e1'
  store.insertTeam({
    id: teamId,
    name: 'Office',
    owningSpaceId: SPACE,
    goal: 'g',
    leadAppId: opts?.leadAppId === undefined ? LEAD : opts.leadAppId,
    memberSourcing: 'manual',
    collabMode: 'structured',
    escalationRouting: 'user',
    status: 'idle',
    currentEpochId: null,
    ephemeral: opts?.ephemeral,
    createdAt: now,
    updatedAt: now,
  })
  if (opts?.leadAppId !== null) {
    store.addMember({
      teamId, appId: LEAD, memberName: 'lead', role: 'Lead',
      isLead: true, aiProvisioned: false, addedAt: now,
    })
  }
  store.addMember({
    teamId, appId: WORKER, memberName: 'worker', role: 'Worker',
    isLead: false, aiProvisioned: false, addedAt: now,
  })
  if (opts?.withEpoch !== false) {
    store.insertEpoch({ id: epochId, teamId, startedAt: now, endedAt: null, endReason: null,
      summary: null, lifecycle: 'conversation', chatKey: nativeConversationChatKey('seeded-chat') })
  }
  return { teamId, epochId }
}

describe('E-1 — teamService.sendToMember (host-operator dispatch)', () => {
  let dbManager: DatabaseManager
  beforeEach(() => {
    broadcastToAll.mockClear()
    sendToRenderer.mockClear()
  })
  afterEach(() => {
    dbManager?.closeAll()
  })

  it('keeps a repaired source task immutable', async () => {
    const ctx = build(() => ({ messageId: 'must-not-send' }))
    dbManager = ctx.dbManager
    const { teamId, epochId } = seedTeam(ctx.store, { withEpoch: false })
    ctx.store.insertEpoch({ id: epochId, teamId, startedAt: Date.now(), endedAt: null, endReason: null,
      summary: null, lifecycle: 'conversation', chatKey: spaceCollabChatKey('original-chat') })
    ctx.store.updateTeamCurrentEpoch(teamId, epochId)
    const before = ctx.store.getEpochById(epochId)
    await expect(ctx.service.sendToMember({ teamId, appId: WORKER, epochId, message: 'New work' })).rejects.toThrow(/read-only/)
    expect(ctx.runtime.noteEpochTurn).not.toHaveBeenCalled()
    expect(ctx.runtime.bus.send).not.toHaveBeenCalled()
    expect(ctx.store.getEpochById(epochId)).toEqual(before)
  })

  it('refuses a message that names no conversation, and opens or picks none for it', async () => {
    const ctx = build(() => ({ messageId: 'must-not-send' }))
    dbManager = ctx.dbManager
    const { teamId, epochId } = seedTeam(ctx.store)
    // A running run used to catch an unnamed message; it must not any more.
    ctx.store.updateTeamCurrentEpoch(teamId, epochId)
    await expect(ctx.service.sendToMember({ teamId, appId: WORKER, epochId: '', message: 'Results are in' }))
      .rejects.toThrow(/Name the conversation/)
    expect(ctx.runtime.ensureConversationEpoch).not.toHaveBeenCalled()
    expect(ctx.runtime.noteEpochTurn).not.toHaveBeenCalled()
    expect(ctx.sends).toHaveLength(0)
  })

  it('refuses a conversation that belongs to another team, or to none', async () => {
    const ctx = build(() => ({ messageId: 'must-not-send' }))
    dbManager = ctx.dbManager
    const { teamId } = seedTeam(ctx.store)
    ctx.store.insertTeam({
      id: 'team-other', name: 'Other', owningSpaceId: SPACE, goal: 'g', leadAppId: null, memberSourcing: 'manual',
      collabMode: 'free', escalationRouting: 'user', status: 'idle', currentEpochId: null, createdAt: 1, updatedAt: 1,
    })
    ctx.store.insertEpoch({ id: 'epoch-other', teamId: 'team-other', startedAt: 1, endedAt: null, endReason: null,
      summary: null, lifecycle: 'conversation', chatKey: nativeConversationChatKey('elsewhere') })
    for (const epochId of ['epoch-other', 'epoch-missing']) {
      expect(await ctx.service.sendToMember({ teamId, appId: WORKER, epochId, message: 'go' }))
        .toEqual({ ok: false, finalMessage: null, reason: 'CONVERSATION_NOT_FOUND' })
    }
    expect(ctx.runtime.noteEpochTurn).not.toHaveBeenCalled()
    expect(ctx.sends).toHaveLength(0)
  })

  it.each(['active collaboration', 'sealed native task'] as const)('still sends to an %s', async kind => {
    const ctx = build(() => ({ from: 'worker', message: 'done', status: 'ok' }))
    dbManager = ctx.dbManager
    const ephemeral = kind === 'active collaboration'
    const { teamId, epochId } = seedTeam(ctx.store, { ephemeral, withEpoch: false })
    ctx.store.insertEpoch({ id: epochId, teamId, startedAt: Date.now(), endedAt: ephemeral ? null : Date.now(),
      endReason: ephemeral ? null : 'completed', summary: null, lifecycle: 'conversation',
      chatKey: ephemeral ? spaceCollabChatKey('original-chat') : nativeConversationChatKey('ordinary-chat') })
    expect(await ctx.service.sendToMember({ teamId, appId: WORKER, epochId, message: 'Continue' }))
      .toMatchObject({ ok: true, finalMessage: 'done' })
    expect(ctx.runtime.noteEpochTurn).toHaveBeenCalledWith(teamId, epochId, true)
    expect(ctx.runtime.bus.send).toHaveBeenCalledOnce()
  })

  it('delivered + answered (sync reply) → ok:true with the final message, sent as a person', async () => {
    const ctx = build(() => ({ from: 'worker', message: 'done', status: 'ok' }))
    dbManager = ctx.dbManager
    const { teamId, epochId } = seedTeam(ctx.store)

    const res = await ctx.service.sendToMember({
      teamId, appId: WORKER, epochId, message: 'do it',
    })

    expect(res).toEqual({ ok: true, finalMessage: 'done' })
    // bus.send targets the member's NAME, not appId. fromAppId is null because a
    // PERSON is sending: borrowing the lead's identity would file this chat on
    // the office record under a digital human that never ran.
    expect(ctx.sends).toHaveLength(1)
    expect(ctx.sends[0]).toMatchObject({
      teamId, epochId, fromAppId: null, to: 'worker', message: 'do it', wait: true,
    })
  })

  it('reactivates the (possibly sealed) run epoch before sending so a reply is not dropped', async () => {
    // An ad-hoc 1:1 chat after a run finished must still get a reply: the bus
    // drops a completion on a sealed epoch, so sendToMember reversibly wakes
    // the epoch first (no-op when already open), before the bus send.
    const ctx = build(() => ({ from: 'worker', message: 'done', status: 'ok' }))
    dbManager = ctx.dbManager
    const { teamId, epochId } = seedTeam(ctx.store)

    const res = await ctx.service.sendToMember({ teamId, appId: WORKER, epochId, message: 'still there?' })

    expect(res).toEqual({ ok: true, finalMessage: 'done' })
    expect(ctx.runtime.noteEpochTurn).toHaveBeenCalledWith(teamId, epochId, true)
    // Ordering: reactivate fires before the bus send (so completeTurn sees it open).
    const noteOrder = ctx.runtime.noteEpochTurn.mock.invocationCallOrder[0]
    const sendOrder = ctx.runtime.bus.send.mock.invocationCallOrder[0]
    expect(noteOrder).toBeLessThan(sendOrder)
  })

  it('does not send into a cleared or unavailable task', async () => {
    const ctx = build(() => ({ from: 'worker', message: 'unexpected', status: 'ok' }))
    dbManager = ctx.dbManager
    const { teamId, epochId } = seedTeam(ctx.store)
    ctx.runtime.noteEpochTurn.mockReturnValue(false)
    expect(await ctx.service.sendToMember({ teamId, appId: WORKER, epochId, message: 'go' })).toEqual({ ok: false, finalMessage: null, reason: 'UNDELIVERED' })
    expect(ctx.sends).toHaveLength(0)
  })

  it('delivered async (queued, no sync answer) → ok:true with finalMessage null', async () => {
    const ctx = build(() => ({ messageId: 'env-1' }))
    dbManager = ctx.dbManager
    const { teamId, epochId } = seedTeam(ctx.store)

    const res = await ctx.service.sendToMember({ teamId, appId: WORKER, epochId, message: 'go' })
    expect(res).toEqual({ ok: true, finalMessage: null })
  })

  it('timeout (owner unreachable / no answer) → ok:false, reason TIMEOUT', async () => {
    const ctx = build(() => ({ from: 'worker', message: '', status: 'timeout' }))
    dbManager = ctx.dbManager
    const { teamId, epochId } = seedTeam(ctx.store)

    const res = await ctx.service.sendToMember({ teamId, appId: WORKER, epochId, message: 'go' })
    expect(res).toEqual({ ok: false, finalMessage: null, reason: 'TIMEOUT' })
  })

  it('unknown member → MEMBER_NOT_FOUND and the bus is never consulted', async () => {
    const ctx = build(() => ({ messageId: 'should-not-happen' }))
    dbManager = ctx.dbManager
    const { teamId, epochId } = seedTeam(ctx.store)

    const res = await ctx.service.sendToMember({ teamId, appId: 'ghost-app', epochId, message: 'go' })
    expect(res).toEqual({ ok: false, finalMessage: null, reason: 'MEMBER_NOT_FOUND' })
    expect(ctx.sends).toHaveLength(0)
  })

  it('an office with no lead can still be chatted with — a person needs no member identity', async () => {
    // The send used to borrow the lead's appId for attribution, which made a
    // lead-less office reject 1:1 chat outright. A person sends as themselves.
    const ctx = build(() => ({ from: 'worker', message: 'hi', status: 'ok' }))
    dbManager = ctx.dbManager
    const { teamId, epochId } = seedTeam(ctx.store, { leadAppId: null })

    const res = await ctx.service.sendToMember({ teamId, appId: WORKER, epochId, message: 'go' })
    expect(res).toEqual({ ok: true, finalMessage: 'hi' })
    expect(ctx.sends[0]).toMatchObject({ fromAppId: null, to: 'worker' })
  })
})
