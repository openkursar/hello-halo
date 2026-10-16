import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDatabaseManager } from '../../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../../src/main/platform/store/types'
import { TeamStore } from '../../../../../src/main/apps/team/store'
import { migrations as teamMigrations, MIGRATION_NAMESPACE as TEAM_NS } from '../../../../../src/main/apps/team/migrations'
import { FederationStore } from '../../../../../src/main/apps/federation/store'
import { migrations as federationMigrations, MIGRATION_NAMESPACE as FED_NS } from '../../../../../src/main/apps/federation/migrations'
import { DEFAULT_OFFICE_SCOPE } from '../../../../../src/main/apps/federation/types'
import { createFederationManager } from '../../../../../src/main/apps/runtime/federation/manager'
import { createFederationCoordinator } from '../../../../../src/main/apps/runtime/federation/coordinator'
import { LanMeshLink } from '../../../../../src/main/apps/runtime/federation/lan-mesh-provider'
import { buildTeamSessionKey, SELF_NODE_ID } from '../../../../../src/shared/apps/team-types'
import { FEDERATION_PROTOCOL_VERSION } from '../../../../../src/shared/federation/protocol-version'
import type { FederationMessage, SerializedWakeRequest, WakeFrame } from '../../../../../src/main/apps/runtime/federation/types'

const OFFICE = 'office'
const HOST = 'authority'
const CALLER = 'caller-node'
const OWNER = 'owner-node'
const EPOCH = 'epoch'
const CALLER_APP = 'caller-app'
const TARGET = 'target-app'
const shutdown: Array<() => void> = []
const databases: DatabaseManager[] = []

function stores(self: string) {
  const db = createDatabaseManager(':memory:')
  databases.push(db)
  db.runMigrations(db.getAppDatabase(), TEAM_NS, teamMigrations)
  db.runMigrations(db.getAppDatabase(), FED_NS, federationMigrations)
  const team = new TeamStore(db.getAppDatabase())
  team.insertTeam({ id: OFFICE, name: 'Scope test', owningSpaceId: 'space', goal: 'Test', leadAppId: CALLER_APP,
    memberSourcing: 'manual', collabMode: 'free', escalationRouting: 'user', status: 'idle', currentEpochId: null,
    createdAt: Date.now(), updatedAt: Date.now(), ...(self !== HOST ? { hostNodeId: HOST } : {}) })
  for (const [appId, owner] of [[CALLER_APP, CALLER], [TARGET, OWNER]]) team.addMember({ teamId: OFFICE, appId,
    memberName: appId, role: 'Member', isLead: appId === CALLER_APP, aiProvisioned: false, addedAt: Date.now(),
    ownerNodeId: owner === self ? SELF_NODE_ID : owner, origin: owner === self ? 'local' : 'remote' })
  team.insertEpoch({ id: EPOCH, teamId: OFFICE, startedAt: Date.now(), endedAt: null,
    endReason: null, summary: null, lifecycle: 'conversation' })
  return { team, federation: new FederationStore(db.getAppDatabase()) }
}

function harness() {
  const hostStores = stores(HOST)
  const ownerStores = stores(OWNER)
  const callerReplies: FederationMessage[] = []
  const forwarded: WakeFrame[] = []
  const ownerRun = vi.fn(async (_request: SerializedWakeRequest) => ({ finalMessage: 'verified result' }))
  const hostRun = vi.fn(async (_request: SerializedWakeRequest) => ({ finalMessage: 'wrong local dispatch' }))
  const ownerLink = new LanMeshLink((_to, frame) => host.handleHostInbound({ clientId: OWNER, officeId: OFFICE, frame }))
  const owner = createFederationCoordinator({ context: { officeId: OFFICE, selfNodeId: OWNER },
    link: ownerLink, federationStore: ownerStores.federation, teamStore: ownerStores.team,
    verifyCredential: () => null, getWakeAuthority: () => HOST, onWake: ownerRun })
  owner.start()
  const host = createFederationManager({
    federationStore: hostStores.federation, teamStore: hostStores.team, getLocalNodeId: () => HOST,
    getSessionIdentity: client => client,
    hostListOfficeClients: () => [CALLER, OWNER],
    verifyCredential: () => ({ officeId: OFFICE, scope: DEFAULT_OFFICE_SCOPE }),
    runLocalTurn: hostRun,
    hostSend: (client, frame) => {
      if (client === OWNER) {
        if (frame.kind === 'wake') forwarded.push(frame)
        ownerLink.deliver(HOST, frame)
      } else if (client === CALLER) callerReplies.push(frame)
      return true
    },
  })
  host.hostOffice(OFFICE)
  for (const [node, appId] of [[CALLER, CALLER_APP], [OWNER, TARGET]]) host.handleHostInbound({ clientId: node, officeId: OFFICE,
    frame: { kind: 'join-request', officeId: OFFICE, fromNode: node, identityId: node, displayName: node,
      credentialToken: 'test-token', bringMembers: [{ appId, memberName: appId, role: 'Member' }], pv: FEDERATION_PROTOCOL_VERSION } })
  shutdown.push(() => { host.stopAll(); owner.stop() })
  const request = (): WakeFrame => ({ kind: 'wake', officeId: OFFICE, fromNode: CALLER, correlationId: 'public-correlation',
    request: { appId: TARGET, spaceId: 'peer-claimed-space', message: 'Review',
      conversationId: buildTeamSessionKey(TARGET, OFFICE, EPOCH),
      teamContext: { teamId: OFFICE, epochId: EPOCH, correlationId: 'public-correlation', fromAppId: CALLER_APP, wait: true, kind: 'message' } } })
  return { host, hostStores, ownerStores, ownerRun, hostRun, callerReplies, forwarded, request,
    send: (frame: WakeFrame) => host.handleHostInbound({ clientId: CALLER, officeId: OFFICE, frame }) }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { for (const close of shutdown.splice(0)) close(); for (const db of databases.splice(0)) db.closeAll(); vi.useRealTimers() })

