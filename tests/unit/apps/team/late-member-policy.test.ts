/**
 * What a member of yours holds for people on other computers when it joins a
 * team after the fact, and when a team counts as reaching another computer.
 *
 * The rules under test: a team no other computer can reach leaves a new member
 * unset (the first invite asks once for everyone, and unset grants a stranger
 * nothing); a team that does reach one — joined from elsewhere, holding a
 * teammate's member, or ever invited to, even by a link since revoked or
 * expired — gives a member added without a choice the read-only answer; a
 * choice made while adding is kept as made.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { broadcastToAll, sendToRenderer } = vi.hoisted(() => ({
  broadcastToAll: vi.fn(),
  sendToRenderer: vi.fn(),
}))
vi.mock('../../../../src/main/http/websocket', () => ({ broadcastToAll }))
vi.mock('../../../../src/main/foundation/window.service', () => ({ sendToRenderer }))

import { randomUUID } from 'crypto'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../src/main/platform/store/types'
import { TeamStore } from '../../../../src/main/apps/team/store'
import { MIGRATION_NAMESPACE, migrations } from '../../../../src/main/apps/team/migrations'
import { FederationStore } from '../../../../src/main/apps/federation/store'
import {
  MIGRATION_NAMESPACE as FEDERATION_NAMESPACE,
  migrations as federationMigrations,
} from '../../../../src/main/apps/federation/migrations'
import { createTeamService } from '../../../../src/main/apps/team/service'
import { capabilityPolicyFromPreset } from '../../../../src/shared/apps/capability-policy'
import type { CreateTeamInput, TeamEpoch } from '../../../../src/shared/apps/team-types'

const SPACE = 'space-a'

function makeAppManager() {
  const apps = new Map<string, { id: string; spaceId: string | null; spec: { name: string }; userOverrides: Record<string, unknown> }>()
  let counter = 0
  apps.set('existing-1', { id: 'existing-1', spaceId: SPACE, spec: { name: 'Researcher' }, userOverrides: {} })
  apps.set('existing-2', { id: 'existing-2', spaceId: SPACE, spec: { name: 'Tester' }, userOverrides: {} })
  return {
    apps,
    install: vi.fn(async (spaceId: string | null, spec: { name: string }) => {
      const id = `app-${++counter}`
      apps.set(id, { id, spaceId, spec: { ...spec }, userOverrides: {} })
      return id
    }),
    getApp: vi.fn((appId: string) => apps.get(appId) ?? null),
    updateOverrides: vi.fn((appId: string, overrides: Record<string, unknown>) => {
      Object.assign(apps.get(appId)!.userOverrides, overrides)
    }),
    uninstall: vi.fn(async () => {}),
    deleteApp: vi.fn(async (appId: string) => { apps.delete(appId) }),
  }
}

function makeRuntime(store: TeamStore) {
  const epoch = (teamId: string, lifecycle: TeamEpoch['lifecycle'], chatKey: string | null): TeamEpoch => ({
    id: randomUUID(), teamId, startedAt: Date.now(), endedAt: null, endReason: null, summary: null, lifecycle, chatKey,
  })
  return {
    bus: {} as never,
    blackboard: { readBoard: vi.fn(() => ({ tasks: [], findings: [], roster: [] })) },
    checks: { viewForTeam: () => [], cancelById: vi.fn() } as never,
    startEpoch: vi.fn(async (teamId: string) => epoch(teamId, 'run', null)),
    ensureConversationEpoch: vi.fn((teamId: string, chatKey: string) => {
      const existing = store.getOpenConversationEpoch(teamId, chatKey)
      if (existing) return existing
      const created = epoch(teamId, 'conversation', chatKey)
      store.insertEpoch(created, 'event')
      return created
    }),
    sealConversationEpoch: vi.fn(async (_teamId: string, epochId: string) => {
      store.endEpoch(epochId, Date.now(), 'completed', null, null)
    }),
    sealEpoch: vi.fn(async () => {}),
    getObservableStatus: vi.fn(() => 'idle'),
    getMemberStatus: vi.fn(() => 'idle' as const),
    getMemberBusy: vi.fn(() => []),
    teamFolders: { forMember: () => null, sharedDir: () => '', remove: vi.fn(async () => {}), prune: vi.fn(async () => {}) },
  }
}

function build() {
  const dbManager: DatabaseManager = createDatabaseManager(':memory:')
  const db = dbManager.getAppDatabase()
  dbManager.runMigrations(db, MIGRATION_NAMESPACE, migrations)
  dbManager.runMigrations(db, FEDERATION_NAMESPACE, federationMigrations)
  const store = new TeamStore(db)
  const federationStore = new FederationStore(db)
  const runtime = makeRuntime(store)
  const service = createTeamService({
    store,
    appManager: makeAppManager() as never,
    getRuntime: () => runtime as never,
    spaces: { spaceExists: () => true, createMemberSpace: ({ owningSpaceId }) => owningSpaceId },
    listArtifacts: vi.fn(async () => []),
    proposeMembersFromGoal: vi.fn(async () => []),
    // The same read the bootstrap wires.
    hasIssuedInvite: (teamId) => federationStore.hasCredentialForOffice(teamId),
  })
  return { service, store, federationStore, dbManager }
}

const manualTeam = (): CreateTeamInput => ({
  name: 'Delivery',
  goal: 'Ship it',
  owningSpaceId: SPACE,
  memberSourcing: 'manual',
  collabMode: 'free',
  escalationRouting: 'user',
  members: [{ appId: 'existing-1' }],
})

const READ_ONLY = capabilityPolicyFromPreset('read_only')

describe('what a member added later holds for other computers', () => {
  let ctx: ReturnType<typeof build>

  beforeEach(() => { ctx = build() })
  afterEach(() => { ctx.dbManager.closeAll() })

  const policyOf = (teamId: string, appId: string) =>
    ctx.store.listMembersByTeam(teamId).find(m => m.appId === appId)!.delegatedPolicy

  const invite = (officeId: string, extra: { revoked?: boolean; exp?: number | null } = {}) =>
    ctx.federationStore.insertCredential({
      jti: randomUUID(), officeId, identity: '', issuedAt: Date.now(),
      scope: { visibility: 'full', contactable: 'all', discoverable: true, canReinvite: true },
      exp: extra.exp ?? null, revoked: extra.revoked ?? false,
    })

  it('stays unset, and the team reads as private, while no other computer can reach it', async () => {
    const team = await ctx.service.createTeam(manualTeam())

    await ctx.service.addMember(team.id, { appId: 'existing-2' })

    expect(policyOf(team.id, 'existing-1')).toBeNull()
    expect(policyOf(team.id, 'existing-2')).toBeNull()
    expect(ctx.service.getTeamDetail(team.id)!.crossesMachines).toBe(false)
  })

  it('starts read-only in a team joined from another computer', async () => {
    ctx.store.insertTeam({
      id: 'office-joined', name: 'Their office', owningSpaceId: SPACE, goal: '', leadAppId: null,
      memberSourcing: 'manual', collabMode: 'free', escalationRouting: 'user',
      status: 'idle', currentEpochId: null, createdAt: 1, updatedAt: 1, hostNodeId: 'node-host',
    })

    expect(ctx.service.getTeamDetail('office-joined')!.crossesMachines).toBe(true)
    await ctx.service.addMember('office-joined', { appId: 'existing-2' })

    expect(policyOf('office-joined', 'existing-2')).toEqual(READ_ONLY)
  })

  it('starts read-only once a teammate on another computer is in the team', async () => {
    const team = await ctx.service.createTeam(manualTeam())
    ctx.store.addMember({
      teamId: team.id, appId: 'app-theirs', memberName: 'reviewer', role: '',
      isLead: false, aiProvisioned: false, addedAt: 2, ownerNodeId: 'node-b', origin: 'remote',
    })

    expect(ctx.service.getTeamDetail(team.id)!.crossesMachines).toBe(true)
    await ctx.service.addMember(team.id, { appId: 'existing-2' })

    expect(policyOf(team.id, 'existing-2')).toEqual(READ_ONLY)
  })

  it('starts read-only once an invite was created, even one since revoked', async () => {
    const team = await ctx.service.createTeam(manualTeam())
    invite(team.id, { revoked: true })

    expect(ctx.service.getTeamDetail(team.id)!.crossesMachines).toBe(true)
    await ctx.service.addMember(team.id, { appId: 'existing-2' })

    expect(policyOf(team.id, 'existing-2')).toEqual(READ_ONLY)
  })

  it('counts an expired invite too: the link may have been used before it lapsed', async () => {
    const team = await ctx.service.createTeam(manualTeam())
    invite(team.id, { exp: Date.now() - 60_000 })

    expect(ctx.service.getTeamDetail(team.id)!.crossesMachines).toBe(true)
  })

  it('is not moved by an invite to a different office', async () => {
    const team = await ctx.service.createTeam(manualTeam())
    invite('another-office')

    expect(ctx.service.getTeamDetail(team.id)!.crossesMachines).toBe(false)
    await ctx.service.addMember(team.id, { appId: 'existing-2' })
    expect(policyOf(team.id, 'existing-2')).toBeNull()
  })

  it('keeps the answer chosen while adding, and the one bit the office needs follows it', async () => {
    const team = await ctx.service.createTeam(manualTeam())
    invite(team.id)
    const chosen = { ...capabilityPolicyFromPreset('workspace'), allowChecks: false }

    const added = await ctx.service.addMember(team.id, { appId: 'existing-2', delegatedPolicy: chosen })

    expect(added.delegatedPolicy).toEqual(chosen)
    const stored = ctx.store.listMembersByTeam(team.id).find(m => m.appId === 'existing-2')!
    expect(stored.delegatedPolicy).toEqual(chosen)
    expect(stored.acceptsChecks).toBe(false)
  })

  it('gives a member of mine appearing in an office hosted elsewhere the read-only answer until the join screen writes its own', () => {
    const snapshot = (memberApps: string[]) => ({
      hostNodeId: 'node-host',
      selfNodeId: 'node-self',
      snapshot: {
        team: { id: 'office-joined', name: 'Their office', goal: '', leadAppId: null, collabMode: 'free' as const, hostNodeId: 'node-host' },
        members: [
          { appId: 'their-lead', memberName: 'lead', role: '', isLead: true, ownerNodeId: 'node-host', memberIdentity: 'id-host' },
          ...memberApps.map(appId => ({ appId, memberName: appId, role: '', isLead: false, ownerNodeId: 'node-self', memberIdentity: null })),
        ],
        edges: [],
      },
    })

    ctx.store.materializeJoinedOffice(snapshot(['existing-1']))
    expect(policyOf('office-joined', 'existing-1')).toEqual(READ_ONLY)
    expect(policyOf('office-joined', 'their-lead')).toBeNull()

    // The join screen's answer, then a later roster that also brings a second member.
    const chosen = capabilityPolicyFromPreset('full')
    ctx.service.updateMember('office-joined', 'existing-1', { delegatedPolicy: chosen })
    ctx.store.materializeJoinedOffice(snapshot(['existing-1', 'existing-2']))

    expect(policyOf('office-joined', 'existing-1')).toEqual(chosen)
    expect(policyOf('office-joined', 'existing-2')).toEqual(READ_ONLY)
  })

  it('holds a lead provisioned after a saved collaboration was shared like any late member', async () => {
    const before = await ctx.service.createCollab({
      owningSpaceId: SPACE, conversationId: 'conv-1', name: 'Crew', goal: 'Compare',
      modelSelection: { modelSourceId: 'source', modelId: 'model' },
      members: [{ memberName: 'researcher', role: 'Researcher', responsibility: 'Collect sources' }],
    })
    await ctx.service.completeCollab(before.team.id, 'done')
    ctx.store.clearEphemeral(before.team.id)
    invite(before.team.id)

    await ctx.service.runTeam(before.team.id)

    const leadAppId = ctx.service.getTeam(before.team.id)!.leadAppId!
    expect(policyOf(before.team.id, leadAppId)).toEqual(READ_ONLY)
    expect(ctx.store.getMember(before.team.id, leadAppId)?.acceptsChecks).toBe(true)
  })
})
