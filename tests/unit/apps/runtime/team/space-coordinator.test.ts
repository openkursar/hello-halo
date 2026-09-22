/**
 * Unit tests for the space-coordinator delivery path:
 *   - the bus routes a send addressed to the coordinator sentinel through
 *     `deliverToCoordinator`, bypassing the member turn gate entirely (no slot,
 *     no completion, so nothing can wedge on a completion that never comes)
 *   - a receipted send to the coordinator settles on hand-over
 *   - `createCoordinatorDelivery` frames a member's message, passes system
 *     notices verbatim, and drops deliveries for a closed collaboration
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { broadcastToAll, sendToRenderer } = vi.hoisted(() => ({
  broadcastToAll: vi.fn(),
  sendToRenderer: vi.fn(),
}))
vi.mock('../../../../../src/main/http/websocket', () => ({ broadcastToAll }))
vi.mock('../../../../../src/main/foundation/window.service', () => ({ sendToRenderer }))

import { createDatabaseManager } from '../../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../../src/main/platform/store/types'
import { TeamStore } from '../../../../../src/main/apps/team/store'
import { MIGRATION_NAMESPACE, migrations } from '../../../../../src/main/apps/team/migrations'
import { createMessageBus } from '../../../../../src/main/apps/runtime/team/message-bus'
import type { TeamDeliveryHooks } from '../../../../../src/main/apps/runtime/team/message-bus'
import { createCoordinatorDelivery } from '../../../../../src/main/apps/runtime/team/space-coordinator'
import type { CoordinatorDeliveryRequest } from '../../../../../src/main/apps/runtime/team/space-coordinator'
import { spaceCoordinatorAppId, SPACE_COORDINATOR_MEMBER_NAME, spaceCollabChatKey } from '../../../../../src/shared/apps/team-types'
import type { Team, TeamEpoch, TeamMember } from '../../../../../src/main/apps/team/types'

const TEAM_ID = 'team-1'
const EPOCH_ID = 'epoch-1'
const CONVERSATION = 'conv-1'
const COORD_APP = spaceCoordinatorAppId(CONVERSATION)
const RESEARCHER_APP = 'app-researcher'

function seedCollab(store: TeamStore): void {
  const now = Date.now()
  const team: Team = {
    id: TEAM_ID,
    name: 'Research crew',
    owningSpaceId: 'space-a',
    goal: 'Compare competitors',
    leadAppId: COORD_APP,
    memberSourcing: 'ai',
    collabMode: 'free',
    escalationRouting: 'user',
    status: 'idle',
    currentEpochId: null,
    createdAt: now,
    updatedAt: now,
    ephemeral: true,
    coordinatorConversationId: CONVERSATION,
  }
  store.insertTeam(team)
  const members: TeamMember[] = [
    { teamId: TEAM_ID, appId: COORD_APP, memberName: SPACE_COORDINATOR_MEMBER_NAME, role: 'Coordinator', isLead: true, aiProvisioned: false, addedAt: now },
    { teamId: TEAM_ID, appId: RESEARCHER_APP, memberName: 'researcher', role: 'Research', isLead: false, aiProvisioned: true, addedAt: now },
  ]
  for (const m of members) store.addMember(m)
  const epoch: TeamEpoch = {
    id: EPOCH_ID,
    teamId: TEAM_ID,
    startedAt: now,
    endedAt: null,
    endReason: null,
    summary: null,
    lifecycle: 'conversation',
    chatKey: spaceCollabChatKey(CONVERSATION),
  }
  store.insertEpoch(epoch, 'event')
}

let dbManager: DatabaseManager
let store: TeamStore

beforeEach(() => {
  dbManager = createDatabaseManager(':memory:')
  const db = dbManager.getAppDatabase()
  dbManager.runMigrations(db, MIGRATION_NAMESPACE, migrations)
  store = new TeamStore(db)
  seedCollab(store)
})

afterEach(() => {
  dbManager.closeAll()
})

describe('bus routing to a space coordinator', () => {
  function makeBus() {
    const coordinatorDeliveries: Array<{ envelope: any; trigger: any }> = []
    const hooks: TeamDeliveryHooks = {
      wakeTarget: vi.fn(async () => {}),
      isBusy: vi.fn(() => false),
      deliverToCoordinator: vi.fn(async (params) => {
        coordinatorDeliveries.push(params)
      }),
    }
    const bus = createMessageBus({ store, hooks })
    return { bus, hooks, coordinatorDeliveries }
  }

  it("a member's send to the coordinator bypasses the turn gate", async () => {
    const { bus, hooks, coordinatorDeliveries } = makeBus()

    const result = await bus.send({
      teamId: TEAM_ID,
      epochId: EPOCH_ID,
      fromAppId: RESEARCHER_APP,
      to: SPACE_COORDINATOR_MEMBER_NAME,
      message: 'Sources collected, brief at report.md',
    })

    expect('messageId' in result).toBe(true)
    expect(coordinatorDeliveries).toHaveLength(1)
    expect(coordinatorDeliveries[0].envelope.toAppId).toBe(COORD_APP)
    expect(hooks.wakeTarget).not.toHaveBeenCalled()
    // Nothing holds a slot for the coordinator: no completion will ever come.
    expect(bus.isSessionOccupied(`app-chat:${COORD_APP}:team:${TEAM_ID}:${EPOCH_ID}`)).toBe(false)
  })

  it('a receipted send to the coordinator settles on hand-over instead of waiting', async () => {
    const { bus } = makeBus()
    const result = await bus.send({
      teamId: TEAM_ID,
      epochId: EPOCH_ID,
      fromAppId: null,
      to: SPACE_COORDINATOR_MEMBER_NAME,
      message: 'hello',
      wait: true,
    })
    expect('status' in result && result.status).toBe('ok')
  })

  it('fails loudly when no coordinator delivery is wired', async () => {
    const hooks: TeamDeliveryHooks = {
      wakeTarget: vi.fn(async () => {}),
      isBusy: vi.fn(() => false),
    }
    const bus = createMessageBus({ store, hooks })
    await expect(
      bus.send({
        teamId: TEAM_ID,
        epochId: EPOCH_ID,
        fromAppId: RESEARCHER_APP,
        to: SPACE_COORDINATOR_MEMBER_NAME,
        message: 'x',
      })
    ).rejects.toThrow(/not reachable/)
  })
})

describe('createCoordinatorDelivery', () => {
  function makeDelivery() {
    const delivered: CoordinatorDeliveryRequest[] = []
    const deliver = vi.fn(async (request: CoordinatorDeliveryRequest) => {
      delivered.push(request)
    })
    return { delivered, hook: createCoordinatorDelivery({ store, deliver }) }
  }

  const envelope = (body: string) => ({
    id: 'msg-1',
    teamId: TEAM_ID,
    epochId: EPOCH_ID,
    fromAppId: RESEARCHER_APP,
    toAppId: COORD_APP,
    body,
    correlationId: 'corr-1',
    createdAt: Date.now(),
  })

  it("frames a member's message and persists the raw body with provenance", async () => {
    const { delivered, hook } = makeDelivery()

    await hook({
      envelope: envelope('Brief is ready at report.md'),
      trigger: { teamId: TEAM_ID, epochId: EPOCH_ID, correlationId: 'corr-1', fromAppId: RESEARCHER_APP, wait: false, kind: 'message' },
    })

    expect(delivered).toHaveLength(1)
    const request = delivered[0]
    expect(request.spaceId).toBe('space-a')
    expect(request.conversationId).toBe(CONVERSATION)
    expect(request.turnInput).toContain('Team message from researcher')
    expect(request.turnInput).toContain('Brief is ready at report.md')
    expect(request.persist.content).toBe('Brief is ready at report.md')
    expect(request.persist.metadata.fromMemberName).toBe('researcher')
    expect(request.persist.metadata.teamName).toBe('Research crew')
  })

  it('passes a system turn-end report verbatim', async () => {
    const { delivered, hook } = makeDelivery()
    const body = '[System] Collaboration turn-end report.\n- researcher — stopped with no error reported.'

    await hook({
      envelope: { ...envelope(body), fromAppId: COORD_APP },
      trigger: { teamId: TEAM_ID, epochId: EPOCH_ID, correlationId: 'corr-2', fromAppId: null, wait: false, kind: 'member_stopped' },
    })

    expect(delivered[0].turnInput).toBe(body)
    expect(delivered[0].persist.metadata.fromMemberName).toBeNull()
  })

  it('drops a delivery for a sealed collaboration instead of throwing', async () => {
    store.endEpoch(EPOCH_ID, Date.now(), 'completed', null, null)
    const { delivered, hook } = makeDelivery()

    await hook({
      envelope: envelope('late message'),
      trigger: { teamId: TEAM_ID, epochId: EPOCH_ID, correlationId: 'corr-3', fromAppId: RESEARCHER_APP, wait: false, kind: 'message' },
    })

    expect(delivered).toHaveLength(0)
  })
})
