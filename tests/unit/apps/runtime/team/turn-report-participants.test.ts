import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMessageBus } from '@hello-halo/agent-sdk/collaboration'
import { createDatabaseManager } from '../../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../../src/main/platform/store/types'
import { TeamStore } from '../../../../../src/main/apps/team/store'
import { MIGRATION_NAMESPACE, migrations } from '../../../../../src/main/apps/team/migrations'
import { createWorkMembership } from '../../../../../src/main/apps/runtime/team/membership'
import { createCoordinatorDelivery, type CoordinatorDeliveryRequest } from '../../../../../src/main/apps/runtime/team/space-coordinator'
import { createTurnReport, type TurnReport } from '../../../../../src/main/apps/runtime/team/turn-report'
import { buildTeamSessionKey, spaceCoordinatorAppId, type TeamParticipant } from '../../../../../src/shared/apps/team-types'

const TEAM = 'team', WORK = 'work', OTHER = 'other-work'
const LEAD = spaceCoordinatorAppId('source-conversation')
let database: DatabaseManager
let store: TeamStore
let report: TurnReport
let bus: ReturnType<typeof createMessageBus>
let delivered: CoordinatorDeliveryRequest[]
beforeEach(() => {
  database = createDatabaseManager(':memory:')
  database.runMigrations(database.getAppDatabase(), MIGRATION_NAMESPACE, migrations)
  store = new TeamStore(database.getAppDatabase())
  store.insertTeam({ id: TEAM, name: 'Review', owningSpaceId: 'space', goal: '', leadAppId: LEAD,
    memberSourcing: 'manual', collabMode: 'free', escalationRouting: 'user', status: 'idle', currentEpochId: null,
    ephemeral: true, coordinatorConversationId: 'source-conversation', createdAt: 1, updatedAt: 1 })
  for (const id of [WORK, OTHER]) store.insertEpoch({ id, teamId: TEAM, startedAt: 1, endedAt: null, endReason: null, summary: null, lifecycle: 'conversation' })
  store.addMember({ teamId: TEAM, appId: LEAD, memberName: 'coordinator', role: '', isLead: true, isSystemCoordinator: true, aiProvisioned: false, addedAt: 1 })
  delivered = []
  bus = createMessageBus({ store: createWorkMembership(store), hooks: {
    isBusy: () => false, wakeTarget: async () => { throw new Error('A source report must use the coordinator delivery path') },
    deliverToCoordinator: createCoordinatorDelivery({ store, deliver: async request => { delivered.push(request); return 'dispatched' } }),
  } })
  report = createTurnReport({ store, bus, requestAllowed: id => !store.requests.cancelled(id) })
})
afterEach(() => { for (const epoch of [WORK, OTHER]) { report.clearEpoch(epoch); bus.resetEpoch(epoch) }; database.closeAll() })

function participant(appId: string, parentAppId = LEAD, overrides: Partial<TeamParticipant> = {}) {
  const member: TeamParticipant = { appId, parentAppId, teamId: TEAM, epochId: WORK, memberName: `name-${appId}`, role: 'Reviewer',
    isTemporary: true, isLead: false, aiProvisioned: false, addedAt: 1, ...overrides }
  store.participants.insert(member)
  return member
}
function finish(member: TeamParticipant, overrides: Partial<Parameters<TurnReport['noteTurnEnded']>[0]> = {}) {
  report.noteTurnEnded({ teamId: TEAM, epochId: WORK, appId: member.appId, triggerKind: 'message', requestFromAppId: member.parentAppId,
    requestId: `request/${member.appId}`, correlationId: `turn-${member.appId}`, fate: { kind: 'ended' },
    requestSummary: `Review requested from ${member.memberName}`, finalReply: `REVIEW_DONE_${member.appId}`, ...overrides })
}

