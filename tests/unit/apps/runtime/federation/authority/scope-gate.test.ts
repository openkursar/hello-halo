/**
 * Unit tests for authority/scope-gate -- permission-overlay enforcement.
 *
 * Backed by a real in-memory TeamStore (:memory: better-sqlite3 + migrations) so
 * the gate reads genuine persisted scope_json, proving the decision is taken on
 * the authority side from stored scope, not the UI.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabaseManager } from '../../../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../../../src/main/platform/store/types'
import { TeamStore } from '../../../../../../src/main/apps/team/store'
import {
  MIGRATION_NAMESPACE as TEAM_NS,
  migrations as teamMigrations,
} from '../../../../../../src/main/apps/team/migrations'
import { createScopeGate, parseOfficeScope } from '../../../../../../src/main/apps/runtime/federation/authority/scope-gate'
import { DEFAULT_OFFICE_SCOPE, type OfficeScope } from '../../../../../../src/main/apps/federation/types'
import type { Team, TeamMember, BlackboardSnapshot } from '../../../../../../src/shared/apps/team-types'

const TEAM_ID = 'office-1'
const SPACE = 'space-1'
const LEAD = 'app-lead'
const FULL = 'app-full'
const ASSIGNED = 'app-assigned'
const READONLY = 'app-readonly'
const HIDDEN = 'app-hidden'

function team(): Team {
  return {
    id: TEAM_ID,
    name: 'Office',
    owningSpaceId: SPACE,
    goal: 'g',
    leadAppId: LEAD,
    memberSourcing: 'manual',
    collabMode: 'structured',
    escalationRouting: 'user',
    status: 'idle',
    currentEpochId: null,
    createdAt: 1,
    updatedAt: 1,
  }
}

function member(appId: string, scope: OfficeScope | null): TeamMember {
  return {
    teamId: TEAM_ID,
    appId,
    memberName: appId,
    role: 'r',
    isLead: appId === LEAD,
    aiProvisioned: false,
    addedAt: 1,
    scopeJson: scope ? JSON.stringify(scope) : null,
  }
}

describe('authority/scope-gate', () => {
  let dbManager: DatabaseManager
  let store: TeamStore
  let gate: ReturnType<typeof createScopeGate>

  beforeEach(() => {
    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, TEAM_NS, teamMigrations)
    store = new TeamStore(db)
    store.insertTeam(team())
    store.addMember(member(LEAD, null))
    store.addMember(member(FULL, { ...DEFAULT_OFFICE_SCOPE }))
    store.addMember(member(ASSIGNED, { ...DEFAULT_OFFICE_SCOPE, visibility: 'assigned' }))
    store.addMember(member(READONLY, { ...DEFAULT_OFFICE_SCOPE, visibility: 'readonly' }))
    store.addMember(
      member(HIDDEN, { ...DEFAULT_OFFICE_SCOPE, contactable: 'lead-only', discoverable: false, canReinvite: false }),
    )
    gate = createScopeGate({ store })
  })

  afterEach(() => dbManager.closeAll())

  describe('parseScope', () => {
    it('null scope_json → default-open', () => {
      expect(parseOfficeScope(null)).toEqual(DEFAULT_OFFICE_SCOPE)
    })
    it('malformed scope_json → default-open', () => {
      expect(parseOfficeScope('{not json')).toEqual(DEFAULT_OFFICE_SCOPE)
    })
    it('partial scope_json fills defaults', () => {
      expect(parseOfficeScope('{"visibility":"readonly"}')).toEqual({
        ...DEFAULT_OFFICE_SCOPE,
        visibility: 'readonly',
      })
    })
    it('reads a member row through the store', () => {
      const m = store.listMembersByTeam(TEAM_ID).find((x) => x.appId === READONLY)!
      expect(gate.parseScope(m).visibility).toBe('readonly')
    })
  })

  describe('canContact', () => {
    it('allows contacting an all-contactable target', () => {
      expect(gate.canContact(TEAM_ID, FULL, ASSIGNED)).toBe(true)
    })
    it('denies a non-lead contacting a lead-only target (negative)', () => {
      expect(gate.canContact(TEAM_ID, FULL, HIDDEN)).toBe(false)
    })
    it('allows the lead to contact a lead-only target (positive)', () => {
      expect(gate.canContact(TEAM_ID, LEAD, HIDDEN)).toBe(true)
    })
  })

  describe('canBeAssigned / canCoordinationWrite', () => {
    it('allows assignment + coord-write for a full member (positive)', () => {
      expect(gate.canBeAssigned(TEAM_ID, FULL)).toBe(true)
      expect(gate.canCoordinationWrite(TEAM_ID, FULL)).toBe(true)
    })
    it('denies assignment + coord-write for a read-only spectator (negative)', () => {
      expect(gate.canBeAssigned(TEAM_ID, READONLY)).toBe(false)
      expect(gate.canCoordinationWrite(TEAM_ID, READONLY)).toBe(false)
    })
    it('assigned-visibility member can still be assigned', () => {
      expect(gate.canBeAssigned(TEAM_ID, ASSIGNED)).toBe(true)
    })
    it('fail-closed: coord-write for an unknown appId is denied (F1)', () => {
      expect(gate.canCoordinationWrite(TEAM_ID, 'app-not-a-member')).toBe(false)
    })
    it('fail-closed: coord-write for an empty appId is denied (F1)', () => {
      expect(gate.canCoordinationWrite(TEAM_ID, '')).toBe(false)
    })
  })

  describe('filterBoard', () => {
    const snapshot = (): BlackboardSnapshot => ({
      tasks: [
        { id: 't-full', teamId: TEAM_ID, epochId: 'e', title: 'a', assigneeAppId: FULL, status: 'pending', resultRef: null, note: null, parentId: null, createdByAppId: LEAD, createdAt: 1, updatedAt: 1 },
        { id: 't-assigned', teamId: TEAM_ID, epochId: 'e', title: 'b', assigneeAppId: ASSIGNED, status: 'pending', resultRef: null, note: null, parentId: null, createdByAppId: LEAD, createdAt: 1, updatedAt: 1 },
      ],
      findings: [
        { id: 'f-lead', teamId: TEAM_ID, epochId: 'e', authorAppId: LEAD, body: 'x', ref: null, createdAt: 1 },
        { id: 'f-hidden', teamId: TEAM_ID, epochId: 'e', authorAppId: HIDDEN, body: 'y', ref: null, createdAt: 1 },
      ],
      roster: [],
      checks: [],
      activities: [
        { id: 'a-lead', teamId: TEAM_ID, epochId: 'e', kind: 'message', actorAppId: LEAD, targetAppId: FULL, subject: 'go', body: null, refId: null, correlationId: 'c1', status: 'sent', createdAt: 1 },
        { id: 'a-hidden', teamId: TEAM_ID, epochId: 'e', kind: 'finding', actorAppId: HIDDEN, targetAppId: null, subject: 'y', body: null, refId: 'f-hidden', correlationId: null, status: null, createdAt: 1 },
      ],
    })

    it('full visibility sees every task + finding (positive)', () => {
      const out = gate.filterBoard(TEAM_ID, FULL, snapshot())
      expect(out.tasks).toHaveLength(2)
      expect(out.findings).toHaveLength(2)
      expect(out.activities).toHaveLength(2)
    })
    it('assigned visibility sees only its own tasks (negative on others)', () => {
      const out = gate.filterBoard(TEAM_ID, ASSIGNED, snapshot())
      expect(out.tasks.map((t) => t.id)).toEqual(['t-assigned'])
    })
    it('readonly keeps tasks visible (read-only is a write concern, not a read redaction)', () => {
      const out = gate.filterBoard(TEAM_ID, READONLY, snapshot())
      expect(out.tasks).toHaveLength(2)
    })
    it('discoverable=false hides others’ findings, keeps own (negative)', () => {
      const out = gate.filterBoard(TEAM_ID, HIDDEN, snapshot())
      expect(out.findings.map((f) => f.id)).toEqual(['f-hidden'])
    })
    it('discoverable=false hides acts it was not party to (negative)', () => {
      const out = gate.filterBoard(TEAM_ID, HIDDEN, snapshot())
      expect(out.activities.map((a) => a.id)).toEqual(['a-hidden'])
    })
  })

  describe('canReinvite', () => {
    it('default-open member may re-invite (positive)', () => {
      expect(gate.canReinvite(TEAM_ID, FULL)).toBe(true)
    })
    it('canReinvite=false member may not (negative)', () => {
      expect(gate.canReinvite(TEAM_ID, HIDDEN)).toBe(false)
    })
  })
})
