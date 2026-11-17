import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../../src/main/http/websocket', () => ({ broadcastToAll: vi.fn() }))
vi.mock('../../../../../src/main/foundation/window.service', () => ({ sendToRenderer: vi.fn() }))

const { privateScopes } = vi.hoisted(() => ({ privateScopes: new Map<string, { team: { id: string }; epochId: string }>() }))
vi.mock('../../../../../src/main/apps/team', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../../src/main/apps/team')>(),
  getTeamService: () => ({ getCollaborationScope: (key: string) => privateScopes.get(key) ?? null }),
}))
vi.mock('../../../../../src/main/services/agent', () => ({ onAgentEvent: vi.fn(), evictIdleSession: vi.fn() }))
vi.mock('../../../../../src/main/services/space.service', () => ({ getSpaceDir: vi.fn() }))
vi.mock('../../../../../src/main/apps/manager', () => ({ getAppManager: vi.fn() }))
vi.mock('../../../../../src/main/apps/runtime/team/board-archive', () => ({
  createBoardArchive: () => ({ sweep: vi.fn(), clearEpoch: vi.fn() }),
}))

import { createTeamRuntime } from '../../../../../src/main/apps/runtime/team'
import { buildTeamSessionKey } from '../../../../../src/shared/apps/team-types'
import { createDatabaseManager } from '../../../../../src/main/platform/store/database-manager'
import { TeamStore } from '../../../../../src/main/apps/team/store'
import { MIGRATION_NAMESPACE, migrations } from '../../../../../src/main/apps/team/migrations'
import { createMessageBus } from '../../../../../src/main/apps/runtime/team/message-bus'
import { createOrchestration, type OrchestrationSessionDeps } from '../../../../../src/main/apps/runtime/team/orchestration'

describe('scoped pending collaboration work', () => {
  let database: ReturnType<typeof createDatabaseManager>
  let store: TeamStore

  beforeEach(() => {
    privateScopes.clear()
    database = createDatabaseManager(':memory:')
    const db = database.getAppDatabase()
    database.runMigrations(db, MIGRATION_NAMESPACE, migrations)
    store = new TeamStore(db)
    store.insertTeam({ id: 'team', name: 'Team', owningSpaceId: 'space', goal: '', leadAppId: 'lead',
      memberSourcing: 'manual', collabMode: 'free', escalationRouting: 'user', status: 'idle',
      currentEpochId: null, createdAt: 1, updatedAt: 1 })
    for (const appId of ['lead', 'first', 'second']) {
      store.addMember({ teamId: 'team', appId, memberName: appId, role: '', isLead: appId === 'lead', aiProvisioned: false, addedAt: 1 })
    }
  })

  afterEach(() => database.closeAll())

  function build() {
    const completions: Array<() => void> = []
    const session = {
      getMemberSpaceId: () => 'space',
      isSessionActive: () => false,
      sendAppChatMessage: () => new Promise<{ finalMessage: null }>(resolve => completions.push(() => resolve({ finalMessage: null }))),
    } as unknown as OrchestrationSessionDeps
    let pendingReport = false
    const changed = vi.fn()
    const bus = createMessageBus({ store, hooks: {
      wakeTarget: params => orchestration.wakeTarget(params),
      isBusy: key => orchestration.isBusy(key),
      deliverMidTurn: params => orchestration.deliverMidTurn(params),
    } })
    const orchestration = createOrchestration({ store, bus, session, maxConcurrentTurns: 1,
      hasPendingTurnReports: () => pendingReport, onWorkChanged: changed })
    return { bus, orchestration, completions, changed, setPendingReport: (value: boolean) => { pendingReport = value } }
  }

  it('retains the queued turn before the model starts and announces settlement', async () => {
    const { bus, orchestration, completions, changed } = build()
    const first = orchestration.ensureConversationEpoch('team', 'native:first')
    const second = orchestration.ensureConversationEpoch('team', 'native:second')
    await bus.send({ teamId: 'team', epochId: first.id, fromAppId: 'lead', to: 'first', message: 'Work' })
    await bus.send({ teamId: 'team', epochId: second.id, fromAppId: 'lead', to: 'second', message: 'Work' })
    expect(completions).toHaveLength(1)
    expect(orchestration.hasPendingWork('team', second.id)).toBe(true)
    completions[0]()
    await vi.waitFor(() => expect(completions).toHaveLength(2))
    completions[1]()
    await vi.waitFor(() => expect(orchestration.hasPendingWork('team', second.id)).toBe(false))
    expect(changed).toHaveBeenCalledWith('team', second.id)
  })

  function buildRuntime() {
    const active = new Set<string>()
    const runtime = createTeamRuntime({ store, teamFolderRoot: '/unused-team-work', session: {
      isSessionActive: (key: string) => active.has(key),
    } as OrchestrationSessionDeps })
    const addScope = (name: string) => ({ team: { id: 'team' }, epochId: runtime.ensureConversationEpoch('team', `native:${name}`).id })
    return { runtime, active, addScope }
  }

  it('keeps the parent alive while a private descendant is working', () => {
    const { runtime, active, addScope } = buildRuntime()
    const parent = addScope('parent')
    const child = addScope('private')
    const nested = addScope('nested-private')
    privateScopes.set(buildTeamSessionKey('first', 'team', parent.epochId), child)
    privateScopes.set(buildTeamSessionKey('second', 'team', child.epochId), nested)
    const nestedSession = buildTeamSessionKey('first', 'team', nested.epochId)
    expect(runtime.hasPendingWork('team', parent.epochId)).toBe(false)
    active.add(nestedSession)
    expect(runtime.hasPendingWork('team', parent.epochId)).toBe(true)
    active.delete(nestedSession)
    expect(runtime.hasPendingWork('team', parent.epochId)).toBe(false)
  })

  it('does not mistake more than 128 idle private scopes for active work', () => {
    const { runtime, addScope } = buildRuntime()
    const root = addScope('root')
    let parent = root
    for (let index = 0; index < 130; index++) {
      const child = addScope(`history-${index}`)
      privateScopes.set(buildTeamSessionKey('first', 'team', parent.epochId), child)
      parent = child
    }
    expect(runtime.hasPendingWork('team', root.epochId)).toBe(false)
  })

  it('terminates private-scope cycles without hiding active descendants', () => {
    const { runtime, active, addScope } = buildRuntime()
    const parent = addScope('cycle-parent')
    const child = addScope('cycle-child')
    privateScopes.set(buildTeamSessionKey('first', 'team', parent.epochId), child)
    privateScopes.set(buildTeamSessionKey('first', 'team', child.epochId), parent)
    expect(runtime.hasPendingWork('team', parent.epochId)).toBe(false)
    active.add(buildTeamSessionKey('second', 'team', child.epochId))
    expect(runtime.hasPendingWork('team', parent.epochId)).toBe(true)
  })

  it('keeps an idle scope alive for a report and announces its final settlement', () => {
    const { orchestration, setPendingReport, changed } = build()
    const epoch = orchestration.ensureConversationEpoch('team', 'native:report')
    expect(orchestration.hasPendingWork('team', epoch.id)).toBe(false)
    setPendingReport(true)
    expect(orchestration.hasPendingWork('team', epoch.id)).toBe(true)
    setPendingReport(false)
    orchestration.notePendingWorkChanged('team', epoch.id)
    expect(orchestration.hasPendingWork('team', epoch.id)).toBe(false)
    expect(changed).toHaveBeenCalledWith('team', epoch.id)
  })
})