describe('temporary participant lifecycle reports', () => {
  it.each(['free', 'structured'] as const)('automatically returns parent and nested final replies through the source bus in %s collaboration', async collabMode => {
    store.updateTeamFields(TEAM, { collabMode })
    const parent = participant('parent'), nested = participant('nested', parent.appId)
    expect(store.getMember(TEAM, parent.appId)).toBeNull()
    for (const member of [parent, nested]) report.noteTurnStarted({ teamId: TEAM, epochId: WORK, appId: member.appId })
    report.noteAct({ teamId: TEAM, epochId: WORK, kind: 'message', actorAppId: parent.appId, targetAppId: nested.appId, subject: 'Review independently' })
    finish(parent); finish(nested)
    await vi.waitFor(() => expect(delivered).toHaveLength(2))
    const text = delivered.map(request => request.turnInput).join('\n')
    expect(text).toContain('REVIEW_DONE_parent')
    expect(text).toContain('REVIEW_DONE_nested')
    expect(text).toContain('name-parent')
    expect(text).toContain('messaged name-nested')
    expect(delivered.every(request => request.conversationId === 'source-conversation')).toBe(true)
    expect(store.getEpochById(WORK)?.endedAt).toBeNull()
    expect(store.listMembersByTeam(TEAM)).toHaveLength(1)
  })

  it('routes an internal assistant ending to the creating member rather than the public lead', async () => {
    const parentKey = buildTeamSessionKey('creating-member', 'public-team', 'public-work')
    store.setCoordinatorConversation(TEAM, parentKey)
    finish(participant('internal'), { requestId: 'root/member/private/internal' })
    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    expect(delivered[0]).toMatchObject({ conversationId: parentKey,
      parentTeam: { appId: 'creating-member', teamId: 'public-team', epochId: 'public-work' },
      persist: { metadata: { requestId: 'root/member/private/internal' } } })
    expect(delivered[0].turnInput).toContain('REVIEW_DONE_internal')
  })

  it('keeps human conversations and another work context out of automatic reports', async () => {
    const member = participant('worker')
    finish(member, { triggerKind: 'human_message', finalReply: 'PRIVATE_HUMAN_RESULT' })
    finish(member, { epochId: OTHER, correlationId: 'foreign-turn', finalReply: 'FOREIGN_WORK_RESULT' })
    await Promise.resolve()
    expect(delivered).toEqual([])
  })

  it('reports an isolated branch ending without exposing its request, result or task details', async () => {
    store.updateTeamFields(TEAM, { collabMode: 'structured' })
    store.addMember({ teamId: TEAM, appId: 'isolated', memberName: 'Isolated', role: '', isLead: false, aiProvisioned: false, addedAt: 1 })
    const member = participant('worker', 'isolated')
    finish(member, { requestSummary: 'PRIVATE_REQUEST', finalReply: 'PRIVATE_RESULT', fate: { kind: 'error', message: 'PRIVATE_ERROR' } })
    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    expect(delivered[0].turnInput).toContain('name-worker')
    expect(delivered[0].turnInput).toContain('stopped with an error')
    expect(delivered[0].turnInput).not.toContain('PRIVATE_')
  })

  it('preserves the guest report standing and suppresses only a cancelled sibling branch', async () => {
    const cancelled = participant('cancelled'), guest = participant('guest')
    store.requests.cancel('request/cancelled')
    finish(cancelled); finish(guest, { origin: 'guest' })
    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    expect(delivered[0]).toMatchObject({ permissionIdentity: 'external', persist: { metadata: { requestId: 'request/guest' } } })
    expect(delivered[0].turnInput).toContain('REVIEW_DONE_guest')
    expect(delivered[0].turnInput).not.toContain('REVIEW_DONE_cancelled')
  })

  it('does not claim to have witnessed a remote temporary member finishing', async () => {
    const remote = participant('remote', LEAD, { origin: 'remote', ownerNodeId: 'remote-owner' })
    finish(remote)
    await Promise.resolve()
    expect(delivered).toEqual([])
  })
})
