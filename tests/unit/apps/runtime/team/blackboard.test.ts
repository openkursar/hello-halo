/**
 * Unit tests for runtime/team blackboard facade
 *
 * Covers §6 scoped writes against a real in-memory TeamStore:
 *   - scoped task writes don't clobber each other
 *   - findings are append-only and ordered
 *   - each write emits team:blackboard on both transports
 *   - readBoard snapshot shape + filters + injected roster status
 *
 * The event emitters are mocked so emissions can be asserted without Electron.
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
import { createBlackboard } from '../../../../../src/main/apps/runtime/team/blackboard'
import type { Team, TeamMember, TeamEpoch } from '../../../../../src/main/apps/team/types'
import type { TeamMemberRuntimeStatus } from '../../../../../src/shared/apps/team-types'

const TEAM_ID = 'team-1'
const EPOCH_ID = 'epoch-1'
const LEAD_APP = 'app-lead'
const RESEARCHER_APP = 'app-researcher'
const TESTER_APP = 'app-tester'

function seed(store: TeamStore): void {
  const now = Date.now()
  const team: Team = {
    id: TEAM_ID,
    name: 'Research Team',
    owningSpaceId: 'space-a',
    goal: 'goal',
    leadAppId: LEAD_APP,
    memberSourcing: 'manual',
    collabMode: 'free',
    escalationRouting: 'user',
    status: 'running',
    currentEpochId: EPOCH_ID,
    createdAt: now,
    updatedAt: now,
  }
  store.insertTeam(team)
  const members: TeamMember[] = [
    { teamId: TEAM_ID, appId: LEAD_APP, memberName: 'lead', role: 'Lead', isLead: true, aiProvisioned: false, addedAt: now },
    { teamId: TEAM_ID, appId: RESEARCHER_APP, memberName: 'researcher', role: 'Research', isLead: false, aiProvisioned: false, addedAt: now },
    { teamId: TEAM_ID, appId: TESTER_APP, memberName: 'tester', role: 'QA', isLead: false, aiProvisioned: false, addedAt: now },
  ]
  for (const m of members) store.addMember(m)
  const epoch: TeamEpoch = { id: EPOCH_ID, teamId: TEAM_ID, startedAt: now, endedAt: null, endReason: null, summary: null, lifecycle: 'run' }
  store.insertEpoch(epoch)
}

describe('Blackboard', () => {
  let dbManager: DatabaseManager
  let store: TeamStore

  beforeEach(() => {
    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, MIGRATION_NAMESPACE, migrations)
    store = new TeamStore(db)
    seed(store)
    broadcastToAll.mockClear()
    sendToRenderer.mockClear()
  })

  afterEach(() => {
    dbManager.closeAll()
  })

  describe('tasks', () => {
    it('postTask persists a pending task and emits team:blackboard', () => {
      const board = createBlackboard({ store })
      const { taskId } = board.postTask({
        teamId: TEAM_ID,
        epochId: EPOCH_ID,
        callerAppId: LEAD_APP,
        title: 'Scrape competitors',
        assigneeAppId: RESEARCHER_APP,
      })

      const task = store.getTaskById(taskId)
      expect(task?.status).toBe('pending')
      expect(task?.assigneeAppId).toBe(RESEARCHER_APP)
      expect(task?.createdByAppId).toBe(LEAD_APP)

      expect(broadcastToAll).toHaveBeenCalledWith(
        'team:blackboard',
        expect.objectContaining({ kind: 'task', task: expect.objectContaining({ id: taskId }) })
      )
      expect(sendToRenderer).toHaveBeenCalledWith('team:blackboard', expect.objectContaining({ kind: 'task' }))
    })

    it('scoped updates do not clobber each other', () => {
      const board = createBlackboard({ store })
      const t1 = board.postTask({ teamId: TEAM_ID, epochId: EPOCH_ID, callerAppId: LEAD_APP, title: 'A', assigneeAppId: RESEARCHER_APP }).taskId
      const t2 = board.postTask({ teamId: TEAM_ID, epochId: EPOCH_ID, callerAppId: LEAD_APP, title: 'B', assigneeAppId: TESTER_APP }).taskId

      board.updateTask({ teamId: TEAM_ID, epochId: EPOCH_ID, taskId: t1, status: 'done', resultRef: 'a.md' })
      board.updateTask({ teamId: TEAM_ID, epochId: EPOCH_ID, taskId: t2, status: 'in_progress' })

      const task1 = store.getTaskById(t1)
      const task2 = store.getTaskById(t2)
      expect(task1?.status).toBe('done')
      expect(task1?.resultRef).toBe('a.md')
      expect(task2?.status).toBe('in_progress')
      expect(task2?.resultRef).toBeNull() // untouched
    })
  })

  describe('findings (append-only)', () => {
    it('appends findings in insertion order and emits each', () => {
      const board = createBlackboard({ store })
      const f1 = board.postFinding({ teamId: TEAM_ID, epochId: EPOCH_ID, callerAppId: RESEARCHER_APP, content: 'first' }).findingId
      const f2 = board.postFinding({ teamId: TEAM_ID, epochId: EPOCH_ID, callerAppId: TESTER_APP, ref: 'notes.md' }).findingId

      const findings = store.listFindingsByEpoch(TEAM_ID, EPOCH_ID)
      expect(findings.map((f) => f.id)).toEqual([f1, f2])
      expect(findings[0].body).toBe('first')
      expect(findings[1].ref).toBe('notes.md')

      const findingEmits = broadcastToAll.mock.calls.filter((c) => c[1]?.kind === 'finding')
      expect(findingEmits).toHaveLength(2)
    })
  })

  describe('readBoard', () => {
    it('returns the full snapshot shape with derived roster', () => {
      const board = createBlackboard({ store })
      board.postTask({ teamId: TEAM_ID, epochId: EPOCH_ID, callerAppId: LEAD_APP, title: 'A', assigneeAppId: RESEARCHER_APP })
      board.postFinding({ teamId: TEAM_ID, epochId: EPOCH_ID, callerAppId: RESEARCHER_APP, content: 'note' })

      const snapshot = board.readBoard(TEAM_ID, EPOCH_ID, LEAD_APP)
      expect(snapshot.tasks).toHaveLength(1)
      expect(snapshot.findings).toHaveLength(1)
      expect(snapshot.roster).toHaveLength(3)
      // Default roster status is idle when no provider is injected.
      expect(snapshot.roster.every((r) => r.status === 'idle')).toBe(true)
      expect(snapshot.roster.find((r) => r.isLead)?.memberName).toBe('lead')
    })

    it('mine filter scopes tasks to the caller', () => {
      const board = createBlackboard({ store })
      board.postTask({ teamId: TEAM_ID, epochId: EPOCH_ID, callerAppId: LEAD_APP, title: 'A', assigneeAppId: RESEARCHER_APP })
      board.postTask({ teamId: TEAM_ID, epochId: EPOCH_ID, callerAppId: LEAD_APP, title: 'B', assigneeAppId: TESTER_APP })

      const mine = board.readBoard(TEAM_ID, EPOCH_ID, RESEARCHER_APP, { mine: true })
      expect(mine.tasks).toHaveLength(1)
      expect(mine.tasks[0].title).toBe('A')
    })

    it('status filter scopes tasks by status', () => {
      const board = createBlackboard({ store })
      const t1 = board.postTask({ teamId: TEAM_ID, epochId: EPOCH_ID, callerAppId: LEAD_APP, title: 'A', assigneeAppId: RESEARCHER_APP }).taskId
      board.postTask({ teamId: TEAM_ID, epochId: EPOCH_ID, callerAppId: LEAD_APP, title: 'B', assigneeAppId: TESTER_APP })
      board.updateTask({ teamId: TEAM_ID, epochId: EPOCH_ID, taskId: t1, status: 'done' })

      const done = board.readBoard(TEAM_ID, EPOCH_ID, LEAD_APP, { status: 'done' })
      expect(done.tasks).toHaveLength(1)
      expect(done.tasks[0].id).toBe(t1)
    })

    it('injected getMemberStatus drives roster status + currentTaskTitle', () => {
      const status: Record<string, TeamMemberRuntimeStatus> = {
        [RESEARCHER_APP]: 'working',
        [TESTER_APP]: 'idle',
        [LEAD_APP]: 'idle',
      }
      const board = createBlackboard({ store, getMemberStatus: (appId) => status[appId] ?? 'idle' })
      const t1 = board.postTask({ teamId: TEAM_ID, epochId: EPOCH_ID, callerAppId: LEAD_APP, title: 'Active task', assigneeAppId: RESEARCHER_APP }).taskId
      board.updateTask({ teamId: TEAM_ID, epochId: EPOCH_ID, taskId: t1, status: 'in_progress' })

      const snapshot = board.readBoard(TEAM_ID, EPOCH_ID, LEAD_APP)
      const researcher = snapshot.roster.find((r) => r.appId === RESEARCHER_APP)
      expect(researcher?.status).toBe('working')
      expect(researcher?.currentTaskTitle).toBe('Active task')
    })
  })
})
