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

const SPACE = 'space-a'
const LEAD = 'app-lead'
const WORKER = 'app-worker'

interface SendInputSeen {
  teamId: string
  epochId: string
  fromAppId: string
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
    reactivateEpoch: vi.fn(),
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
 * Seed a team with a lead + a worker. The dispatch tests pass an explicit epochId
 * (sendToMember prefers the passed epoch over the store's open one), so no epoch
 * row is needed; the NO_EPOCH case passes an empty epochId and seeds none.
 */
function seedTeam(store: TeamStore, opts?: { leadAppId?: string | null }) {
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

  it('delivered + answered (sync reply) → ok:true with the final message, attributed to the lead', async () => {
    const ctx = build(() => ({ from: 'worker', message: 'done', status: 'ok' }))
    dbManager = ctx.dbManager
    const { teamId, epochId } = seedTeam(ctx.store)

    const res = await ctx.service.sendToMember({
      teamId, appId: WORKER, epochId, message: 'do it',
    })

    expect(res).toEqual({ ok: true, finalMessage: 'done' })
    // bus.send targets the member's NAME, not appId.
    expect(ctx.sends).toHaveLength(1)
    expect(ctx.sends[0]).toMatchObject({
      teamId, epochId, fromAppId: LEAD, to: 'worker', message: 'do it', wait: true,
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
    expect(ctx.runtime.reactivateEpoch).toHaveBeenCalledWith(teamId, epochId)
    // Ordering: reactivate fires before the bus send (so completeTurn sees it open).
    const reactivateOrder = ctx.runtime.reactivateEpoch.mock.invocationCallOrder[0]
    const sendOrder = ctx.runtime.bus.send.mock.invocationCallOrder[0]
    expect(reactivateOrder).toBeLessThan(sendOrder)
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

  it('no open epoch and none passed → NO_EPOCH (bus never consulted)', async () => {
    const ctx = build(() => ({ messageId: 'nope' }))
    dbManager = ctx.dbManager
    const { teamId } = seedTeam(ctx.store)

    const res = await ctx.service.sendToMember({ teamId, appId: WORKER, epochId: '', message: 'go' })
    expect(res).toEqual({ ok: false, finalMessage: null, reason: 'NO_EPOCH' })
    expect(ctx.sends).toHaveLength(0)
  })

  it('team has no lead → NO_LEAD (cannot attribute the operator turn)', async () => {
    const ctx = build(() => ({ messageId: 'nope' }))
    dbManager = ctx.dbManager
    const { teamId, epochId } = seedTeam(ctx.store, { leadAppId: null })

    const res = await ctx.service.sendToMember({ teamId, appId: WORKER, epochId, message: 'go' })
    expect(res).toEqual({ ok: false, finalMessage: null, reason: 'NO_LEAD' })
    expect(ctx.sends).toHaveLength(0)
  })
})
