/**
 * Unit tests for teamService.stopMember (the stop button behind a member chat).
 *
 * Stop acts on the conversation the caller names — the one on screen — and on
 * no other: a stop aimed at a conversation picked for the caller could end the
 * member's work somewhere else. Position is not this layer's concern: the
 * runtime seam it delegates to is what routes a remotely-owned member's abort
 * to the machine running the turn.
 *
 * Runs against a real in-memory TeamStore with a stubbed runtime.
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
const TEAM = 'team-s1'

function build(stopResult: boolean | Error = true) {
  const dbManager = createDatabaseManager(':memory:')
  const db = dbManager.getAppDatabase()
  dbManager.runMigrations(db, MIGRATION_NAMESPACE, migrations)
  const store = new TeamStore(db)

  const stops: Array<{ appId: string; teamId: string; epochId: string }> = []
  const runtime = {
    // Must never be reached by a stop: opening a conversation as a side effect
    // of stopping nothing would create the very session it claims to end.
    ensureConversationEpoch: vi.fn(() => ({ id: 'conv-epoch-should-not-happen' })),
    noteEpochTurn: vi.fn(),
    stopMemberTurn: vi.fn(async (p: { appId: string; teamId: string; epochId: string }) => {
      stops.push(p)
      if (stopResult instanceof Error) throw stopResult
      return stopResult
    }),
    bus: { send: vi.fn() },
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
  return { service: createTeamService(deps), store, dbManager, stops, runtime }
}

function seedTeam(store: TeamStore) {
  const now = Date.now()
  store.insertTeam({
    id: TEAM, name: 'Office', owningSpaceId: SPACE, goal: 'g', leadAppId: LEAD,
    memberSourcing: 'manual', collabMode: 'structured', escalationRouting: 'user',
    status: 'idle', currentEpochId: null, createdAt: now, updatedAt: now,
  })
  store.addMember({
    teamId: TEAM, appId: LEAD, memberName: 'lead', role: 'Lead',
    isLead: true, aiProvisioned: false, addedAt: now,
  })
  store.addMember({
    teamId: TEAM, appId: WORKER, memberName: 'worker', role: 'Worker',
    isLead: false, aiProvisioned: false, addedAt: now,
  })
}

describe('teamService.stopMember', () => {
  let dbManager: DatabaseManager
  beforeEach(() => {
    broadcastToAll.mockClear()
    sendToRenderer.mockClear()
  })
  afterEach(() => {
    dbManager?.closeAll()
  })

  it('stops the epoch it was given and reports that a turn was interrupted', async () => {
    const ctx = build(true)
    dbManager = ctx.dbManager
    seedTeam(ctx.store)

    const res = await ctx.service.stopMember({ teamId: TEAM, appId: WORKER, epochId: 'epoch-x' })

    expect(res).toEqual({ ok: true, stopped: true })
    expect(ctx.stops).toEqual([{ appId: WORKER, teamId: TEAM, epochId: 'epoch-x' }])
  })

  it('nothing running is reported as stopped:false, not as a failure', async () => {
    const ctx = build(false)
    dbManager = ctx.dbManager
    seedTeam(ctx.store)

    const res = await ctx.service.stopMember({ teamId: TEAM, appId: WORKER, epochId: 'epoch-x' })

    expect(res).toEqual({ ok: true, stopped: false })
  })

  it('refuses a stop that names no conversation, even with one running, and stops nothing', async () => {
    const ctx = build(true)
    dbManager = ctx.dbManager
    seedTeam(ctx.store)
    const now = Date.now()
    ctx.store.insertEpoch({
      id: 'run-1', teamId: TEAM, startedAt: now, endedAt: null, endReason: null,
      summary: null, lifecycle: 'run', lastActivityAt: now,
    })
    ctx.store.updateTeamCurrentEpoch(TEAM, 'run-1')

    await expect(ctx.service.stopMember({ teamId: TEAM, appId: WORKER, epochId: '' })).rejects.toThrow(/Name the conversation/)
    expect(ctx.stops).toHaveLength(0)
    expect(ctx.runtime.ensureConversationEpoch).not.toHaveBeenCalled()
  })

  it('still reaches a named conversation that has been sealed, where a turn can still be running', async () => {
    const ctx = build(true)
    dbManager = ctx.dbManager
    seedTeam(ctx.store)
    const now = Date.now()
    ctx.store.insertEpoch({
      id: 'run-1', teamId: TEAM, startedAt: now, endedAt: now + 1, endReason: 'completed',
      summary: null, lifecycle: 'run', lastActivityAt: now,
    })

    const res = await ctx.service.stopMember({ teamId: TEAM, appId: WORKER, epochId: 'run-1' })

    expect(res).toEqual({ ok: true, stopped: true })
    expect(ctx.stops).toEqual([{ appId: WORKER, teamId: TEAM, epochId: 'run-1' }])
  })

  it('refuses a member that is not on this team', async () => {
    const ctx = build(true)
    dbManager = ctx.dbManager
    seedTeam(ctx.store)

    const res = await ctx.service.stopMember({ teamId: TEAM, appId: 'stranger', epochId: 'epoch-x' })

    expect(res).toEqual({ ok: false, stopped: false, reason: 'MEMBER_NOT_FOUND' })
    expect(ctx.stops).toHaveLength(0)
  })
})