describe('owner and authority wake boundary', () => {
  it('forwards a legitimate member request once and returns the original receipt through the authority', async () => {
    const h = harness()
    h.send(h.request())
    await vi.advanceTimersByTimeAsync(0)
    expect(h.hostRun).not.toHaveBeenCalled()
    expect(h.ownerRun).toHaveBeenCalledTimes(1)
    expect(h.forwarded).toHaveLength(1)
    expect(h.forwarded[0].correlationId).not.toBe('public-correlation')
    expect(h.forwarded[0].request.teamContext.correlationId).toBe(h.forwarded[0].correlationId)
    expect(h.callerReplies).toContainEqual(expect.objectContaining({ kind: 'turn-complete', correlationId: 'public-correlation',
      outcome: { kind: 'result', content: 'verified result' } }))
  })

  it('refuses a private default-chat key before local execution or cross-node forwarding', () => {
    const h = harness()
    const frame = h.request()
    frame.request.conversationId = `app-chat:${TARGET}`
    h.send(frame)
    expect(h.hostRun).not.toHaveBeenCalled()
    expect(h.ownerRun).not.toHaveBeenCalled()
    expect(h.forwarded).toEqual([])
    expect(h.callerReplies).toContainEqual(expect.objectContaining({ outcome: { kind: 'undelivered', reason: 'session-key-mismatch' } }))
  })

  it('refuses another office policy selected inside an authenticated office envelope', () => {
    const h = harness()
    const frame = h.request()
    frame.request.teamContext.teamId = 'different-office'
    frame.request.conversationId = buildTeamSessionKey(TARGET, 'different-office', EPOCH)
    h.send(frame)
    expect(h.forwarded).toEqual([])
    expect(h.ownerRun).not.toHaveBeenCalled()
    expect(h.callerReplies).toContainEqual(expect.objectContaining({ outcome: { kind: 'undelivered', reason: 'office-mismatch' } }))
  })

  it('does not let a readonly invited node evade its scope by omitting the sender member', () => {
    const h = harness()
    h.hostStores.team.setMemberScope(OFFICE, CALLER_APP, JSON.stringify({ ...DEFAULT_OFFICE_SCOPE, visibility: 'readonly' }))
    const frame = h.request()
    frame.request.teamContext.fromAppId = null
    h.send(frame)
    expect(h.ownerRun).not.toHaveBeenCalled()
    expect(h.forwarded).toEqual([])
    expect(h.callerReplies).toContainEqual(expect.objectContaining({ outcome: { kind: 'undelivered', reason: 'scope-denied' } }))
  })

  it('retains a forwarded wake until the owner receives the epoch mirror', async () => {
    const h = harness()
    const epoch = h.ownerStores.team.getEpochById(EPOCH)!
    vi.spyOn(h.ownerStores.team, 'getEpochById').mockReturnValueOnce(null)
    h.send(h.request())
    expect(h.ownerRun).not.toHaveBeenCalled()
    expect(h.forwarded).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(250)
    expect(h.ownerRun).toHaveBeenCalledTimes(1)
    expect(h.ownerStores.team.getEpochById(EPOCH)).toEqual(epoch)
    expect(h.callerReplies).toContainEqual(expect.objectContaining({ correlationId: 'public-correlation', outcome: { kind: 'result', content: 'verified result' } }))
  })
})
