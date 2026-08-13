/**
 * Unit tests for apps/team (data layer)
 *
 * Covers the TeamStore CRUD surface for all six tables plus the migration run:
 * - table creation + migration application
 * - CRUD round-trips for every table
 * - UNIQUE constraints (team name per space, memberName per team)
 * - edge isAllowed permission check (structured mode)
 * - findings append-only ordering
 * - epoch start/end and current-epoch lookup
 *
 * Uses :memory: databases for speed and isolation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../src/main/platform/store/types'
import { TeamStore } from '../../../../src/main/apps/team/store'
import { MIGRATION_NAMESPACE, migrations } from '../../../../src/main/apps/team/migrations'
import type {
  Team,
  TeamMember,
  TeamEdge,
  BlackboardTask,
  BlackboardFinding,
  TeamEpoch,
} from '../../../../src/main/apps/team/types'

// ============================================
// Fixtures
// ============================================

const SPACE_A = 'space-a'
const SPACE_B = 'space-b'

function makeTeam(overrides?: Partial<Team>): Team {
  const now = Date.now()
  return {
    id: 'team-1',
    name: 'Research Team',
    owningSpaceId: SPACE_A,
    goal: 'Build a competitor brief',
    leadAppId: null,
    memberSourcing: 'manual',
    collabMode: 'structured',
    escalationRouting: 'user',
    status: 'idle',
    currentEpochId: null,
    createdAt: now,
    updatedAt: now,
    hostNodeId: null,
    ...overrides,
  }
}

function makeMember(overrides?: Partial<TeamMember>): TeamMember {
  return {
    teamId: 'team-1',
    appId: 'app-1',
    memberName: 'researcher',
    role: 'Research',
    isLead: false,
    aiProvisioned: false,
    addedAt: Date.now(),
    ...overrides,
  }
}

function makeEpoch(overrides?: Partial<TeamEpoch>): TeamEpoch {
  return {
    id: 'epoch-1',
    teamId: 'team-1',
    startedAt: Date.now(),
    endedAt: null,
    endReason: null,
    summary: null,
    lifecycle: 'run',
    chatKey: null,
    title: null,
    outcome: null,
    triggerType: 'manual',
    ...overrides,
  }
}

function makeTask(overrides?: Partial<BlackboardTask>): BlackboardTask {
  const now = Date.now()
  return {
    id: 'task-1',
    teamId: 'team-1',
    epochId: 'epoch-1',
    title: 'Scrape competitors',
    assigneeAppId: 'app-1',
    status: 'pending',
    resultRef: null,
    note: null,
    parentId: null,
    createdByAppId: 'lead-app',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function makeFinding(overrides?: Partial<BlackboardFinding>): BlackboardFinding {
  return {
    id: 'finding-1',
    teamId: 'team-1',
    epochId: 'epoch-1',
    authorAppId: 'app-1',
    body: 'Found three competitors',
    ref: null,
    createdAt: Date.now(),
    ...overrides,
  }
}

// ============================================
// Setup
// ============================================

describe('TeamStore', () => {
  let dbManager: DatabaseManager
  let store: TeamStore

  beforeEach(() => {
    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, MIGRATION_NAMESPACE, migrations)
    store = new TeamStore(db)
  })

  afterEach(() => {
    dbManager.closeAll()
  })

  // ===========================================================================
  // Migration / table creation
  // ===========================================================================

  describe('migrations', () => {
    it('uses the frozen app_team namespace', () => {
      expect(MIGRATION_NAMESPACE).toBe('app_team')
    })

    it('creates all six tables', () => {
      const db = dbManager.getAppDatabase()
      const rows = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .all() as { name: string }[]
      const names = rows.map(r => r.name)
      for (const t of [
        'teams',
        'team_members',
        'team_edges',
        'blackboard_tasks',
        'blackboard_findings',
        'team_epochs',
      ]) {
        expect(names).toContain(t)
      }
    })

    it('is idempotent when run twice', () => {
      const db = dbManager.getAppDatabase()
      expect(() => dbManager.runMigrations(db, MIGRATION_NAMESPACE, migrations)).not.toThrow()
    })
  })

  // ===========================================================================
  // teams
  // ===========================================================================

  describe('teams', () => {
    it('round-trips a team through insert/getById', () => {
      const team = makeTeam({ leadAppId: 'lead-1', currentEpochId: 'epoch-1' })
      store.insertTeam(team)
      expect(store.getTeamById(team.id)).toEqual(team)
    })

    it('returns null for a missing team', () => {
      expect(store.getTeamById('nope')).toBeNull()
    })

    it('lists teams and filters by space', () => {
      store.insertTeam(makeTeam({ id: 't1', name: 'A', owningSpaceId: SPACE_A }))
      store.insertTeam(makeTeam({ id: 't2', name: 'B', owningSpaceId: SPACE_B }))
      store.insertTeam(makeTeam({ id: 't3', name: 'C', owningSpaceId: SPACE_A }))

      expect(store.listTeams()).toHaveLength(3)
      const inA = store.listTeamsBySpace(SPACE_A).map(t => t.id).sort()
      expect(inA).toEqual(['t1', 't3'])
    })

    it('enforces unique team name per space, allows same name across spaces', () => {
      store.insertTeam(makeTeam({ id: 't1', name: 'Dup', owningSpaceId: SPACE_A }))
      expect(() =>
        store.insertTeam(makeTeam({ id: 't2', name: 'Dup', owningSpaceId: SPACE_A }))
      ).toThrow()
      // Same name in a different space is fine.
      expect(() =>
        store.insertTeam(makeTeam({ id: 't3', name: 'Dup', owningSpaceId: SPACE_B }))
      ).not.toThrow()
    })

    it('updates editable fields without touching others', () => {
      const team = makeTeam()
      store.insertTeam(team)
      store.updateTeamFields(team.id, {
        name: 'Renamed',
        goal: 'New goal',
        collabMode: 'free',
        escalationRouting: 'lead',
        memberSourcing: 'ai',
      })
      const updated = store.getTeamById(team.id)!
      expect(updated.name).toBe('Renamed')
      expect(updated.goal).toBe('New goal')
      expect(updated.collabMode).toBe('free')
      expect(updated.escalationRouting).toBe('lead')
      expect(updated.memberSourcing).toBe('ai')
      expect(updated.owningSpaceId).toBe(team.owningSpaceId)
    })

    it('updates status, lead app id, and current epoch independently', () => {
      const team = makeTeam()
      store.insertTeam(team)

      store.updateTeamStatus(team.id, 'running')
      expect(store.getTeamById(team.id)!.status).toBe('running')

      store.updateTeamLeadAppId(team.id, 'lead-app')
      expect(store.getTeamById(team.id)!.leadAppId).toBe('lead-app')

      store.updateTeamCurrentEpoch(team.id, 'epoch-9')
      expect(store.getTeamById(team.id)!.currentEpochId).toBe('epoch-9')

      store.updateTeamCurrentEpoch(team.id, null)
      expect(store.getTeamById(team.id)!.currentEpochId).toBeNull()
    })

    it('deletes a team', () => {
      const team = makeTeam()
      store.insertTeam(team)
      expect(store.deleteTeam(team.id)).toBe(true)
      expect(store.getTeamById(team.id)).toBeNull()
      expect(store.deleteTeam(team.id)).toBe(false)
    })
  })

  // ===========================================================================
  // team_members
  // ===========================================================================

  describe('team_members', () => {
    beforeEach(() => {
      store.insertTeam(makeTeam())
    })

    it('round-trips members including isLead and aiProvisioned flags', () => {
      const lead = makeMember({ appId: 'lead-app', memberName: 'lead', isLead: true, aiProvisioned: true })
      const member = makeMember({ appId: 'app-2', memberName: 'tester', role: 'QA' })
      store.addMember(lead)
      store.addMember(member)

      const members = store.listMembersByTeam('team-1')
      expect(members).toHaveLength(2)
      const back = members.find(m => m.appId === 'lead-app')!
      expect(back.isLead).toBe(true)
      expect(back.aiProvisioned).toBe(true)
      expect(members.find(m => m.appId === 'app-2')!.role).toBe('QA')
    })

    it('looks up a member by team-unique name', () => {
      store.addMember(makeMember({ appId: 'app-2', memberName: 'tester' }))
      expect(store.getMemberByName('team-1', 'tester')!.appId).toBe('app-2')
      expect(store.getMemberByName('team-1', 'ghost')).toBeNull()
    })

    it('enforces unique memberName per team', () => {
      store.addMember(makeMember({ appId: 'app-1', memberName: 'dev' }))
      expect(() =>
        store.addMember(makeMember({ appId: 'app-2', memberName: 'dev' }))
      ).toThrow()
    })

    it('enforces composite primary key (team_id, app_id)', () => {
      store.addMember(makeMember({ appId: 'app-1', memberName: 'a' }))
      expect(() =>
        store.addMember(makeMember({ appId: 'app-1', memberName: 'b' }))
      ).toThrow()
    })

    it('finds memberships across teams for cross-team lookup', () => {
      store.insertTeam(makeTeam({ id: 'team-2', name: 'Other', owningSpaceId: SPACE_A }))
      store.addMember(makeMember({ teamId: 'team-1', appId: 'shared', memberName: 'x' }))
      store.addMember(makeMember({ teamId: 'team-2', appId: 'shared', memberName: 'y' }))

      const memberships = store.listMembersByAppId('shared')
      expect(memberships.map(m => m.teamId).sort()).toEqual(['team-1', 'team-2'])
    })

    it('removes a member', () => {
      store.addMember(makeMember({ appId: 'app-1', memberName: 'dev' }))
      expect(store.removeMember('team-1', 'app-1')).toBe(true)
      expect(store.listMembersByTeam('team-1')).toHaveLength(0)
      expect(store.removeMember('team-1', 'app-1')).toBe(false)
    })
  })

  // ===========================================================================
  // team_edges
  // ===========================================================================

  describe('team_edges', () => {
    beforeEach(() => {
      store.insertTeam(makeTeam())
    })

    it('replaces the full adjacency set for a team', () => {
      const edges: TeamEdge[] = [
        { teamId: 'team-1', fromAppId: 'lead', toAppId: 'a', sync: true },
        { teamId: 'team-1', fromAppId: 'lead', toAppId: 'b', sync: false },
      ]
      store.replaceEdgesForTeam('team-1', edges)
      expect(store.listEdgesByTeam('team-1')).toHaveLength(2)

      // Replacing wipes the previous set.
      store.replaceEdgesForTeam('team-1', [
        { teamId: 'team-1', fromAppId: 'a', toAppId: 'lead', sync: false },
      ])
      const after = store.listEdgesByTeam('team-1')
      expect(after).toHaveLength(1)
      expect(after[0].fromAppId).toBe('a')
    })

    it('preserves the sync flag round-trip', () => {
      store.replaceEdgesForTeam('team-1', [
        { teamId: 'team-1', fromAppId: 'lead', toAppId: 'a', sync: true },
      ])
      expect(store.listEdgesByTeam('team-1')[0].sync).toBe(true)
    })

    it('isEdgeAllowed reflects directed permission', () => {
      store.replaceEdgesForTeam('team-1', [
        { teamId: 'team-1', fromAppId: 'lead', toAppId: 'a', sync: true },
      ])
      expect(store.isEdgeAllowed('team-1', 'lead', 'a')).toBe(true)
      // Direction matters: the reverse edge was not declared.
      expect(store.isEdgeAllowed('team-1', 'a', 'lead')).toBe(false)
      expect(store.isEdgeAllowed('team-1', 'lead', 'unknown')).toBe(false)
    })
  })

  // ===========================================================================
  // blackboard_tasks
  // ===========================================================================

  describe('blackboard_tasks', () => {
    it('round-trips a task through insert/getById', () => {
      const task = makeTask()
      store.insertTask(task)
      expect(store.getTaskById(task.id)).toEqual(task)
    })

    it('patches only the supplied fields and bumps updatedAt', () => {
      const task = makeTask({ updatedAt: 1000 })
      store.insertTask(task)
      store.updateTask(task.id, { status: 'done', resultRef: 'competitors.md', note: 'verified' }, 2000)

      const updated = store.getTaskById(task.id)!
      expect(updated.status).toBe('done')
      expect(updated.resultRef).toBe('competitors.md')
      expect(updated.note).toBe('verified')
      expect(updated.updatedAt).toBe(2000)
      expect(updated.title).toBe(task.title)
    })

    it('supports reassignment and null clearing via patch', () => {
      const task = makeTask({ assigneeAppId: 'app-1' })
      store.insertTask(task)
      store.updateTask(task.id, { assigneeAppId: 'app-2' }, 2000)
      expect(store.getTaskById(task.id)!.assigneeAppId).toBe('app-2')
      store.updateTask(task.id, { assigneeAppId: null }, 3000)
      expect(store.getTaskById(task.id)!.assigneeAppId).toBeNull()
    })

    it('lists tasks scoped by epoch and by team', () => {
      store.insertTask(makeTask({ id: 't1', epochId: 'e1' }))
      store.insertTask(makeTask({ id: 't2', epochId: 'e1' }))
      store.insertTask(makeTask({ id: 't3', epochId: 'e2' }))

      expect(store.listTasksByEpoch('team-1', 'e1').map(t => t.id).sort()).toEqual(['t1', 't2'])
      expect(store.listTasksByTeam('team-1')).toHaveLength(3)
    })

    it('getLatestBoardEpochId returns the epoch of the most recent task/finding (BUG 3)', () => {
      // A JOINED shadow office binds its activity feed to this when the run-epoch
      // pointer has not yet materialized from a roster snapshot, so the feed
      // populates straight from replicated data.
      expect(store.getLatestBoardEpochId('team-1')).toBeNull()

      store.insertTask(makeTask({ id: 't-old', epochId: 'e-old', updatedAt: 1000 }))
      store.insertTask(makeTask({ id: 't-new', epochId: 'e-new', updatedAt: 5000 }))
      expect(store.getLatestBoardEpochId('team-1')).toBe('e-new')

      // A newer finding in a different epoch wins over the latest task.
      store.insertFinding(makeFinding({ id: 'f-newest', epochId: 'e-newest', createdAt: 9000 }))
      expect(store.getLatestBoardEpochId('team-1')).toBe('e-newest')
    })
  })

  // ===========================================================================
  // blackboard_findings
  // ===========================================================================

  describe('blackboard_findings', () => {
    it('round-trips a finding', () => {
      const finding = makeFinding({ ref: 'notes.md' })
      store.insertFinding(finding)
      const list = store.listFindingsByEpoch('team-1', 'epoch-1')
      expect(list).toHaveLength(1)
      expect(list[0]).toEqual(finding)
    })

    it('is append-only and preserves insertion order even with equal timestamps', () => {
      const ts = 5000
      store.insertFinding(makeFinding({ id: 'f1', body: 'first', createdAt: ts }))
      store.insertFinding(makeFinding({ id: 'f2', body: 'second', createdAt: ts }))
      store.insertFinding(makeFinding({ id: 'f3', body: 'third', createdAt: ts }))

      const ids = store.listFindingsByEpoch('team-1', 'epoch-1').map(f => f.id)
      expect(ids).toEqual(['f1', 'f2', 'f3'])
    })

    it('scopes findings by epoch', () => {
      store.insertFinding(makeFinding({ id: 'f1', epochId: 'e1' }))
      store.insertFinding(makeFinding({ id: 'f2', epochId: 'e2' }))
      expect(store.listFindingsByEpoch('team-1', 'e1').map(f => f.id)).toEqual(['f1'])
    })
  })

  // ===========================================================================
  // team_epochs
  // ===========================================================================

  describe('team_epochs', () => {
    it('round-trips an epoch and ends it', () => {
      const epoch = makeEpoch()
      store.insertEpoch(epoch)
      // An epoch no turn has entered yet is exactly as recent as its start.
      expect(store.getEpochById(epoch.id)).toEqual({ ...epoch, lastActivityAt: epoch.startedAt })

      store.endEpoch(epoch.id, 9999, 'completed', 'All tasks done')
      const ended = store.getEpochById(epoch.id)!
      expect(ended.endedAt).toBe(9999)
      expect(ended.endReason).toBe('completed')
      expect(ended.summary).toBe('All tasks done')
      // Sealing is itself a movement, but activity only ever goes forward: this
      // epoch's synthetic end stamp predates its start, so the start stands.
      expect(ended.lastActivityAt).toBe(epoch.startedAt)

      const later = makeEpoch({ id: 'epoch-2', startedAt: 1000 })
      store.insertEpoch(later)
      store.endEpoch(later.id, 4000, 'completed', null)
      expect(store.getEpochById(later.id)!.lastActivityAt).toBe(4000)
    })

    it('touchEpoch stamps activity forward only', () => {
      const epoch = makeEpoch({ startedAt: 5000 })
      store.insertEpoch(epoch)

      store.touchEpoch(epoch.id, 7000)
      expect(store.getEpochById(epoch.id)!.lastActivityAt).toBe(7000)

      // A late/replicated stamp from earlier must not make the epoch look older.
      store.touchEpoch(epoch.id, 6000)
      expect(store.getEpochById(epoch.id)!.lastActivityAt).toBe(7000)
    })

    it('returns the open epoch as current and null after it is sealed', () => {
      store.insertEpoch(makeEpoch({ id: 'e-old', startedAt: 1000, endedAt: 1500, endReason: 'completed' }))
      store.insertEpoch(makeEpoch({ id: 'e-now', startedAt: 2000 }))

      expect(store.getCurrentEpochForTeam('team-1')!.id).toBe('e-now')

      store.endEpoch('e-now', 2500, 'stopped', null)
      expect(store.getCurrentEpochForTeam('team-1')).toBeNull()
    })

    it('lists epochs for a team newest-first', () => {
      store.insertEpoch(makeEpoch({ id: 'e1', startedAt: 1000 }))
      store.insertEpoch(makeEpoch({ id: 'e2', startedAt: 2000 }))
      expect(store.listEpochsByTeam('team-1').map(e => e.id)).toEqual(['e2', 'e1'])
    })
  })
})
